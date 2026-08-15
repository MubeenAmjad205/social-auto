/**
 * src/mastodon.ts — publish via a static user access token.
 *
 * No OAuth flow in this file at all, deliberately. Mastodon's password
 * grant flow was removed from the spec for security reasons, and the
 * remaining path (an interactive authorization_code redirect) buys nothing
 * for a single-operator background job — you'd still end up creating an
 * OAuth Application in your instance's Settings -> Development UI, which
 * hands you a working user access token directly in that same screen. So
 * that's the whole setup: create the app once, copy the token, done. See
 * docs/setup/mastodon.md. Unlike LinkedIn's 60-day token, Mastodon user
 * tokens from this flow don't expire — no refresh cron entry needed either.
 *
 * MASTODON_INSTANCE_URL exists because Mastodon is federated — there is no
 * single API host the way graph.instagram.com is for Instagram. Whatever
 * server your account lives on (mastodon.social, a self-hosted instance,
 * etc.) is the host every call below goes to.
 */

import type { Env } from './index';
import type { Draft, Store } from './store';
import { fetchOrAmbiguous } from './errors';
import { fetchGitHubMedia } from './github-storage';

// Mastodon's default is 500; many instances raise it. This is a floor, not
// a hard platform-wide cap the way Bluesky's 300 graphemes is — if your
// instance allows more and you want to use it, MASTODON_MAX_CHARS overrides
// this default without a code change.
const DEFAULT_MAX_CHARS = 500;

export function fitMastodonText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + '…';
}

export async function publishMastodon(env: Env, store: Store, draft: Draft): Promise<string> {
  if (!env.MASTODON_INSTANCE_URL || !env.MASTODON_ACCESS_TOKEN) {
    throw new Error('Mastodon is enabled in ENABLED_PLATFORMS but MASTODON_INSTANCE_URL/MASTODON_ACCESS_TOKEN are not set');
  }
  const base = env.MASTODON_INSTANCE_URL.replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${env.MASTODON_ACCESS_TOKEN}` };
  const maxChars = Number(env.MASTODON_MAX_CHARS) || DEFAULT_MAX_CHARS;

  let mediaIds: string[] | undefined;
  if (draft.image_key) {
    // draft.image_key is a public URL (GitHub-hosted) — see src/generate.ts's renderImage.
    const media = await fetchGitHubMedia(draft.image_key);
    if (media?.body) {
      const form = new FormData();
      form.append('file', await new Response(media.body).blob());
      const upload = await fetch(`${base}/api/v1/media`, { method: 'POST', headers, body: form });
      if (upload.ok) {
        const { id } = await upload.json<{ id: string }>();
        mediaIds = [id];
      }
      // Same principle as Bluesky: a failed image upload doesn't block the
      // post. Mastodon accepts text-only statuses.
    }
  }

  // The status-creation call is the ambiguous one — media upload failing
  // just means no image, but a network failure here might have posted
  // anyway. See src/errors.ts.
  const post = await fetchOrAmbiguous(`${base}/api/v1/statuses`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: fitMastodonText(draft.body, maxChars),
      ...(mediaIds ? { media_ids: mediaIds } : {}),
    }),
  });
  if (!post.ok) throw new Error(`mastodon statuses ${post.status}: ${await post.text()}`);

  const { id, url } = await post.json<{ id: string; url: string }>();
  return url || id;
}
