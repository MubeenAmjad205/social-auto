/**
 * src/util.ts — small helpers shared across modules.
 *
 * b64ToBytes/bytesToB64 used to be copy-pasted into generate.ts, secrets.ts,
 * and image-providers.ts independently. Three copies of the same decode
 * logic drift out of sync silently — consolidated here instead.
 */

export function b64ToBytes(b64: string): Uint8Array {
  // Runtime-native where available — a fraction of the CPU of the atob loop.
  const anyU8 = Uint8Array as any;
  if (typeof anyU8.fromBase64 === 'function') return anyU8.fromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes: Uint8Array): string {
  const anyBytes = bytes as any;
  if (typeof anyBytes.toBase64 === 'function') return anyBytes.toBase64();
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/**
 * Workers AI text models don't share one response shape. Cloudflare's own
 * native models return `{ response: "..." }` (or nested under `.result` on
 * some SDK versions); @cf/openai/gpt-oss-20b — and presumably other
 * @cf/openai/* models — return OpenAI's chat-completion shape instead,
 * `{ choices: [{ message: { content: "..." } }] }`. Reading only the first
 * shape against the second silently extracts undefined -> '' with no error
 * anywhere: a real response, read from the wrong field, indistinguishable
 * from the model actually returning nothing. Found the hard way — see the
 * "raw length 0" trail in src/instagram-generate.ts's history.
 */
export function extractAiText(res: any): string {
  return (res?.response ?? res?.result?.response ?? res?.choices?.[0]?.message?.content ?? '').trim();
}
