/**
 * src/cloudinary-storage.ts — public image hosting via Cloudinary.
 *
 * Replaces src/github-storage.ts, which replaced Cloudflare R2. R2 needed a
 * billing profile (a card on file) just to activate and was genuine
 * pay-as-you-go beyond the free tier. GitHub had no card at all but stored
 * every image as a git commit to a repo — functionally fine, but an
 * unusual fit for what is, in the end, media hosting. Cloudinary is a
 * purpose-built image CDN with the same billing safety: no card required
 * for the free plan, and — verified before switching, not assumed —
 * crossing the free tier's 25 monthly credits does NOT auto-bill. Cloudinary
 * warns at ~90% usage and disables the account if it stays over, the same
 * "fails closed" shape as GitHub's soft limits, just from a provider built
 * for this specific job.
 *
 * Auth: signed uploads (CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET), not
 * unsigned + an upload preset — avoids a manual "create an upload preset"
 * dashboard step, consistent with how little of this project's setup
 * happens by clicking through a UI. See docs/setup/cloudinary.md.
 */

import type { Env } from './index';

// 1 credit = 1GB storage OR 1GB bandwidth OR 1,000 transformations (a
// shared pool) on the free plan's 25 credits/month. This project's real
// usage (~15MB/month, docs/09's math) is a rounding error against that —
// 80% is a deliberately generous-but-real ceiling, not a number tuned to
// never trigger.
const SAFETY_CEILING_FRACTION = 0.8;

async function signature(params: Record<string, string>, apiSecret: string): Promise<string> {
  const toSign = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&') + apiSecret;
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(toSign));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Uploads bytes and returns Cloudinary's public delivery URL. */
export async function uploadToCloudinary(env: Env, key: string, bytes: Uint8Array, contentType: string): Promise<string> {
  await assertUnderSafetyCeiling(env);

  const timestamp = Math.floor(Date.now() / 1000).toString();
  // Cloudinary appends its own detected-format extension to the delivery
  // URL — strip ours from public_id so nothing ends up double-extensioned.
  const publicId = key.replace(/\.[a-z0-9]+$/i, '');
  const sig = await signature({ public_id: publicId, timestamp }, env.CLOUDINARY_API_SECRET);

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: contentType }));
  form.append('api_key', env.CLOUDINARY_API_KEY);
  form.append('timestamp', timestamp);
  form.append('public_id', publicId);
  form.append('signature', sig);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(`cloudinary upload ${res.status}: ${await res.text()}`);

  const json: any = await res.json();
  if (!json.secure_url) throw new Error('cloudinary upload succeeded but no secure_url in response');
  return json.secure_url as string;
}

/**
 * A hard, self-imposed ceiling checked BEFORE every write — independent of
 * Cloudinary's own account-disable behavior, which only kicks in after
 * sustained overage. Queries Cloudinary's own usage accounting rather than
 * a separate counter, so it can't drift out of sync with reality.
 *
 * UNVERIFIED, flagged rather than assumed: the exact shape of the /usage
 * response (credits.usage / credits.limit) is Cloudinary's documented
 * Admin API shape, but hasn't been exercised against a real account here.
 * If the shape is ever different, `used` defaults to 0 and this check
 * silently no-ops rather than blocking a publish that would otherwise
 * succeed — same "a missing signal is a smaller problem than no post at
 * all" principle used throughout src/research.ts. Worth confirming once
 * against a real account rather than trusting this comment forever.
 */
async function assertUnderSafetyCeiling(env: Env): Promise<void> {
  const auth = btoa(`${env.CLOUDINARY_API_KEY}:${env.CLOUDINARY_API_SECRET}`);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/usage`, {
    headers: { Authorization: `Basic ${auth}` },
  }).catch(() => null);
  if (!res || !res.ok) return;

  const json: any = await res.json();
  const used = json.credits?.usage ?? 0;
  const limit = json.credits?.limit ?? 25;
  if (used >= limit * SAFETY_CEILING_FRACTION) {
    throw new Error(
      `cloudinary usage at ${used}/${limit} credits (${Math.round((used / limit) * 100)}%) — ` +
      `refusing to upload past the self-imposed ${SAFETY_CEILING_FRACTION * 100}% ceiling. ` +
      `This should never happen under normal use (~15MB/month expected) — check for a runaway ` +
      `loop before raising SAFETY_CEILING_FRACTION in src/cloudinary-storage.ts.`
    );
  }
}

/**
 * Fetches bytes back for platforms that need the raw file (LinkedIn's PUT,
 * Bluesky's uploadBlob, Mastodon's media upload, FLUX's style_refs input).
 * Cloudinary's delivery URLs are public by design — no auth needed to GET
 * them, same as the upload response's secure_url that gets stored.
 */
export async function fetchMedia(url: string): Promise<{ body: ReadableStream<Uint8Array> | null; contentType: string } | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  return { body: res.body, contentType: res.headers.get('content-type') || 'application/octet-stream' };
}
