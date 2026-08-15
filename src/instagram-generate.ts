/**
 * src/instagram-generate.ts — the Instagram v1.1 pipeline: Carousel Writer,
 * slide rendering, and draft assembly.
 *
 * Reuses the Researcher (src/research.ts) and the same grounding contract as
 * LinkedIn — see docs/04-research-layer.md. The Carousel Writer differs from
 * the LinkedIn Writer only in shape (structured slides vs. one paragraph),
 * not in the rule: every external claim must still trace to facts[], and an
 * empty facts[] still falls back to a seed-only carousel.
 *
 * NOTE ON SEED CONSUMPTION: this draws from the same `seeds` collection as
 * src/generate.ts via store.nextSeed(), which atomically claims a seed on
 * read. Running both pipelines drains the queue roughly twice as fast as
 * LinkedIn alone — see docs/04's "empty seed queue is the real failure mode"
 * warning. Bank more than the documented 5-10 if you run both platforms, or
 * the two pipelines will starve each other.
 */

import type { Env } from './index';
import type { Fact, Seed, Store, Draft } from './store';
import { research } from './research';
import { BANNED } from './generate';
import { renderCarousel, type Slide, type SlideKind } from './carousel';
import { svgToPng } from './rasterize';
import { sendCarouselForApproval, notify } from './telegram';
import { uploadToCloudinary } from './cloudinary-storage';
import { extractAiText } from './util';

const SLIDE_SHAPE: SlideKind[] = ['cover', 'point', 'point', 'point', 'example', 'takeaway', 'cta'];

export async function generateInstagramDraft(env: Env, store: Store, ctx: ExecutionContext) {
  const started = Date.now();
  const steps: any[] = [];

  // Roughly 2:1 own-work to client-work, same mix as LinkedIn — see docs/03.
  const preferKind = Math.random() < 0.33 ? 'client' : 'own';
  const seed = await store.nextSeed(preferKind);

  if (!seed) {
    await notify(env,
      '📭 Seed queue is empty — no Instagram carousel today.\n\n' +
      'Send `/seed <what happened>` or `/seed client <what happened>`.');
    return;
  }

  // nextSeed() above already claimed this seed (set used_at) atomically. If
  // anything below fails, give it back rather than burning it for nothing.
  try {
    let t = Date.now();
    let facts: Fact[] = [];
    try {
      facts = await research(env, store, seed);
    } catch (err: any) {
      await notify(env, `⚠️ IG research failed, falling back to seed-only: ${err?.message ?? err}`);
    }
    steps.push({ name: 'research', ms: Date.now() - t, facts_found: facts.length });

    t = Date.now();
    const slides = await writeCarousel(env, seed, facts);
    steps.push({ name: 'write', ms: Date.now() - t, neurons_est: 20 });

    t = Date.now();
    const imageKeys = await renderAndUploadCarousel(env, slides);
    steps.push({ name: 'render', ms: Date.now() - t, slides: imageKeys.length });

    const caption = buildCaption(seed, facts);
    const flags = editCarousel(slides, caption, facts, seed);

    const id = await store.createDraft({
      platform: 'instagram',
      status: 'pending',
      body: caption,
      image_key: imageKeys[0] ?? null,
      image_keys: imageKeys,
      // Slides, not a prompt string — this is what the 🎲 redraw path re-reads
      // to regenerate the same carousel content with fresh renders.
      image_prompt: JSON.stringify(slides),
      seed,
      facts,
      editor_flags: flags,
      attempts: 0,
      last_error: null,
      remote_id: null,
      idempotency_key: `ig-${crypto.randomUUID()}`,
    } as Omit<Draft, '_id' | 'created_at' | 'published_at'>);

    await sendCarouselForApproval(env, {
      id,
      body: caption,
      flags,
      sourceCount: facts.length,
      imageUrls: imageKeys, // already public URLs — see renderAndUploadCarousel above
    });

    ctx.waitUntil(store.logRun({
      cron: '0 6 * * *', started_at: new Date(started),
      duration_ms: Date.now() - started, ok: true, steps,
      neurons_total_est: steps.reduce((n, s) => n + (s.neurons_est ?? 0), 0),
      error: null,
    }));
  } catch (err) {
    await store.returnSeed(seed._id);
    throw err;
  }
}

