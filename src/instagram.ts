/**
 * src/instagram.ts — OAuth, token refresh, and container publishing. (v1.1)
 *
 * Counterintuitively, Instagram is the EASIER platform to keep running:
 * its token refreshes itself forever with no human involvement, unlike
 * LinkedIn's. It is the harder one to get started on — app review is 2-4 weeks.
 *
 * The OAuth pair below (startInstagramAuth / handleInstagramCallback) mirrors
 * src/linkedin.ts's pattern, including the same stateless CSRF cookie guard.
 * It didn't exist in the original v1.1 build — refreshInstagramToken assumed
 * a token had already been hand-seeded into Atlas via Meta's Graph API
 * Explorer, with no code path that ever produced one. This closes that gap:
 * "Instagram API with Instagram Login" (docs/06's "simpler for one" flow)
 * returns both a token and the numeric IG business user id in the same
 * round trip, so — like LinkedIn's member_urn from /v2/userinfo — the user
 * id is captured once at auth time and stored on the token document instead
 * of living in a separate static IG_USER_ID secret that had no way to be
 * populated automatically.
 */

import type { Env } from './index';
import type { Store, Draft } from './store';
import { fetchOrAmbiguous } from './errors';

const IG_AUTH = 'https://www.instagram.com/oauth/authorize';
const IG_TOKEN = 'https://api.instagram.com/oauth/access_token';
const GRAPH = 'https://graph.instagram.com';

// ------------------------------------------------------------------- OAuth

export function startInstagramAuth(env: Env): Response {
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: env.INSTAGRAM_CLIENT_ID,
    redirect_uri: env.INSTAGRAM_REDIRECT_URI,
    response_type: 'code',
    scope: 'instagram_business_basic,instagram_business_content_publish',
    state,
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${IG_AUTH}?${params}`,
      'Set-Cookie': `ig_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/auth/instagram`,
    },
  });
}

export async function handleInstagramCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  const cookieState = getCookie(request, 'ig_oauth_state');

  if (!returnedState || !cookieState || returnedState !== cookieState) {
    return new Response('invalid or missing OAuth state — restart at /auth/instagram', { status: 400 });
  }
  if (!code) return new Response('missing code', { status: 400 });

  // 1. Short-lived token (~1hr). Instagram sometimes appends "#_" to the
  // returned code — strip it, a well-known trap in this exact exchange.
  const tokenForm = new URLSearchParams({
    client_id: env.INSTAGRAM_CLIENT_ID,
    client_secret: env.INSTAGRAM_CLIENT_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: env.INSTAGRAM_REDIRECT_URI,
    code: code.replace(/#_$/, ''),
  });
  const shortRes = await fetch(IG_TOKEN, { method: 'POST', body: tokenForm });
  if (!shortRes.ok) return new Response(`token exchange failed: ${await shortRes.text()}`, { status: 502 });
  const short = await shortRes.json<{ access_token: string; user_id: number }>();

  // 2. Exchange for a long-lived token (60 days) — the same token shape
  // refreshInstagramToken below refreshes nightly thereafter.
  const longParams = new URLSearchParams({
    grant_type: 'ig_exchange_token',
    client_secret: env.INSTAGRAM_CLIENT_SECRET,
    access_token: short.access_token,
  });
  const longRes = await fetch(`${GRAPH}/access_token?${longParams}`);
  if (!longRes.ok) return new Response(`long-lived exchange failed: ${await longRes.text()}`, { status: 502 });
  const long = await longRes.json<{ access_token: string; expires_in: number }>();

  const { storeFor } = await import('./index');
  const store = storeFor(env);
  try {
    await store.saveToken('instagram', {
      access_token: long.access_token,
      expires_at: new Date(Date.now() + long.expires_in * 1000),
      // Reusing the token schema's member_urn field for the IG business user
      // id — same slot LinkedIn's sub-derived URN lives in, different
      // platform's identifier shape. See src/store.ts's tokens collection.
      member_urn: String(short.user_id),
    });
  } finally {
    await store.close();
  }

  return new Response('Instagram connected. You can close this tab.', {
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
 * Fully automatic. The token must be >24h old; each refresh resets it to 60
 * days from now. Run nightly and unconditionally — there is no penalty for
 * refreshing early, and letting it lapse means a full manual re-auth.
 */
export async function refreshInstagramToken(env: Env, store: Store) {
  const tok = await store.getToken('instagram');
  if (!tok) throw new Error('no Instagram token — visit /auth/instagram');
  if (Date.now() - +tok.updated_at < 86_400_000) return; // must be >24h old

  const res = await fetch(
    `${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${tok.access_token}`
  );
  if (!res.ok) throw new Error(`refresh ${res.status}: ${await res.text()}`);

  const { access_token, expires_in } = await res.json<{ access_token: string; expires_in: number }>();
  await store.saveToken('instagram', {
    access_token,
    expires_at: new Date(Date.now() + expires_in * 1000),
    member_urn: tok.member_urn, // refresh doesn't change the user id — carry it forward
  });
}

/**
 * Container flow. Instagram will NOT accept file bytes — it cURLs the URL you
 * give it. That is why the R2 bucket must be publicly readable and not
 * blocked by robots.txt.
 *
 * A draft with `image_keys` (plural — see src/carousel.ts) publishes as a
 * real carousel: one child container per slide, then a parent CAROUSEL
 * container referencing all of them. A draft with only `image_key` (the
 * pre-v1.1 shape) publishes as a single image, same as before.
 */
export async function publishInstagram(env: Env, store: Store, draft: Draft): Promise<string> {
  const tok = await store.getToken('instagram');
  if (!tok) throw new Error('no Instagram token — visit /auth/instagram');
  const igUserId = tok.member_urn;
  if (!igUserId) throw new Error('Instagram token has no user id — re-run /auth/instagram');

  // Meta's own docs give both 100 and 50 on the same page, and the widely
  // quoted 25 appears in neither. Query the endpoint instead of hardcoding.
  // A carousel counts as ONE post against this cap, however many slides it holds.
  const limit: any = await fetch(
    `${GRAPH}/${igUserId}/content_publishing_limit?access_token=${tok.access_token}`
  ).then(r => r.json()).catch(() => null);

  const used = limit?.data?.[0]?.quota_usage ?? 0;
  const cap = limit?.data?.[0]?.config?.quota_total ?? 25;
  if (used >= cap) throw new Error(`IG publish quota exhausted (${used}/${cap})`);

  const creationId = draft.image_keys?.length
    ? await createCarouselContainer(env, igUserId, tok.access_token, draft)
    : await createSingleContainer(env, igUserId, tok.access_token, draft);

  // Poll until FINISHED. Publishing early returns a bare 400 with no hint.
  // Cron Triggers get 15 minutes of wall time, so this is safe here.
  await waitUntilFinished(tok.access_token, creationId);

  // Publish. Containers expire after 24h — never split this across runs.
  // Unlike container creation above, a network-level failure HERE is
  // genuinely ambiguous: this is the call that makes the post live. See
  // src/errors.ts.
  const pub = await fetchOrAmbiguous(`${GRAPH}/v23.0/${igUserId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: creationId, access_token: tok.access_token }),
  });
  if (!pub.ok) throw new Error(`publish ${pub.status}: ${await pub.text()}`);

  const { id } = await pub.json<{ id: string }>();
  return id;
}

