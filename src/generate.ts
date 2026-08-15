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
import { resolveProviderChain, generateImageBytes, type ImageProvider } from './image-providers';
import { uploadToCloudinary } from './cloudinary-storage';

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
 * IMAGE_PROVIDER (wrangler.jsonc, default "workers-ai") is a comma-separated
 * FALLBACK CHAIN, not a single choice — see src/image-providers.ts. Each
 * provider in the chain is tried in order; the first one that doesn't throw
 * wins. This only throws if every provider in the chain fails (e.g. all of
 * workers-ai/gemini/pollinations are down or out of quota at once).
 *
 * Returns a public URL (Cloudinary-hosted — see src/cloudinary-storage.ts)
 * plus which provider actually produced it, since that's only known after
 * the chain has run — callers use it for neuron-cost logging.
 */
export async function renderImage(env: Env, store: Store, prompt: string): Promise<{ url: string; provider: ImageProvider }> {
  const chain = resolveProviderChain(env);
  const errors: string[] = [];
  let generated: { bytes: Uint8Array; contentType: string } | null = null;
  let provider: ImageProvider = chain[0];

  for (const candidate of chain) {
    try {
      generated = await generateImageBytes(env, store, candidate, prompt);
      provider = candidate;
      break;
    } catch (err: any) {
      errors.push(`${candidate}: ${err?.message ?? err}`);
    }
  }

  if (!generated) {
    throw new Error(`every image provider in the fallback chain failed — ${errors.join(' | ')}`);
  }

  const ext = generated.contentType === 'image/png' ? 'png' : 'jpg';
  const key = `img/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
  const url = await uploadToCloudinary(env, key, generated.bytes, generated.contentType);
  return { url, provider };
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
