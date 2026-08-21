/**
 * src/index.ts — cron dispatch + HTTP routes.
 *
 * The fetch handler is why this runs on Cloudflare Workers rather than GitHub
 * Actions: LinkedIn's OAuth redirect needs a public URL to land on, and so
 * does the Telegram webhook.
 *
 * CRON BUDGET: the free plan caps Cron Triggers at 5 per account — see
 * docs/02 and docs/07. Adding Bluesky/Threads/Mastodon the naive way (a
 * generate + publish cron each) would need 6 more slots, impossible on the
 * free plan. Instead: one generate cron handles every enabled TEXT_PLATFORM
 * from a single seed (src/multiplatform-generate.ts), Instagram keeps its
 * own generate cron (a structurally different pipeline, not just a length
 * limit), and publishDueAll checks every enabled platform's approved queue
 * — called from both publish windows so nothing waits a full day for its
 * matching window. Still exactly 5 crons, regardless of how many platforms
 * ENABLED_PLATFORMS turns on.
 */

import { MongoStore, type Store, type Platform } from './store';
import { generateTextPlatforms } from './multiplatform-generate';
import { generateInstagramDraft } from './instagram-generate';
import { publishLinkedIn, startLinkedInAuth, handleLinkedInCallback } from './linkedin';
import { publishInstagram, refreshInstagramToken, startInstagramAuth, handleInstagramCallback, debugWhoAmI } from './instagram';
import { publishBluesky } from './bluesky';
import { publishMastodon } from './mastodon';
import { publishThreads, refreshThreadsToken, startThreadsAuth, handleThreadsCallback } from './threads';
import { notify, notifyPublished, notifyAmbiguousFailure, handleTelegramWebhook } from './telegram';
import { AmbiguousPublishError } from './errors';
import { enabledPlatforms } from './platforms';
import { renderRssFeed } from './rss';

export interface Env {
  AI: Ai;

  // No R2 binding — image storage is Cloudinary (src/cloudinary-storage.ts).
  // R2 requires a Cloudflare billing profile (a card on file) to activate
  // at all, and turns out, once traced through every code path, to have no
  // remaining necessary role once the shared image + carousel slides +
  // style_refs (which just point at a previous draft's image) all live on
  // Cloudinary instead. No card anywhere in this stack for any of it.
  CLOUDINARY_CLOUD_NAME: string; // not sensitive — it's part of every delivery URL anyway

  LINKEDIN_VERSION: string;
  LINKEDIN_REDIRECT_URI: string;
  INSTAGRAM_REDIRECT_URI: string;
  THREADS_REDIRECT_URI: string;
  IMAGE_MODEL: string;
  TEXT_MODEL: string;
  IMAGE_PROVIDER: string; // "workers-ai" (default) | "pollinations" | "gemini" — see src/image-providers.ts
  ENABLED_PLATFORMS: string; // comma-separated, default "linkedin,instagram" — see src/platforms.ts
  MONGODB_DB: string;
  MASTODON_INSTANCE_URL: string; // e.g. https://mastodon.social — Mastodon is federated, no single API host
  MASTODON_MAX_CHARS: string; // optional, numeric string; defaults to 500 in src/mastodon.ts if unset
  ALERT_EMAIL_TO: string; // optional — destination for the email fallback, see src/email.ts

  MONGODB_URI: string;
  TOKEN_KEY: string;
  LINKEDIN_CLIENT_ID: string;
  LINKEDIN_CLIENT_SECRET: string;
  INSTAGRAM_CLIENT_ID: string;
  INSTAGRAM_CLIENT_SECRET: string;
  THREADS_CLIENT_ID: string;
  THREADS_CLIENT_SECRET: string;
  BLUESKY_HANDLE: string;
  BLUESKY_APP_PASSWORD: string;
  MASTODON_ACCESS_TOKEN: string;
  CLOUDINARY_API_KEY: string;
  CLOUDINARY_API_SECRET: string;
  GEMINI_API_KEY: string; // optional — only required when IMAGE_PROVIDER=gemini
  GMAIL_USER: string; // optional — email fallback, no-ops if unset (src/email.ts)
  GMAIL_APP_PASSWORD: string; // optional
  GITHUB_PAT: string; // read-only is fine — only used for search rate limits (src/research.ts)
  TAVILY_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  WEBHOOK_SECRET: string;
}

