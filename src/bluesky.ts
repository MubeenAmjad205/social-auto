/**
 * src/bluesky.ts — publish via the AT Protocol.
 *
 * No OAuth flow, no token stored in Atlas, no refresh cron entry — Bluesky's
 * app-password model is simpler than either LinkedIn's or Instagram's for a
 * solo automation: createSession is called fresh on every publish (one
 * extra HTTP call, once a day, trivial) instead of managing a short-lived
 * accessJwt's lifecycle across invocations. BLUESKY_APP_PASSWORD is a
 * scoped credential generated in Settings -> App Passwords, not your real
 * account password — see docs/setup/bluesky.md.
 */

import type { Env } from './index';
import type { Draft, Store } from './store';
import { fetchOrAmbiguous } from './errors';

const PDS = 'https://bsky.social';
// 300 graphemes is AT Protocol's real limit, enforced via a specific
// grapheme-counting algorithm. Array.from(...).length (code points, not
// UTF-16 code units) is a reasonable approximation without pulling in
// Intl.Segmenter — same class of heuristic as the carousel word-wrap in
// src/carousel.ts: cheap, occasionally off by one on exotic input, and the
// failure mode is a slightly-early truncation, not broken output.
const MAX_GRAPHEMES = 300;

export function fitBlueskyText(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= MAX_GRAPHEMES) return text;
  return chars.slice(0, MAX_GRAPHEMES - 1).join('') + '…';
}

interface Session { accessJwt: string; did: string; }

async function createSession(env: Env): Promise<Session> {
  const res = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: env.BLUESKY_HANDLE, password: env.BLUESKY_APP_PASSWORD }),
  });
  if (!res.ok) throw new Error(`bluesky createSession ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function publishBluesky(env: Env, store: Store, draft: Draft): Promise<string> {
  if (!env.BLUESKY_HANDLE || !env.BLUESKY_APP_PASSWORD) {
    throw new Error('Bluesky is enabled in ENABLED_PLATFORMS but BLUESKY_HANDLE/BLUESKY_APP_PASSWORD are not set');
  }

  const session = await createSession(env);
  const headers = { Authorization: `Bearer ${session.accessJwt}`, 'Content-Type': 'application/json' };

  let embed: any = undefined;
  if (draft.image_key) {
    const obj = await env.MEDIA.get(draft.image_key);
    if (obj) {
      // uploadBlob wants raw bytes with the real content type, not JSON.
      const upload = await fetch(`${PDS}/xrpc/com.atproto.repo.uploadBlob`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.accessJwt}`,
          'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
        },
        body: obj.body,
      });
      if (upload.ok) {
        const { blob } = await upload.json<{ blob: unknown }>();
        embed = { $type: 'app.bsky.embed.images', images: [{ image: blob, alt: '' }] };
      }
      // A failed image upload doesn't block the post — Bluesky, unlike
      // Instagram, accepts text-only posts. Fall through and post without it.
    }
  }

  // The record-creation call is the one genuinely ambiguous mutation here —
  // uploadBlob failing just means no image, but a network failure creating
  // the actual post record might have gone through. See src/errors.ts.
  const create = await fetchOrAmbiguous(`${PDS}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      repo: session.did,
      collection: 'app.bsky.feed.post',
      record: {
        $type: 'app.bsky.feed.post',
        text: fitBlueskyText(draft.body),
        createdAt: new Date().toISOString(),
        ...(embed ? { embed } : {}),
      },
    }),
  });
  if (!create.ok) throw new Error(`bluesky createRecord ${create.status}: ${await create.text()}`);

  const { uri } = await create.json<{ uri: string }>();
  return uri;
}
