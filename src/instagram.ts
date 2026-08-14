/**
 * src/instagram.ts — token refresh + container publishing. (v1.1)
 *
 * Counterintuitively, Instagram is the EASIER platform to keep running:
 * its token refreshes itself forever with no human involvement, unlike
 * LinkedIn's. It is the harder one to get started on — app review is 2-4 weeks.
 */

import type { Env } from './index';
import type { Store, Draft } from './store';

const GRAPH = 'https://graph.instagram.com';

/**
 * Fully automatic. The token must be >24h old; each refresh resets it to 60
 * days from now. Run nightly and unconditionally — there is no penalty for
 * refreshing early, and letting it lapse means a full manual re-auth.
 */
export async function refreshInstagramToken(env: Env, store: Store) {
  const tok = await store.getToken('instagram');
  if (!tok) throw new Error('no Instagram token seeded');
  if (Date.now() - +tok.updated_at < 86_400_000) return; // must be >24h old

  const res = await fetch(
    `${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${tok.access_token}`
  );
  if (!res.ok) throw new Error(`refresh ${res.status}: ${await res.text()}`);

  const { access_token, expires_in } = await res.json<{ access_token: string; expires_in: number }>();
  await store.saveToken('instagram', {
    access_token,
    expires_at: new Date(Date.now() + expires_in * 1000),
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
  if (!tok) throw new Error('no Instagram token');

  // Meta's own docs give both 100 and 50 on the same page, and the widely
  // quoted 25 appears in neither. Query the endpoint instead of hardcoding.
  // A carousel counts as ONE post against this cap, however many slides it holds.
  const limit: any = await fetch(
    `${GRAPH}/${env.IG_USER_ID}/content_publishing_limit?access_token=${tok.access_token}`
  ).then(r => r.json()).catch(() => null);

  const used = limit?.data?.[0]?.quota_usage ?? 0;
  const cap = limit?.data?.[0]?.config?.quota_total ?? 25;
  if (used >= cap) throw new Error(`IG publish quota exhausted (${used}/${cap})`);

  const creationId = draft.image_keys?.length
    ? await createCarouselContainer(env, tok.access_token, draft)
    : await createSingleContainer(env, tok.access_token, draft);

  // Poll until FINISHED. Publishing early returns a bare 400 with no hint.
  // Cron Triggers get 15 minutes of wall time, so this is safe here.
  await waitUntilFinished(tok.access_token, creationId);

  // Publish. Containers expire after 24h — never split this across runs.
  const pub = await fetch(`${GRAPH}/v23.0/${env.IG_USER_ID}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: creationId, access_token: tok.access_token }),
  });
  if (!pub.ok) throw new Error(`publish ${pub.status}: ${await pub.text()}`);

  const { id } = await pub.json<{ id: string }>();
  return id;
}

async function createSingleContainer(env: Env, accessToken: string, draft: Draft): Promise<string> {
  const create = await fetch(`${GRAPH}/v23.0/${env.IG_USER_ID}/media`, {
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

async function createCarouselContainer(env: Env, accessToken: string, draft: Draft): Promise<string> {
  // 1. One child container per slide, marked is_carousel_item. These must
  //    each reach FINISHED before they can be referenced by the parent.
  const childIds: string[] = [];
  for (const key of draft.image_keys!) {
    const create = await fetch(`${GRAPH}/v23.0/${env.IG_USER_ID}/media`, {
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
  const create = await fetch(`${GRAPH}/v23.0/${env.IG_USER_ID}/media`, {
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
