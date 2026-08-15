/**
 * src/platforms.ts — which platforms are actually turned on.
 *
 * ENABLED_PLATFORMS (wrangler.jsonc var) is a comma-separated list, default
 * "linkedin,instagram" — matches the behavior this project shipped with
 * before Bluesky/Threads/Mastodon existed, so leaving the var untouched
 * changes nothing. Every platform-specific code path checks membership here
 * before doing any work; disabled platforms cost nothing (no cron work, no
 * secrets required, no Telegram messages).
 *
 * TEXT_PLATFORMS are the ones src/multiplatform-generate.ts handles as a
 * group — one seed, one research pass, one image, N platform-voiced posts.
 * Instagram stays on its own pipeline (src/instagram-generate.ts) because
 * carousels are a structurally different content shape, not a length limit.
 */

import type { Env } from './index';
import type { Platform } from './store';

export const TEXT_PLATFORMS = ['linkedin', 'bluesky', 'threads', 'mastodon'] as const;
export type TextPlatform = typeof TEXT_PLATFORMS[number];

const ALL_PLATFORMS: Platform[] = ['linkedin', 'instagram', 'bluesky', 'threads', 'mastodon'];

export function enabledPlatforms(env: Env): Set<Platform> {
  const raw = (env.ENABLED_PLATFORMS || 'linkedin,instagram').trim();
  const requested = raw.split(',').map(p => p.trim().toLowerCase()).filter(Boolean);

  const enabled = new Set<Platform>();
  for (const p of requested) {
    if ((ALL_PLATFORMS as string[]).includes(p)) enabled.add(p as Platform);
    // Silently ignoring an unrecognized entry (typo, old platform name) is
    // deliberate here, not an oversight — this runs inside a cron with no
    // request/response cycle to surface a 400 on, and a typo'd platform
    // name should degrade to "that one's off," not take the whole run down.
    // health() below reports the parsed set on request via /status so a
    // typo is still discoverable.
  }
  return enabled;
}

export function isTextPlatform(p: Platform): p is TextPlatform {
  return (TEXT_PLATFORMS as readonly string[]).includes(p);
}

export function enabledTextPlatforms(env: Env): TextPlatform[] {
  const enabled = enabledPlatforms(env);
  return TEXT_PLATFORMS.filter(p => enabled.has(p));
}