async function createSingleContainer(env: Env, igUserId: string, accessToken: string, draft: Draft): Promise<string> {
  const create = await fetch(`${GRAPH}/v23.0/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_url: `${env.PUBLIC_R2_BASE}/${draft.image_key}`,
      caption: draft.body,
      access_token: accessToken,
    }),
  });
  if (!create.ok) throw new Error(`container ${create.status}: ${await create.text()}`);
  const { id } = await create.json<{ id: string }>();
  return id;
}

async function createCarouselContainer(env: Env, igUserId: string, accessToken: string, draft: Draft): Promise<string> {
  // 1. One child container per slide, marked is_carousel_item. These must
  //    each reach FINISHED before they can be referenced by the parent.
  const childIds: string[] = [];
  for (const key of draft.image_keys!) {
    const create = await fetch(`${GRAPH}/v23.0/${igUserId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url: `${env.PUBLIC_R2_BASE}/${key}`,
        is_carousel_item: true,
        access_token: accessToken,
      }),
    });
    if (!create.ok) throw new Error(`carousel child container ${create.status}: ${await create.text()}`);
    const { id } = await create.json<{ id: string }>();
    await waitUntilFinished(accessToken, id);
    childIds.push(id);
  }

  // 2. The parent container references all children and carries the caption.
  const create = await fetch(`${GRAPH}/v23.0/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      media_type: 'CAROUSEL',
      children: childIds,
      caption: draft.body,
      access_token: accessToken,
    }),
  });
  if (!create.ok) throw new Error(`carousel parent container ${create.status}: ${await create.text()}`);
  const { id } = await create.json<{ id: string }>();
  return id;
}

async function waitUntilFinished(accessToken: string, creationId: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const st = await fetch(
      `${GRAPH}/${creationId}?fields=status_code&access_token=${accessToken}`
    ).then(r => r.json<{ status_code: string }>());

    if (st.status_code === 'FINISHED') return;
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') {
      throw new Error(`container ${st.status_code}`);
    }
    await new Promise(r => setTimeout(r, 20_000));
  }
  throw new Error(`container ${creationId} did not finish processing in time`);
}