// ----------------------------------------------------------------- WRITER
// Same hard rule as the LinkedIn Writer: no tools, no network, only what's
// in facts[] or the seed. Structured JSON output instead of prose because
// the medium is slides, not paragraphs — the grounding contract doesn't
// change with the shape.

async function writeCarousel(env: Env, seed: Seed, facts: Fact[]): Promise<Slide[]> {
  const grounded = facts.length > 0;

  const system = [
    'You write a 7-slide Instagram teaching carousel for a full-stack Gen AI / ML',
    'engineer. Same voice as their LinkedIn posts: first person, concrete, no hype.',
    '',
    'Output ONLY a JSON array of exactly 7 objects, in this order, matching this shape:',
    '[',
    '  {"kind":"cover","heading":"the question or symptom, works as a standalone thumbnail"},',
    '  {"kind":"point","heading":"why the obvious answer fails"},',
    '  {"kind":"point","heading":"the actual explanation, part 1"},',
    '  {"kind":"point","heading":"the actual explanation, part 2"},',
    '  {"kind":"example","heading":"a concrete example","body":"with real numbers"},',
    '  {"kind":"takeaway","heading":"the takeaway in one sentence"},',
    '  {"kind":"cta","heading":"save this if you hit the same thing"}',
    ']',
    '',
    'HARD RULES',
    grounded
      ? '- You may ONLY state facts that appear in the SOURCES below.'
      : '- You have NO sources. Do not state any external fact, statistic, or news — write only from the experience below.',
    '- Never invent a statistic, version number, or source.',
    `- Never use: ${BANNED.slice(0, 10).join(', ')}.`,
    '- heading: under 70 characters. body (only on the example slide): under 90 characters.',
    '- No markdown, no emoji, no hashtags anywhere in the JSON.',
    '- Output the JSON array only. No prose before or after it.',
  ].join('\n');

  const sources = grounded
    ? '\n\nSOURCES:\n' + facts.map((f, i) =>
        `[${i + 1}] ${f.source_name} (${f.published_at.slice(0, 10)}): ${f.claim}\n    ${f.snippet.slice(0, 300)}`
      ).join('\n')
    : '\n\nSOURCES: none available. Write from experience only.';

  const res: any = await env.AI.run(env.TEXT_MODEL as any, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `WHAT I DID: ${seed.note}\nANGLE: ${seed.angle ?? 'pick the most useful takeaway'}${sources}` },
    ],
    max_tokens: 2000,
  });

  const raw = extractAiText(res);
  return parseSlides(env, raw, seed, res);
}

async function parseSlides(env: Env, raw: string, seed: Seed, fullRes?: unknown): Promise<Slide[]> {
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    const parsed = JSON.parse(match ? match[0] : raw);
    if (Array.isArray(parsed) && parsed.length >= 5) {
      return parsed.slice(0, 8).map((s: any, i: number) => ({
        kind: (SLIDE_SHAPE[i] ?? 'point') as SlideKind,
        heading: String(s?.heading ?? '').slice(0, 120) || fallbackHeading(i, seed),
        body: s?.body ? String(s.body).slice(0, 160) : undefined,
      }));
    }
    // Valid JSON, wrong shape (too few slides, or not an array) — this and
    // the catch below both used to fail silently into fallbackCarousel with
    // no trace of WHY, which is how "why does every carousel look like the
    // generic template" went undiagnosed. Surface the ENTIRE raw API
    // response, not just the extracted text field — if there's an error,
    // safety-filter flag, or different response shape than expected,
    // res.response alone hides it. Plain text, NOT markdown (raw output
    // routinely contains unbalanced `_ * [ ]` that 400 Telegram's legacy
    // Markdown parser and silently drop the whole message).
    const dump = JSON.stringify(fullRes, null, 2).slice(0, 1200);
    const msg = `⚠️ Carousel Writer returned ${Array.isArray(parsed) ? `only ${parsed.length} slide(s)` : 'a non-array'} (extracted text length ${raw.length}) — falling back to the generic template.\n\nFULL raw API response:\n${dump}`;
    console.error(msg);
    await notify(env, msg, { markdown: false });
  } catch (err: any) {
    // Malformed model output — fall through to the deterministic fallback.
    // Same principle as the LinkedIn Writer's empty-facts rule: degrade to
    // something honest and simple rather than retry into more invention.
    const dump = JSON.stringify(fullRes, null, 2).slice(0, 1200);
    const msg = `⚠️ Carousel Writer output wasn't valid JSON (${err?.message ?? err}, extracted text length ${raw.length}) — falling back to the generic template.\n\nFULL raw API response:\n${dump}`;
    console.error(msg);
    await notify(env, msg, { markdown: false });
  }
  return fallbackCarousel(seed);
}

