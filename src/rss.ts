/**
 * src/rss.ts — GET /feed.xml, a read-only Atom-compatible RSS 2.0 feed of
 * everything published across every platform.
 *
 * Public, no auth — meant to be subscribed to (a personal site, a feed
 * reader, an aggregator). Costs nothing beyond the Atlas read: the `posts`
 * archive already exists and is kept forever (docs/05's retention table),
 * this just exposes it.
 */

import type { Env } from './index';

export async function renderRssFeed(env: Env): Promise<Response> {
  // Dynamic import, not a top-level one — index.ts imports this module
  // directly (for the /feed.xml route), so a static import back would be
  // circular at module-init time. Same pattern src/telegram.ts, src/linkedin.ts
  // and src/instagram.ts already use for the identical reason.
  const { storeFor } = await import('./index');
  const store = storeFor(env);
  let posts: any[];
  try {
    posts = await store.listPosts(50);
  } finally {
    await store.close();
  }

  const items = posts.map(p => {
    const title = escapeXml(firstLine(p.body ?? ''));
    const description = escapeXml((p.body ?? '').slice(0, 500));
    const pubDate = new Date(p.published_at ?? Date.now()).toUTCString();
    const guid = escapeXml(String(p.remote_id ?? p.draft_id ?? ''));
    // remote_id is sometimes a real URL (Mastodon), sometimes a platform-
    // internal id/URN that isn't clickable (LinkedIn's urn:li:share:...,
    // Bluesky's at:// URI) — only emit <link> when it's actually one.
    const isUrl = /^https?:\/\//.test(String(p.remote_id ?? ''));
    const link = isUrl ? `<link>${escapeXml(p.remote_id)}</link>` : '';

    return `  <item>
    <title>${title}</title>
    <description>${description}</description>
    ${link}
    <guid isPermaLink="false">${guid}</guid>
    <pubDate>${pubDate}</pubDate>
    <category>${escapeXml(p.platform ?? '')}</category>
  </item>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>social-worker</title>
  <description>Posts published across LinkedIn, Instagram, and connected platforms.</description>
  <link>${escapeXml(channelLink(env))}</link>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
</channel>
</rss>`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
}

/**
 * The RSS <channel><link> is just "where can a reader learn more" metadata
 * — not tied to image hosting. Derived from the Worker's own hostname
 * (LinkedIn's redirect URI always has one, since LinkedIn is enabled by
 * default) rather than a dedicated var, since this is cosmetic, not load-bearing.
 */
function channelLink(env: Env): string {
  try {
    return new URL(env.LINKEDIN_REDIRECT_URI).origin;
  } catch {
    return 'https://workers.dev';
  }
}

function firstLine(body: string): string {
  const line = body.split('\n')[0] || body;
  return line.length > 100 ? line.slice(0, 99) + '…' : line;
}

function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
