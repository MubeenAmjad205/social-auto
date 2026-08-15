/**
 * src/multiplatform-generate.ts — one seed, one research pass, one image,
 * independent posts for every enabled text-first platform.
 *
 * Why one seed for N platforms instead of each platform pulling its own
 * (the way LinkedIn and Instagram already do today): the free plan caps
 * Cron Triggers at 5, all already spent (docs/02, docs/07), so adding
 * Bluesky/Threads/Mastodon could never get their own generate crons without
 * a paid plan. More importantly, the docs' own stated top risk is an empty
 * seed queue ("High likelihood, Fatal in practice" — docs/08's risk table)
 * — letting N platforms each burn a seed per day would have made that
 * materially worse instead of better. This is also literally what docs/03
 * describes as the intended design and the original build never actually
 * did: "the shared asset is the seed, not the post... written separately,
 * from the same source of truth."
 *
 * Cross-posting identical text is an explicit non-goal (docs/01: "Performs
 * worse on both. Share the seed, not the post") — so this does NOT reuse
 * LinkedIn's body on other platforms. Each platform gets its own Writer
 * call, its own voice-appropriate length, from the same seed + facts.
 */

import type { Env } from './index';
import type { Fact, Seed, Store } from './store';
import { research } from './research';
import { write, artDirect, renderImage, edit, BANNED } from './generate';
import { sendDraftForApproval, notify } from './telegram';
import { enabledTextPlatforms, type TextPlatform } from './platforms';
import { fitBlueskyText } from './bluesky';
import { fitThreadsText } from './threads';
import { fitMastodonText } from './mastodon';

const CHAR_LIMITS: Record<TextPlatform, number> = {
  linkedin: 3000,
  bluesky: 300,
  threads: 500,
  mastodon: 500, // a floor — MASTODON_MAX_CHARS can raise it per-instance at publish time
};

const IDEMPOTENCY_PREFIX: Record<TextPlatform, string> = {
  linkedin: 'li', bluesky: 'bs', threads: 'th', mastodon: 'ma',
};

export async function generateTextPlatforms(env: Env, store: Store, ctx: ExecutionContext) {
  const started = Date.now();
  const steps: any[] = [];

  const platforms = enabledTextPlatforms(env);
  if (!platforms.length) return; // every text platform disabled — nothing to do

  // Roughly 2:1 own-work to client-work — see docs/03.
  const preferKind = Math.random() < 0.33 ? 'client' : 'own';
  const seed = await store.nextSeed(preferKind);

  if (!seed) {
    await notify(env,
      '📭 Seed queue is empty — no draft today.\n\n' +
      'Send `/seed <what happened>` or `/seed client <what happened>`.');
    return;
  }

  // nextSeed() above already claimed this seed atomically. If NOTHING
  // durable comes of it (every platform fails to write, or the shared image
  // fails), give it back — same principle as returning it on 🗑 Reject.
  try {
    let t = Date.now();
    let facts: Fact[] = [];
    try {
      facts = await research(env, store, seed);
    } catch (err: any) {
      await notify(env, `⚠️ research failed, falling back to seed-only: ${err?.message ?? err}`);
    }
    steps.push({ name: 'research', ms: Date.now() - t, facts_found: facts.length });

    // WRITE — independent per platform. A single platform's Writer failing
    // (a malformed model response, a transient Workers AI error) doesn't
    // take down the others; it's just skipped for this run, same "a missing
    // source is a smaller problem than no post at all" principle research.ts
    // already applies to individual data sources.
    const texts: Partial<Record<TextPlatform, string>> = {};
    for (const p of platforms) {
      try {
        t = Date.now();
        const raw = p === 'linkedin' ? await write(env, seed, facts) : await writeShortForm(env, seed, facts, p);
        // Fit to the platform's real limit NOW, at generation time — not at
        // publish time. If the text a human approves in Telegram isn't the
        // text that actually gets published, the approval step is theater.
        // (LinkedIn is the one exception: docs' Writer already targets
        // 120-200 words, well under its 3000-char cap, and has never
        // truncated — that established behavior is unchanged here.)
        texts[p] = p === 'linkedin' ? raw : fitText(p, raw);
        steps.push({ name: `write:${p}`, ms: Date.now() - t, neurons_est: 14 });
      } catch (err: any) {
        await notify(env, `⚠️ ${p} write failed, skipping it this run: ${err?.message ?? err}`);
      }
    }

    const produced = (Object.keys(texts) as TextPlatform[]);
    if (!produced.length) {
      await store.returnSeed(seed._id);
      await notify(env, '⚠️ every enabled platform failed to write from this seed — returned to the queue.');
      return;
    }

    // IMAGE — one shared render for every platform that produced text.
    // Generating a separate image per platform would multiply neuron spend
    // (or third-party quota, on the alt providers) by however many
    // platforms are enabled, for a gain nobody asked for — see
    // src/image-providers.ts's own neuron-budget reasoning.
    const representative = texts.linkedin ?? texts[produced[0]]!;
    const imagePrompt = await artDirect(env, representative);
    t = Date.now();
    const { url: imageKey, provider } = await renderImage(env, store, imagePrompt);
    steps.push({
      name: 'image', ms: Date.now() - t,
      neurons_est: provider === 'workers-ai' ? 104 : 0,
      model: provider === 'workers-ai' ? env.IMAGE_MODEL : provider,
    });

    // DRAFT + APPROVAL — one per platform, exactly like today's LinkedIn/
    // Instagram flow. A human still approves each independently; a garbled
    // Bluesky version doesn't have to block an otherwise-fine LinkedIn one.
    for (const p of produced) {
      const body = texts[p]!;
      const flags = edit(body, facts, seed, CHAR_LIMITS[p]);

      const id = await store.createDraft({
        platform: p,
        status: 'pending',
        body,
        image_key: imageKey,
        image_keys: null,
        image_prompt: imagePrompt,
        seed,
        facts,
        editor_flags: flags,
        attempts: 0,
        last_error: null,
        remote_id: null,
        idempotency_key: `${IDEMPOTENCY_PREFIX[p]}-${crypto.randomUUID()}`,
      });

      await sendDraftForApproval(env, {
        id, platform: p, body, flags,
        sourceCount: facts.length,
        imageUrl: imageKey, // already a public URL (Cloudinary-hosted) — see src/generate.ts's renderImage
      });
    }

    ctx.waitUntil(store.logRun({
      cron: '0 2 * * *', started_at: new Date(started),
      duration_ms: Date.now() - started, ok: true, steps,
      neurons_total_est: steps.reduce((n, s) => n + (s.neurons_est ?? 0), 0),
      error: null,
    }));
  } catch (err) {
    await store.returnSeed(seed._id);
    throw err; // still reported to Telegram by the scheduled() wrapper in index.ts
  }
}

