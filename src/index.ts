/**
 * src/index.ts — cron dispatch + HTTP routes.
 *
 * The fetch handler is why this runs on Cloudflare Workers rather than GitHub
 * Actions: LinkedIn's OAuth redirect needs a public URL to land on, and so
 * does the Telegram webhook.
 */

import { MongoStore, type Store, type Platform } from './store';
import { generateDraft } from './generate';
import { generateInstagramDraft } from './instagram-generate';
import { publishLinkedIn, startLinkedInAuth, handleLinkedInCallback } from './linkedin';
import { publishInstagram, refreshInstagramToken } from './instagram';
import { notify, handleTelegramWebhook } from './telegram';

export interface Env {
  AI: Ai;
  MEDIA: R2Bucket;

  PUBLIC_R2_BASE: string;
  LINKEDIN_VERSION: string;
  LINKEDIN_REDIRECT_URI: string;
  IMAGE_MODEL: string;
  TEXT_MODEL: string;
  MONGODB_DB: string;

  MONGODB_URI: string;
  TOKEN_KEY: string;
  LINKEDIN_CLIENT_ID: string;
  LINKEDIN_CLIENT_SECRET: string;
  IG_USER_ID: string;
  GITHUB_PAT: string;
  TAVILY_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  WEBHOOK_SECRET: string;
}

export const storeFor = (env: Env): Store =>
  new MongoStore(env.MONGODB_URI, env.MONGODB_DB, env.TOKEN_KEY);

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
          case '0 2 * * *':  await generateDraft(env, store, ctx); break;
          case '0 4 * * *':  await publishDue(env, store, ctx, 'linkedin'); break;
          case '0 6 * * *':  await generateInstagramDraft(env, store, ctx); break;
          case '0 9 * * *':  await publishDue(env, store, ctx, 'instagram'); break;
          case '0 22 * * *': await health(env, store); break;
        }
      } catch (err: any) {
        await notify(env, `🔴 cron \`${event.cron}\` failed\n\n${err?.message ?? err}`);
      } finally {
        await store.close();
      }
    })());
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/auth/linkedin') return startLinkedInAuth(env);
    if (url.pathname === '/auth/linkedin/callback') return handleLinkedInCallback(request, env);

    // The unguessable path segment is the shared secret with Telegram.
    if (url.pathname === `/tg/${env.WEBHOOK_SECRET}` && request.method === 'POST') {
      return handleTelegramWebhook(request, env);
    }

    return new Response('not found', { status: 404 });
  },
};

async function publishDue(env: Env, store: Store, ctx: ExecutionContext, platform: Platform) {
  for (const draft of await store.dueFor(platform, 2)) {
    try {
      // Increment BEFORE the network call. A publish that times out but
      // actually succeeded must not be retried into a duplicate post.
      await store.setStatus(draft._id, 'approved', { attempts: draft.attempts + 1 });

      const remoteId = platform === 'linkedin'
        ? await publishLinkedIn(env, store, draft)
        : await publishInstagram(env, store, draft);

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

      await notify(env, `✅ published to ${platform}\n${remoteId}`);
    } catch (err: any) {
      const attempts = draft.attempts + 1;
      await store.setStatus(draft._id, attempts >= 3 ? 'failed' : 'approved', {
        attempts, last_error: String(err?.message ?? err),
      });
      await notify(env, `⚠️ ${platform} publish failed (${attempts}/3)\n\n${err?.message ?? err}`);
    }
  }
}

async function health(env: Env, store: Store) {
  // Instagram: fully automatic. Refresh nightly and unconditionally — there is
  // no penalty for refreshing early, and the failure mode of NOT refreshing is
  // a full manual re-authorisation.
  try {
    await refreshInstagramToken(env, store);
  } catch (err: any) {
    await notify(env, `⚠️ IG token refresh failed: ${err?.message ?? err}`);
  }

  // LinkedIn: a standard "Share on LinkedIn" app never receives a
  // refresh_token — only approved MDP partners do. So the best available
  // behaviour is to nag before it dies, with a one-tap link.
  const li = await store.getToken('linkedin');
  const daysLeft = li ? Math.floor((+li.expires_at - Date.now()) / 864e5) : -1;
  if (daysLeft <= 10) {
    const authUrl = new URL('/auth/linkedin', env.LINKEDIN_REDIRECT_URI).toString();
    await notify(env,
      `🔑 LinkedIn token expires in ${daysLeft} day(s).\nTap to re-authorise (~30s):\n${authUrl}`);
  }

  // The real failure mode of this system is not a broken API. It is an empty
  // seed queue.
  const seeds = await store.seedCount();
  if (seeds < 3) {
    await notify(env,
      `🌱 Only ${seeds} seed(s) left.\nSend \`/seed <what happened>\` or \`/seed client <what happened>\`.`);
  }
}
