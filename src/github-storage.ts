/**
 * src/github-storage.ts — public image hosting via GitHub, replacing R2.
 *
 * WHY THIS EXISTS: R2 is the one part of this stack that requires a
 * Cloudflare billing profile (a card on file) to even activate, even
 * though usage stays at $0 under the free tier (docs/09's own ledger flags
 * this explicitly). Once a card is attached, R2 is real pay-as-you-go —
 * Cloudflare bills overage automatically rather than just stopping, unlike
 * a hard-capped sandbox. GitHub has no equivalent billing model for
 * individual accounts: there is no card to attach here, and exceeding a
 * soft size recommendation gets you an email, never a charge.
 *
 * Reuses the existing GITHUB_PAT secret (already required for search rate
 * limits in src/research.ts) — needs `contents:write` (fine-grained PAT) or
 * the classic `repo` scope, since read-only search access isn't enough to
 * push commits. See docs/setup/github-media.md.
 *
 * Every "upload" is a commit to a small, DEDICATED public repo (raw.
 * githubusercontent.com only serves public repos without auth) —
 * deliberately not the code repo, to avoid a commit-per-generated-image
 * polluting its history.
 *
 * UNVERIFIED, flagged rather than assumed: this project's images are all
 * well under 1MB (compressed JPEG/PNG at 1024-1080px), comfortably inside
 * every limit GitHub documents for the Contents API — but this hasn't been
 * exercised against a real repo at volume. If uploads start failing above
 * some size, the Git Data API (blobs/trees/commits) is the documented
 * fallback for larger files; not needed at this project's scale.
 */

import type { Env } from './index';
import { bytesToB64 } from './util';

// GitHub's own guidance suggests keeping repos under a few GB; this
// project's real usage is ~15MB/month (docs/09's math, unchanged by moving
// the backend). 500MB is generous headroom while still catching a genuine
// runaway-upload bug within one release cycle instead of silently growing
// forever.
const SAFETY_CEILING_KB = 500 * 1024;

function repoParts(env: Env): [string, string] {
  const [owner, repo] = env.GITHUB_MEDIA_REPO.split('/');
  if (!owner || !repo) {
    throw new Error(`GITHUB_MEDIA_REPO must be "owner/repo", got "${env.GITHUB_MEDIA_REPO}"`);
  }
  return [owner, repo];
}

const gh = (env: Env) => ({
  Authorization: `Bearer ${env.GITHUB_PAT}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'social-worker/1.0 (personal publishing pipeline)',
});

/**
 * Uploads bytes to the media repo and returns the public raw URL — ready to
 * hand straight to Instagram/Threads (which need a URL) or store on a draft
 * for later fetching (LinkedIn/Bluesky/Mastodon, which need the bytes).
 */
export async function uploadToGitHub(env: Env, key: string, bytes: Uint8Array, contentType: string): Promise<string> {
  await assertUnderSafetyCeiling(env);
  const [owner, repo] = repoParts(env);

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${key}`, {
    method: 'PUT',
    headers: { ...gh(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `media: ${key}`,
      content: bytesToB64(bytes),
    }),
  });
  if (!res.ok) throw new Error(`github media upload ${res.status}: ${await res.text()}`);

  const json: any = await res.json();
  const url = json.content?.download_url;
  if (!url) throw new Error('github media upload succeeded but no download_url in response');
  return url;
}

/**
 * A hard, self-imposed ceiling checked BEFORE every write, not monitored
 * after the fact — independent of anything a provider's dashboard offers.
 * Queries GitHub's own repo-size accounting rather than keeping a separate
 * counter, so it can never drift out of sync with reality.
 */
async function assertUnderSafetyCeiling(env: Env): Promise<void> {
  const [owner, repo] = repoParts(env);
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: gh(env) }).catch(() => null);

  // A failed size check shouldn't block a publish that would otherwise
  // succeed — same "a missing signal is a smaller problem than no post at
  // all" principle already used throughout src/research.ts.
  if (!res || !res.ok) return;

  const json: any = await res.json();
  if (typeof json.size === 'number' && json.size >= SAFETY_CEILING_KB) {
    throw new Error(
      `media repo hit the self-imposed ${Math.round(SAFETY_CEILING_KB / 1024)}MB safety ceiling ` +
      `(currently ~${Math.round(json.size / 1024)}MB) — refusing to upload. ` +
      `This should never happen under normal use (~15MB/month expected) — check for a runaway ` +
      `loop before raising SAFETY_CEILING_KB in src/github-storage.ts.`
    );
  }
}

/**
 * Fetches bytes back for platforms that need the raw file (LinkedIn's PUT,
 * Bluesky's uploadBlob, Mastodon's media upload, FLUX's style_refs input) —
 * unlike R2's env.MEDIA.get(), this is a real subrequest against a public
 * URL, not a free binding. Still trivial against the 50-subrequest budget
 * at 1-2 calls per publish.
 */
export async function fetchGitHubMedia(url: string): Promise<{ body: ReadableStream<Uint8Array> | null; contentType: string } | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  return { body: res.body, contentType: res.headers.get('content-type') || 'application/octet-stream' };
}
