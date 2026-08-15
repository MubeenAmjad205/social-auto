/**
 * src/image-providers.ts — image generation backends, tried in order as a
 * FALLBACK CHAIN via IMAGE_PROVIDER in wrangler.jsonc (comma-separated,
 * e.g. "workers-ai,gemini,pollinations"). If the first provider throws
 * (quota exhausted, transient outage, missing key), the next one in the
 * list is tried automatically — renderImage() in generate.ts only fails if
 * every provider in the chain fails. A single value still works exactly
 * like before ("workers-ai" = no fallback, the default).
 *
 *   workers-ai    FLUX.2 klein-4b. Costs Workers AI neurons (~104/image, out
 *                 of 10,000/day free). The only one that supports style_refs
 *                 (see generate.ts) — the thing that keeps the feed looking
 *                 like one designer made it. Always available, no API key.
 *
 *   gemini        Google AI Studio's Gemini 2.5 Flash Image ("Nano Banana").
 *                 Free tier, no credit card, ~500 images/day. Needs a
 *                 GEMINI_API_KEY secret (free signup at aistudio.google.com/
 *                 apikey) — if unset, this provider fails fast and the chain
 *                 moves on. Meaningfully higher quality than FLUX schnell/
 *                 klein in most side-by-sides, and costs zero neurons.
 *
 *   pollinations  Zero setup: no API key, no account, effectively unlimited
 *                 under fair use. A single GET request that returns image
 *                 bytes directly. Good last resort in the chain — it has the
 *                 fewest ways to fail. Trade-off: anonymous requests may
 *                 carry a small watermark since March 2025 (registering at
 *                 auth.pollinations.ai removes it), and it's a third-party
 *                 service outside Cloudflare's account/quota/observability.
 *
 * REAL TRADE-OFF, either way: style_refs (see docs/09-resources.md, "the
 * feature almost nobody uses") only exists on workers-ai. When the chain
 * falls back to gemini or pollinations, that image is styled independently
 * — still worth having as a safety net over publishing nothing.
 */

import type { Env } from './index';
import type { Store } from './store';
import { b64ToBytes } from './util';
import { fetchMedia } from './cloudinary-storage';

export type ImageProvider = 'workers-ai' | 'pollinations' | 'gemini';

const ALL_PROVIDERS: ImageProvider[] = ['workers-ai', 'pollinations', 'gemini'];

export interface GeneratedImage {
  bytes: Uint8Array;
  contentType: string;
}

/** Parses IMAGE_PROVIDER as an ordered, deduped, comma-separated fallback chain. */
export function resolveProviderChain(env: Env): ImageProvider[] {
  const raw = (env.IMAGE_PROVIDER || 'workers-ai').trim();
  const chain: ImageProvider[] = [];
  const seen = new Set<ImageProvider>();

  for (const token of raw.split(',')) {
    const p = token.trim() as ImageProvider;
    if (!p) continue;
    if (!ALL_PROVIDERS.includes(p)) {
      throw new Error(`unknown IMAGE_PROVIDER "${p}" — expected a comma-separated list from: ${ALL_PROVIDERS.join(', ')}`);
    }
    if (!seen.has(p)) { seen.add(p); chain.push(p); }
  }

  return chain.length ? chain : ['workers-ai'];
}

export async function generateImageBytes(env: Env, store: Store, provider: ImageProvider, prompt: string): Promise<GeneratedImage> {
  switch (provider) {
    case 'workers-ai': return workersAiImage(env, store, prompt);
    case 'pollinations': return pollinationsImage(prompt);
    case 'gemini': return geminiImage(env, prompt);
  }
}

/**
 * FLUX.2 takes MULTIPART FORM DATA even for a text-only prompt, and `steps` is
 * fixed at 4 (distilled). This differs from flux-1-schnell, which takes plain
 * JSON. Swapping models blind will break here first.
 */
async function workersAiImage(env: Env, store: Store, prompt: string): Promise<GeneratedImage> {
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('width', '1024');
  form.append('height', '1024');

  // Style references: up to 4 previously-approved images, each under 512x512.
  // This is what makes the feed look like one designer made it. Almost nobody
  // uses this, and it matters more than model quality. Only FLUX.2 supports
  // it — the alternative providers below don't wire this up.
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
  return { bytes: b64ToBytes(res.image ?? res), contentType: 'image/jpeg' };
}

/**
 * No API key, no account. Self-limit isn't enforced in code because it
 * doesn't need to be: this project calls it once per generate run, hours
 * apart — nowhere near the 1-req/15s anonymous ceiling, same pattern as
 * the arXiv self-limit note in src/research.ts.
 */
async function pollinationsImage(prompt: string): Promise<GeneratedImage> {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`
    + `?width=1024&height=1024&nologo=true&safe=true`;
  const res = await fetch(url, { headers: { 'User-Agent': 'social-worker/1.0 (personal publishing pipeline)' } });
  if (!res.ok) throw new Error(`pollinations ${res.status}: ${await res.text()}`);
  // Returns JPEG per the platform's own API docs.
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: 'image/jpeg' };
}

/**
 * Requires GEMINI_API_KEY — throws immediately if unset, so the fallback
 * chain moves on to the next provider without wasting a network round trip.
 * Same base64-decode CPU cost as Workers AI's image models — see the CPU
 * note in workersAiImage above, it applies here too.
 */
async function geminiImage(env: Env, prompt: string): Promise<GeneratedImage> {
  if (!env.GEMINI_API_KEY) throw new Error('gemini provider needs a GEMINI_API_KEY secret');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  );
  if (!res.ok) throw new Error(`gemini ${res.status}: ${await res.text()}`);

  const json: any = await res.json();
  const part = json.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
  if (!part) throw new Error('gemini response had no inline image data — check the prompt didn\'t trip a safety filter');

  return { bytes: b64ToBytes(part.inlineData.data), contentType: part.inlineData.mimeType ?? 'image/png' };
}