export const storeFor = (env: Env): Store =>
  new MongoStore(env.MONGODB_URI, env.MONGODB_DB, env.TOKEN_KEY);

// Plain `!==` on a secret leaks timing information (how many leading bytes
// matched) to anyone who can measure response latency at scale. Cheap to
// avoid: compare every byte regardless of where the first mismatch is,
// rather than short-circuiting on the first different one.
function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export type Stage = 'generate' | 'instagram' | 'publish' | 'health';

// Manual pipeline trigger — same effect as waiting for that stage's real
// cron, just started on demand instead of on the clock. Shared by the
// /run/<stage>/<secret> HTTP routes AND the Telegram command center
// (src/telegram.ts's /generate, /instagram, /publish, /health), so both
// surfaces get identical behaviour AND the same rate limit for free — a
// leaked WEBHOOK_SECRET or an over-eager finger on either interface can't
// spam real LLM/image-gen calls or real publishes.
const STAGE_COOLDOWN_MS: Record<Stage, number> = {
  generate: 5 * 60_000,
  instagram: 5 * 60_000,
  publish: 2 * 60_000,
  health: 60_000,
};

export async function runStage(env: Env, store: Store, ctx: ExecutionContext, stage: Stage): Promise<string> {
  const allowed = await store.claimRateLimit(`run:${stage}`, STAGE_COOLDOWN_MS[stage]);
  if (!allowed) {
    return `⏳ "${stage}" was triggered too recently — wait a bit before retrying (cooldown: ${STAGE_COOLDOWN_MS[stage] / 1000}s).`;
  }

  ctx.waitUntil((async () => {
    try {
      switch (stage) {
        case 'generate':  await generateTextPlatforms(env, store, ctx); break;
        case 'instagram': await generateInstagramDraft(env, store, ctx); break;
        case 'publish':   await publishDueAll(env, store, ctx); break;
        case 'health':    await health(env, store); break;
      }
    } catch (err: any) {
      await notify(env, `🔴 Stage "${stage}" failed: ${err?.message ?? err}`).catch(() => {});
    }
  })());

  return `⏳ Stage "${stage}" started in background — results will be sent to Telegram.`;
}