function fitText(platform: TextPlatform, text: string): string {
  switch (platform) {
    case 'bluesky': return fitBlueskyText(text);
    case 'threads': return fitThreadsText(text);
    case 'mastodon': return fitMastodonText(text, CHAR_LIMITS.mastodon);
    default: return text;
  }
}

// ----------------------------------------------------------- SHORT WRITER
// Same hard rule as the LinkedIn Writer in generate.ts: no tools, no
// network, only what's in facts[] or the seed. A condensed prompt for the
// platforms that need a shorter, punchier version of the same idea rather
// than LinkedIn's fuller 120-200 word treatment.

async function writeShortForm(env: Env, seed: Seed, facts: Fact[], platform: TextPlatform): Promise<string> {
  const grounded = facts.length > 0;
  const limit = CHAR_LIMITS[platform];

  const system = [
    `You write a single ${platform} post for a full-stack Gen AI / ML engineer.`,
    'Same voice as their LinkedIn posts: first person, concrete, no hype, one idea.',
    '',
    'HARD RULES',
    '- First person, past tense, about something that actually happened.',
    '- Concrete. Name the tool, the version, the number, the error.',
    grounded
      ? '- You may ONLY state facts that appear in the SOURCES below. Attribute by name, never paste a URL.'
      : '- You have NO sources. Do not state any external fact, statistic, or news — write only from the experience below.',
    '- Never invent a statistic, a paper title, a version number, or a source.',
    `- Hard limit: under ${limit} characters. Shorter is better than padded.`,
    '- No hook formulas, no engagement bait, no hashtags, no emoji.',
    `- Never use: ${BANNED.slice(0, 10).join(', ')}.`,
    seed.kind === 'client'
      ? '- This is client work. Frame it as constraint -> what worked. Do NOT advertise availability or add a call to action.'
      : '- Frame it as symptom -> cause -> lesson, compressed to fit the limit.',
    '',
    'Output the post text only.',
  ].join('\n');

  const sources = grounded
    ? '\n\nSOURCES:\n' + facts.map((f, i) =>
        `[${i + 1}] ${f.source_name} (${f.published_at.slice(0, 10)}): ${f.claim}`
      ).join('\n')
    : '\n\nSOURCES: none available. Write from experience only.';

  const res: any = await env.AI.run(env.TEXT_MODEL as any, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `WHAT I DID: ${seed.note}\nANGLE: ${seed.angle ?? 'pick the most useful takeaway'}${sources}` },
    ],
    max_tokens: 300,
  });

  return (res.response ?? res.result?.response ?? '').trim();
}
