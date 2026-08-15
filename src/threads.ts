/**
 * src/threads.ts — OAuth, token refresh, and publishing for Threads.
 *
 * Same Meta Developer App as Instagram (see docs/setup/facebook.md — just
 * add the "Threads" product to it), same tester-bypasses-review pattern for
 * personal use, same OAuth/CSRF shape as src/linkedin.ts and
 * src/instagram.ts. Simpler than Instagram in one real way: Threads' API
 * addresses the authenticated user as `me` directly, so there's no separate
 * numeric business-account id to capture and store — just the token.
 *
 * UNVERIFIED, flagged rather than guessed-and-hidden: Threads API auth and
 * container endpoints below follow the documented shape of Meta's Graph API
 * family (the same shape Instagram's API — already live-tested elsewhere in
 * this project's design — uses), but this specific file hasn't been
 * exercised against a real account. If an endpoint 404s, check Meta's
 * current Threads API docs before assuming the code is wrong in some other
 * way — this family of API has a documented history of endpoint churn
 * (see docs/06's LinkedIn-Version sunset note for the same class of risk
 * on a different platform).
 */

import type { Env } from './index';
import type { Draft, Store } from './store';
import { fetchOrAmbiguous } from './errors';

const TH_AUTH = 'https://threads.net/oauth/authorize';
const TH_TOKEN = 'https://graph.threads.net/oauth/access_token';
const GRAPH = 'https://graph.threads.net';
const API_VERSION = 'v1.0';

// Threads caps at 500 chars per post (a limit, unlike Mastodon's
// instance-configurable default). Same approximation trade-off as
// src/bluesky.ts's grapheme count — see that file's comment.
const MAX_CHARS = 500;

export function fitThreadsText(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  return text.slice(0, MAX_CHARS - 1) + '…';
}

// ------------------------------------------------------------------- OAuth

export function startThreadsAuth(env: Env): Response {
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: env.THREADS_CLIENT_ID,
    redirect_uri: env.THREADS_REDIRECT_URI,
    response_type: 'code',
    scope: 'threads_basic,threads_content_publish',
    state,
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${TH_AUTH}?${params}`,
      'Set-Cookie': `th_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/auth/threads`,
    },
  });
}

export async function handleThreadsCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  const cookieState = getCookie(request, 'th_oauth_state');

  if (!returnedState || !cookieState || returnedState !== cookieState) {
    return new Response('invalid or missing OAuth state — restart at /auth/threads', { status: 400 });
  }
  if (!code) return new Response('missing code', { status: 400 });

  const tokenForm = new URLSearchParams({
    client_id: env.THREADS_CLIENT_ID,
    client_secret: env.THREADS_CLIENT_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: env.THREADS_REDIRECT_URI,
    code,
  });
  const shortRes = await fetch(TH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenForm,
  });
  if (!shortRes.ok) return new Response(`token exchange failed: ${await shortRes.text()}`, { status: 502 });
  const short = await shortRes.json<{ access_token: string }>();

  // Exchange for a long-lived token (60 days), same family as Instagram's
  // ig_exchange_token — this one is th_exchange_token.
  const longParams = new URLSearchParams({
    grant_type: 'th_exchange_token',
    client_secret: env.THREADS_CLIENT_SECRET,
    access_token: short.access_token,
  });
  const longRes = await fetch(`${GRAPH}/access_token?${longParams}`);
  if (!longRes.ok) return new Response(`long-lived exchange failed: ${await longRes.text()}`, { status: 502 });
  const long = await longRes.json<{ access_token: string; expires_in: number }>();

  const { storeFor } = await import('./index');
  const store = storeFor(env);
  try {
    await store.saveToken('threads', {
      access_token: long.access_token,
      expires_at: new Date(Date.now() + long.expires_in * 1000),
    });
  } finally {
    await store.close();
  }

  return new Response('Threads connected. You can close this tab.', {
    headers: { 'Content-Type': 'text/plain' },
  });
}

function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('Cookie') ?? '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

// ------------------------------------------------------------------ Refresh

/**
 * Same shape as Instagram's refresh: >24h old, resets to 60 days, run
 * nightly and unconditionally.
 */
export async function refreshThreadsToken(env: Env, store: Store) {
  const tok = await store.getToken('threads');
  if (!tok) throw new Error('no Threads token — visit /auth/threads');
  if (Date.now() - +tok.updated_at < 86_400_000) return;

  const res = await fetch(
    `${GRAPH}/refresh_access_token?grant_type=th_refresh_token&access_token=${tok.access_token}`
  );
  if (!res.ok) throw new Error(`refresh ${res.status}: ${await res.text()}`);

  const { access_token, expires_in } = await res.json<{ access_token: string; expires_in: number }>();
  await store.saveToken('threads', {
    access_token,
    expires_at: new Date(Date.now() + expires_in * 1000),
  });
}

// ----------------------------------------------------------------- Publish

export async function publishThreads(env: Env, store: Store, draft: Draft): Promise<string> {
  const tok = await store.getToken('threads');
  if (!tok) throw new Error('no Threads token — visit /auth/threads');

  const text = fitThreadsText(draft.body);
  const params = new URLSearchParams({
    media_type: draft.image_key ? 'IMAGE' : 'TEXT',
    text,
    access_token: tok.access_token,
  });
  if (draft.image_key) params.set('image_url', draft.image_key); // already a public URL

  const create = await fetch(`${GRAPH}/${API_VERSION}/me/threads?${params}`, { method: 'POST' });
  if (!create.ok) throw new Error(`threads container ${create.status}: ${await create.text()}`);
  const { id: creationId } = await create.json<{ id: string }>();

  // Same defensive wait as Instagram — publishing before the container has
  // finished processing surfaces as an unhelpful bare error.
  await waitUntilFinished(tok.access_token, creationId);

  // The publish call is the one genuinely ambiguous mutation — see src/errors.ts.
  const pubParams = new URLSearchParams({ creation_id: creationId, access_token: tok.access_token });
  const pub = await fetchOrAmbiguous(`${GRAPH}/${API_VERSION}/me/threads_publish?${pubParams}`, { method: 'POST' });
  if (!pub.ok) throw new Error(`threads_publish ${pub.status}: ${await pub.text()}`);

  const { id } = await pub.json<{ id: string }>();
  return id;
}

async function waitUntilFinished(accessToken: string, creationId: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const st = await fetch(
      `${GRAPH}/${API_VERSION}/${creationId}?fields=status&access_token=${accessToken}`
    ).then(r => r.json<{ status: string }>()).catch(() => null);

    if (!st || st.status === 'FINISHED') return;
    if (st.status === 'ERROR' || st.status === 'EXPIRED') throw new Error(`threads container ${st.status}`);
    await new Promise(r => setTimeout(r, 5_000));
  }
}