export default {
  /**
   * Cron Triggers DO NOT RETRY. A thrown exception means the run is silently
   * skipped until the next tick and Cloudflare tells you nothing. Everything
   * below is wrapped so that a failure always reaches your phone.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      const store = storeFor(env);
      try {
        switch (event.cron) {
          case '0 2 * * *':  await generateTextPlatforms(env, store, ctx); break;
          case '0 4 * * *':  await publishDueAll(env, store, ctx); break;
          case '0 6 * * *':  await generateInstagramDraft(env, store, ctx); break;
          case '0 9 * * *':  await publishDueAll(env, store, ctx); break;
          case '0 22 * * *': await health(env, store); break;
        }
      } catch (err: any) {
        await notify(env, `🔴 cron \`${event.cron}\` failed\n\n${err?.message ?? err}`);
      } finally {
        await store.close();
      }
    })());
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/auth/linkedin') return startLinkedInAuth(env);
      if (url.pathname === '/auth/linkedin/callback') return await handleLinkedInCallback(request, env);
      if (url.pathname === '/auth/instagram') return startInstagramAuth(env);
      if (url.pathname === '/auth/instagram/callback') return await handleInstagramCallback(request, env);
      if (url.pathname === '/auth/threads') return startThreadsAuth(env);
      if (url.pathname === '/auth/threads/callback') return await handleThreadsCallback(request, env);

      // Public, read-only, no auth — meant to be subscribed to. See src/rss.ts.
      if (url.pathname === '/feed.xml') return await renderRssFeed(env);

      // The unguessable path segment is the shared secret with Telegram.
      if (url.pathname.startsWith('/tg/') && request.method === 'POST') {
        const secret = url.pathname.slice('/tg/'.length);
        if (!timingSafeEqual(secret, env.WEBHOOK_SECRET)) return new Response('not found', { status: 404 });
        return await handleTelegramWebhook(request, env, ctx);
      }

      // Manual pipeline trigger — same effect as waiting for that stage's
      // real cron, just started on demand (testing, or catching up after a
      // gap) instead of on the clock. Same "unguessable path segment as
      // shared secret" pattern as the Telegram webhook above, reusing
      // WEBHOOK_SECRET rather than adding a new one, and rate-limited via
      // runStage() — see its comment. Runs synchronously so the HTTP
      // response only returns once the stage has actually finished (and,
      // for generate stages, after the Telegram approval message has been
      // sent) — this is a debug/ops tool, not a hot path, favour a response
      // you can trust over a fast one.
      if (url.pathname.startsWith('/run/status/') && request.method === 'GET') {
        const secret = url.pathname.split('/')[3] ?? '';
        if (!timingSafeEqual(secret, env.WEBHOOK_SECRET)) return new Response('not found', { status: 404 });
        const store = storeFor(env);
        try {
          const [drafts, last, seeds] = await Promise.all([
            store.listActive(10), store.lastRun(), store.seedCount(),
          ]);
          return new Response(JSON.stringify({ drafts, last_run: last, seeds_in_queue: seeds }, null, 2), {
            headers: { 'Content-Type': 'application/json' },
          });
        } finally {
          await store.close();
        }
      }

      // Recovery for exactly the stuck-draft bug fixed above (retry not
      // resetting attempts) — resets a specific draft back to a clean,
      // pickup-eligible 'approved' state. Draft id, not a stage name.
      const requeueMatch = url.pathname.match(/^\/run\/requeue\/([^/]+)\/([^/]+)$/);
      if (requeueMatch && request.method === 'GET') {
        const [, draftId, secret] = requeueMatch;
        if (!timingSafeEqual(secret, env.WEBHOOK_SECRET)) return new Response('not found', { status: 404 });
        const store = storeFor(env);
        try {
          await store.setStatus(draftId, 'approved', { attempts: 0, last_error: null });
          return new Response(`ok — ${draftId} requeued with attempts reset`);
        } finally {
          await store.close();
        }
      }

      // Isolates whether TEXT_MODEL itself is broken (returns nothing for
      // even a trivial prompt) vs. something specific to the carousel's
      // longer system prompt — see the "raw length 0" mystery this is
      // chasing down.
      if (url.pathname.startsWith('/run/test-llm/') && request.method === 'GET') {
        const secret = url.pathname.split('/')[3] ?? '';
        if (!timingSafeEqual(secret, env.WEBHOOK_SECRET)) return new Response('not found', { status: 404 });
        const trivial: any = await env.AI.run(env.TEXT_MODEL as any, {
          messages: [{ role: 'user', content: 'Say hello in exactly 3 words.' }],
          max_tokens: 200,
        });
        return new Response(JSON.stringify({ text_model: env.TEXT_MODEL, trivial_call_raw: trivial }, null, 2), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname.startsWith('/run/whoami/') && request.method === 'GET') {
        const secret = url.pathname.split('/')[3] ?? '';
        if (!timingSafeEqual(secret, env.WEBHOOK_SECRET)) return new Response('not found', { status: 404 });
        const store = storeFor(env);
        try {
          const result = await debugWhoAmI(env, store);
          return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
        } finally {
          await store.close();
        }
      }

      const runMatch = url.pathname.match(/^\/run\/(generate|instagram|publish|health)\/([^/]+)$/);
      if (runMatch && request.method === 'GET') {
        const [, stage, secret] = runMatch;
        if (!timingSafeEqual(secret, env.WEBHOOK_SECRET)) return new Response('not found', { status: 404 });

        const store = storeFor(env);
        try {
          const result = await runStage(env, store, ctx, stage as Stage);
          return new Response(result);
        } finally {
          await store.close();
        }
      }

      return new Response('not found', { status: 404 });
    } catch (err: any) {
      // scheduled() has this exact wrapper for crons; fetch() routes are just
      // as capable of failing silently otherwise — the Telegram webhook IS
      // the monitoring channel, so a bug in it deserves an alert too, not a
      // bare 500 nobody sees.
      await notify(env, `🔴 HTTP \`${url.pathname}\` failed\n\n${err?.message ?? err}`).catch(() => {});
      return new Response('internal error', { status: 500 });
    }
  },
};

const PUBLISHERS: Record<Platform, (env: Env, store: Store, draft: any) => Promise<string>> = {
  linkedin: publishLinkedIn,
  instagram: publishInstagram,
  bluesky: publishBluesky,
  threads: publishThreads,
  mastodon: publishMastodon,
};

async function publishDueAll(env: Env, store: Store, ctx: ExecutionContext) {
  for (const platform of enabledPlatforms(env)) {
    await publishDue(env, store, ctx, platform);
  }
}

async function publishDue(env: Env, store: Store, ctx: ExecutionContext, platform: Platform) {
  for (const draft of await store.dueFor(platform, 2)) {
    try {
      // Increment BEFORE the network call. A publish that times out but
      // actually succeeded must not be retried into a duplicate post.
      await store.setStatus(draft._id, 'approved', { attempts: draft.attempts + 1 });

      const remoteId = await PUBLISHERS[platform](env, store, draft);

      await store.setStatus(draft._id, 'published', {
        remote_id: remoteId,
        published_at: new Date(),
      });

      ctx.waitUntil(store.recordPost({
        draft_id: draft._id, platform, remote_id: remoteId,
        published_at: new Date(), body: draft.body,
        image_key: draft.image_key, image_prompt: draft.image_prompt,
        seed: draft.seed, facts: draft.facts,
        editor_flags: draft.editor_flags, metrics: {},
      }));

      await notifyPublished(env, {
        platform, remoteId, draftId: draft._id,
        offerStyleRef: platform === 'linkedin',
      });
    } catch (err: any) {
      const attempts = draft.attempts + 1;

      if (err instanceof AmbiguousPublishError) {
        // The network call itself failed before any response came back —
        // we genuinely don't know if the platform already created the post.
        // Auto-retrying here is exactly how a duplicate happens (see
        // src/errors.ts). Stop and make a human check first, rather than
        // silently re-queuing for the next publish cron.
        await store.setStatus(draft._id, 'failed', { attempts, last_error: String(err.message) });
        await notifyAmbiguousFailure(env, { platform, draftId: draft._id, message: String(err.message) });
        continue;
      }

      await store.setStatus(draft._id, attempts >= 3 ? 'failed' : 'approved', {
        attempts, last_error: String(err?.message ?? err),
      });
      await notify(env, `⚠️ ${platform} publish failed (${attempts}/3)\n\n${err?.message ?? err}`);
    }
  }
}

async function health(env: Env, store: Store) {
  const enabled = enabledPlatforms(env);

  // Instagram + Threads: fully automatic. Refresh nightly and
  // unconditionally — there is no penalty for refreshing early, and the
  // failure mode of NOT refreshing is a full manual re-authorisation.
  if (enabled.has('instagram')) {
    try {
      await refreshInstagramToken(env, store);
    } catch (err: any) {
      await notify(env, `⚠️ IG token refresh failed: ${err?.message ?? err}`);
    }
  }
  if (enabled.has('threads')) {
    try {
      await refreshThreadsToken(env, store);
    } catch (err: any) {
      await notify(env, `⚠️ Threads token refresh failed: ${err?.message ?? err}`);
    }
  }

  // LinkedIn: a standard "Share on LinkedIn" app never receives a
  // refresh_token — only approved MDP partners do. So the best available
  // behaviour is to nag before it dies, with a one-tap link.
  if (enabled.has('linkedin')) {
    const li = await store.getToken('linkedin');
    const daysLeft = li ? Math.floor((+li.expires_at - Date.now()) / 864e5) : -1;
    if (daysLeft <= 10) {
      const authUrl = new URL('/auth/linkedin', env.LINKEDIN_REDIRECT_URI).toString();
      await notify(env,
        `🔑 LinkedIn token expires in ${daysLeft} day(s).\nTap to re-authorise (~30s):\n${authUrl}`);
    }
  }
  // Bluesky (app password, re-authenticated every publish) and Mastodon (a
  // non-expiring user token) have no token lifecycle to check here.

  // The real failure mode of this system is not a broken API. It is an empty
  // seed queue.
  const seeds = await store.seedCount();
  if (seeds < 3) {
    await notify(env,
      `🌱 Only ${seeds} seed(s) left.\nSend \`/seed <what happened>\` or \`/seed client <what happened>\`.`);
  }
}
