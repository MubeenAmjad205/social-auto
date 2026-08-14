/**
 * src/image-providers.ts — optional alternative backends for the LinkedIn
 * post image, selected via IMAGE_PROVIDER in wrangler.jsonc.
 *
 * Workers AI (FLUX.2 klein-4b) stays the default in generate.ts — nothing
 * changes unless you opt in. Two free alternatives, found while stress-
 * testing this project in August 2026:
 *
 *   pollinations  Zero setup: no API key, no account. A single GET request
 *                 that returns image bytes directly — actually SIMPLER than
 *                 Workers AI's multipart-form-data dance. Trade-off:
 *                 anonymous requests may carry a small watermark since
 *                 March 2025 (registering at auth.pollinations.ai removes
 *                 it), and it's a third-party service outside Cloudflare's
 *                 account, quota dashboard, and observability.
 *
 *   gemini        Google AI Studio's Gemini 2.5 Flash Image ("Nano
 *                 Banana"). Free tier, no credit card, ~500 images/day.
 *                 Needs a GEMINI_API_KEY secret (free signup at
 *                 aistudio.google.com/apikey). Meaningfully higher quality
 *                 than FLUX schnell/klein in most side-by-sides, and costs
 *                 zero Workers AI neurons — frees the entire 10k/day
 *                 neuron budget for text generation and unlimited redraws.
 *
 * REAL TRADE-OFF, either way: FLUX.2's multi-reference input (style_refs —
 * see docs/09-resources.md, "the feature almost nobody uses") is what keeps
 * the LinkedIn feed looking like one designer made it. Neither alternative
 * here wires up reference images, so switching providers means every image
 * is independently styled again. Worth it for quality or neuron budget;
 * worth knowing before you flip the switch.
 */

import type { Env } from './index';
import { b64ToBytes } from './util';

export type ImageProvider = 'workers-ai' | 'pollinations' | 'gemini';

export interface GeneratedImage {
  bytes: Uint8Array;
  contentType: string;
}

export function resolveProvider(env: Env): ImageProvider {
  const p = (env.IMAGE_PROVIDER || 'workers-ai').trim() as ImageProvider;
  if (p !== 'workers-ai' && p !== 'pollinations' && p !== 'gemini') {
    throw new Error(`unknown IMAGE_PROVIDER "${p}" — expected workers-ai, pollinations, or gemini`);
  }
  return p;
}

export async function generateImageBytes(env: Env, provider: ImageProvider, prompt: string): Promise<GeneratedImage> {
  switch (provider) {
    case 'pollinations': return pollinationsImage(prompt);
    case 'gemini': return geminiImage(env, prompt);
    default: throw new Error(`generateImageBytes called with "${provider}" — workers-ai is handled by generate.ts directly`);
  }
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
 * Requires GEMINI_API_KEY. Same base64-decode CPU cost as Workers AI's
 * image models — see the CPU note in generate.ts, it applies here too.
 */
async function geminiImage(env: Env, prompt: string): Promise<GeneratedImage> {
  if (!env.GEMINI_API_KEY) throw new Error('IMAGE_PROVIDER=gemini requires a GEMINI_API_KEY secret');

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
