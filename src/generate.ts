/**
 * src/generate.ts — Writer, Art Director, Editor, and image rendering.
 *
 * NEURON BUDGET (10,000/day free, resets 00:00 UTC):
 *   text  gpt-oss-20b            ~14 neurons per 500-token post
 *   image flux-2-klein-4b        ~104 neurons per 1024x1024
 *   => one post/day ≈ 120 neurons. Images are ~99% of the spend.
 *      You can redraw ~90 times a day and still pay nothing.
 */

import type { Env } from './index';
import type { Fact, Seed, Store } from './store';
import { resolveProvider, generateImageBytes } from './image-providers';
import { b64ToBytes } from './util';
import { uploadToCloudinary, fetchMedia } from './cloudinary-storage';

export const BANNED = [
  'delve', 'tapestry', 'navigate the', 'leverage', 'testament to',
  "in today's fast-paced", 'game-changer', 'revolutionize', 'seamlessly',
  'paradigm shift', 'unlock the power', 'at the end of the day',
  'ever-evolving landscape', 'let that sink in', 'supercharge',
  'dive deep', 'the future is here', "it's not just",
];

// generateDraft (the original LinkedIn-only cron entry point) has been
// superseded by src/multiplatform-generate.ts's generateTextPlatforms,
// which — with only "linkedin" in ENABLED_PLATFORMS, the default — does
// exactly what this function used to do. write/artDirect/renderImage/edit
// below are the reusable toolkit that orchestrator (and the Bluesky/
// Threads/Mastodon writers alongside it) is built from.

// ----------------------------------------------------------------- WRITER
// No tools. No network. It can only state what it was handed — that is the
// entire grounding mechanism, and it is structural rather than instructional.

export async function write(env: Env, seed: Seed, facts: Fact[]): Promise<string> {
  const grounded = facts.length > 0;

  const system = [
    'You write LinkedIn posts for a full-stack Gen AI / ML engineer with three',
    'years of experience. The audience is senior engineers, hiring managers and',
    'technical founders — people who spot generated text instantly.',
    '',
    'HARD RULES',
    '- First person, past tense, about something that actually happened.',
    '- Concrete. Name the tool, the version, the number, the error.',
    '- One idea per post. No listicles.',
    grounded
      ? '- You may ONLY state facts that appear in the SOURCES below. Attribute by name ("per the FLUX.2 model card"), never paste a URL.'
      : '- You have NO sources. Do not state any external fact, statistic, or news. Write only about the engineer\'s own experience below.',
    '- Never invent a statistic, a paper title, a version number, or a source.',
    '- 120-200 words. Plain sentences. At most one emoji, usually zero.',
    '- No hook formulas, no engagement bait, no one-sentence-per-line ladders.',
    `- Never use: ${BANNED.slice(0, 10).join(', ')}.`,
    seed.kind === 'client'
      ? '- This is client work. Frame it as constraint → naive approach → what it cost → what worked. Demonstrate delivery. Do NOT advertise availability or add a call to action.'
      : '- Frame it as symptom → wrong hypothesis → actual cause → generalisable lesson.',
    '',
    'Output the post text only.',
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
    max_tokens: 600,
  });

  return (res.response ?? res.result?.response ?? '').trim();
}

// ----------------------------------------------------------- ART DIRECTOR

export async function artDirect(env: Env, post: string): Promise<string> {
  const res: any = await env.AI.run(env.TEXT_MODEL as any, {
    messages: [
      {
        role: 'system',
        content: [
          'Turn a LinkedIn post into a text-to-image prompt for an editorial graphic.',
          'HARD RULE: the image must contain NO words, letters, numbers or UI text.',
          'Rendered text is the single most common way these graphics look cheap,',
          'and the post body already carries the words.',
          'Describe: subject metaphor, composition, palette, lighting, medium.',
          'Restrained editorial illustration — not stock-gradient AI slop.',
          'Output the prompt only. One paragraph, under 60 words.',
        ].join('\n'),
      },
      { role: 'user', content: post },
    ],
    max_tokens: 200,
  });
  return (res.response ?? res.result?.response ?? '').trim();
}

// ------------------------------------------------------------------ IMAGE

