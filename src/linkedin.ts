/**
 * src/linkedin.ts — OAuth + publishing.
 *
 * Uses the CURRENT API: /rest/images + /rest/posts with a LinkedIn-Version
 * header. The /v2/assets?action=registerUpload + /v2/ugcPosts pair that most
 * tutorials (and n8n's LinkedIn node) still use is the deprecated generation.
 */

import type { Env } from './index';
import type { Store, Draft } from './store';

const AUTH = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN = 'https://www.linkedin.com/oauth/v2/accessToken';
const API = 'https://api.linkedin.com';

// ------------------------------------------------------------------- OAuth
// There is NO refresh token for a standard "Share on LinkedIn" app. This
// browser round-trip is unavoidable roughly every 60 days. These two routes
// are the entire reason the project is on Workers rather than GitHub Actions.

export function startLinkedInAuth(env: Env): Response {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.LINKEDIN_CLIENT_ID,
    redirect_uri: env.LINKEDIN_REDIRECT_URI,
    scope: 'w_member_social openid profile',
    state: crypto.randomUUID(),
  });
  return Response.redirect(`${AUTH}?${params}`, 302);
}

export async function handleLinkedInCallback(request: Request, env: Env): Promise<Response> {
  const code = new URL(request.url).searchParams.get('code');
  if (!code) return new Response('missing code', { status: 400 });

  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: env.LINKEDIN_CLIENT_ID,
      client_secret: env.LINKEDIN_CLIENT_SECRET,
      redirect_uri: env.LINKEDIN_REDIRECT_URI,
    }),
  });
  if (!res.ok) return new Response(`token exchange failed: ${await res.text()}`, { status: 502 });

  const tok = await res.json<{ access_token: string; expires_in: number }>();

  // `sub` from /v2/userinfo is what builds the author URN. Fetch once, store it.
  const info = await fetch(`${API}/v2/userinfo`, {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  }).then(r => r.json<{ sub: string }>());

  // saveToken encrypts before writing — see src/secrets.ts. The plaintext
  // never reaches the database.
  const { storeFor } = await import('./index');
  const store = storeFor(env);
  try {
    await store.saveToken('linkedin', {
      access_token: tok.access_token,
      expires_at: new Date(Date.now() + tok.expires_in * 1000),
      member_urn: `urn:li:person:${info.sub}`,
    });
  } finally {
    await store.close();
  }

  return new Response('LinkedIn connected. You can close this tab.', {
    headers: { 'Content-Type': 'text/plain' },
  });
}

// ----------------------------------------------------------------- Publish

export async function publishLinkedIn(env: Env, store: Store, draft: Draft): Promise<string> {
  const tok = await store.getToken('linkedin');
  if (!tok) throw new Error('no LinkedIn token — visit /auth/linkedin');
  if (+tok.expires_at <= Date.now()) throw new Error('LinkedIn token expired — visit /auth/linkedin');

  const headers = {
    Authorization: `Bearer ${tok.access_token}`,
    'LinkedIn-Version': env.LINKEDIN_VERSION,  // mandatory; omit it and /rest/* fails
    'X-Restli-Protocol-Version': '2.0.0',
  };

  // 1. Initialise the upload.
  const init = await fetch(`${API}/rest/images?action=initializeUpload`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ initializeUploadRequest: { owner: tok.member_urn } }),
  });
  if (!init.ok) throw new Error(`initializeUpload ${init.status}: ${await init.text()}`);
  const { value } = await init.json<{ value: { uploadUrl: string; image: string } }>();

  // 2. Stream the bytes straight from R2 — no buffering, no CPU cost.
  const obj = await env.MEDIA.get(draft.image_key!);
  if (!obj) throw new Error(`R2 object missing: ${draft.image_key}`);

  const put = await fetch(value.uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${tok.access_token}` },
    body: obj.body,
  });
  if (!put.ok) throw new Error(`image PUT ${put.status}: ${await put.text()}`);

  // 3. Create the post.
  const post = await fetch(`${API}/rest/posts`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      author: tok.member_urn,
      commentary: draft.body,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      content: { media: { id: value.image } },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
  });
  if (!post.ok) throw new Error(`posts ${post.status}: ${await post.text()}`);

  // The post URN comes back in a header, not the body.
  return post.headers.get('x-restli-id') ?? 'unknown';
}