// Same 70-char ceiling given to the model (writeCarousel's prompt) — the
// fallback path bypasses the LLM entirely, so nothing else enforces it here.
// Longer headings wrap into enough lines at cover-slide font size to risk
// colliding with the footer; see the wrap() math in src/carousel.ts.
const FALLBACK_HEADING_MAX = 70;

function fallbackCarousel(seed: Seed): Slide[] {
  return [
    { kind: 'cover', heading: truncate(seed.angle ?? seed.note) },
    { kind: 'point', heading: 'What happened' },
    { kind: 'example', heading: truncate(seed.note) },
    { kind: 'takeaway', heading: truncate(seed.angle ?? 'Worth knowing before it costs you a day') },
    { kind: 'cta', heading: 'Save this if you hit the same thing' },
  ];
}

function fallbackHeading(i: number, seed: Seed): string {
  return truncate(i === 0 ? (seed.angle ?? seed.note) : seed.note);
}

function truncate(s: string): string {
  return s.length > FALLBACK_HEADING_MAX ? s.slice(0, FALLBACK_HEADING_MAX - 1) + '…' : s;
}

// ---------------------------------------------------------------- RENDER

/** Returns public URLs (Cloudinary-hosted), not bucket keys — see src/cloudinary-storage.ts. */
export async function renderAndUploadCarousel(env: Env, slides: Slide[]): Promise<string[]> {
  const svgs = renderCarousel(slides);
  const day = new Date().toISOString().slice(0, 10);
  const batchId = crypto.randomUUID();

  const urls: string[] = [];
  for (let i = 0; i < svgs.length; i++) {
    const png = await svgToPng(svgs[i]);
    const key = `carousel/${day}/${batchId}/${i}.png`;
    urls.push(await uploadToCloudinary(env, key, png, 'image/png'));
  }
  return urls;
}

// ----------------------------------------------------------------- misc

function buildCaption(seed: Seed, facts: Fact[]): string {
  const lede = seed.angle ?? seed.note;
  return facts.length
    ? `${lede}\n\nSwipe through — grounded in ${facts.length} source(s).`
    : `${lede}\n\nSwipe through.`;
}

function editCarousel(slides: Slide[], caption: string, facts: Fact[], seed: Seed): string[] {
  const flags: string[] = [];
  const corpus = (facts.map(f => `${f.claim} ${f.snippet}`).join(' ') + ' ' + seed.note).toLowerCase();
  const allText = (caption + ' ' + slides.map(s => `${s.heading} ${s.body ?? ''}`).join(' ')).toLowerCase();

  // Instagram's hard cap — unlikely to trip given caption is built from a
  // short seed note/angle, but LinkedIn's equivalent draft gets the same
  // check (generate.ts's edit()) and this one was missing it.
  if (caption.length > 2200) flags.push(`caption too long: ${caption.length}/2200 chars`);

  for (const b of BANNED) {
    if (allText.includes(b)) flags.push(`banned phrase: "${b}"`);
  }

  const claims = allText.match(/\b\d+(\.\d+)?%?\b/g) ?? [];
  const unverified = [...new Set(claims)].filter(c => !corpus.includes(c));
  if (unverified.length) flags.push(`unverified: ${unverified.slice(0, 5).join(', ')}`);

  if (slides.length < 5) flags.push(`only ${slides.length} slides — thin carousel`);

  return flags;
}