/**
 * FLUX.2 takes MULTIPART FORM DATA even for a text-only prompt, and `steps` is
 * fixed at 4 (distilled). This differs from flux-1-schnell, which takes plain
 * JSON. Swapping models blind will break here first.
 *
 * IMAGE_PROVIDER (wrangler.jsonc, default "workers-ai") can swap this whole
 * backend for a free alternative — see src/image-providers.ts for what's
 * available and the trade-offs (namely: losing style_refs consistency).
 *
 * Returns a public URL (Cloudinary-hosted — see src/cloudinary-storage.ts), not a
 * bucket key. R2 held this before; it's gone now because once every draft's
 * image lives on GitHub, style_refs (which just point at a PREVIOUS draft's
 * image) had to follow it there too — leaving R2 with nothing left to do.
 */
export async function renderImage(env: Env, store: Store, prompt: string): Promise<string> {
  const provider = resolveProvider(env);

  let bytes: Uint8Array;
  let contentType = 'image/jpeg';

  if (provider === 'workers-ai') {
    const form = new FormData();
    form.append('prompt', prompt);
    form.append('width', '1024');
    form.append('height', '1024');

    // Style references: up to 4 previously-approved images, each under 512x512.
    // This is what makes the feed look like one designer made it. Almost nobody
    // uses this, and it matters more than model quality. Only Workers AI's
    // FLUX.2 supports it — the alternative providers don't wire this up.
    // Fetched by URL now, not read from a binding — see fetchMedia.
    for (const [i, url] of (await store.activeStyleRefs()).entries()) {
      const media = await fetchMedia(url);
      if (media?.body) form.append(`input_image_${i}`, await new Response(media.body).blob());
    }

    // FormData won't expose its boundary. Wrapping it in a Response serializes
    // it and generates the Content-Type header the model requires.
    const serialized = new Response(form);

    const res: any = await env.AI.run(env.IMAGE_MODEL as any, {
      multipart: {
        body: serialized.body,
        contentType: serialized.headers.get('content-type'),
      },
    });

    // Workers AI image models return a BASE64 STRING, not a stream. The decode
    // is unavoidable and is the main CPU cost in the pipeline, against a 10ms
    // budget now also carrying the Atlas TLS handshake.
    // If you hit "Exceeded CPU limit": drop to 768x768, then move this function
    // into its own Worker behind a service binding for a fresh budget.
    bytes = b64ToBytes(res.image ?? res);
  } else {
    const img = await generateImageBytes(env, provider, prompt);
    bytes = img.bytes;
    contentType = img.contentType;
  }

  const ext = contentType === 'image/png' ? 'png' : 'jpg';
  const key = `img/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
  return uploadToCloudinary(env, key, bytes, contentType);
}

// ----------------------------------------------------------------- EDITOR
// Annotates. Never rewrites. A validator that silently edits is worse than
// one that flags, because you stop being able to trust what you approved.

/**
 * maxChars defaults to LinkedIn's 3000-char hard cap. The short-form
 * platforms (Bluesky/Threads/Mastodon) already truncate to their own limits
 * before this runs — see fitBlueskyText etc. — so this check rarely fires
 * for them, but passing their real cap keeps the flag honest if it ever does.
 */
export function edit(body: string, facts: Fact[], seed: Seed, maxChars = 3000): string[] {
  const flags: string[] = [];
  const corpus = (facts.map(f => `${f.claim} ${f.snippet}`).join(' ') + ' ' + seed.note).toLowerCase();

  if (body.length > maxChars) flags.push(`too long: ${body.length}/${maxChars} chars`);
  if (/https?:\/\//.test(body)) flags.push('contains a URL — link penalty, name the source instead');

  const hashtags = (body.match(/#\w+/g) ?? []).length;
  if (hashtags > 3) flags.push(`${hashtags} hashtags — keep it to 3`);

  for (const b of BANNED) {
    if (body.toLowerCase().includes(b)) flags.push(`banned phrase: "${b}"`);
  }

  // Heuristic, and it will produce false positives on ordinary prose. That's
  // the right trade: dismissing a flag costs two seconds, a fabricated
  // statistic costs your credibility.
  const claims = body.match(/\b\d+(\.\d+)?%?\b|\b[A-Z][a-zA-Z]*[-.]?\d+(\.\d+)?\b/g) ?? [];
  const unverified = [...new Set(claims)].filter(c => !corpus.includes(c.toLowerCase()));
  if (unverified.length) flags.push(`unverified: ${unverified.slice(0, 5).join(', ')}`);

  return flags;
}
