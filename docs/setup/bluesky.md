# Bluesky setup

Maps to `src/bluesky.ts`. The simplest of the four platforms to set up —
no OAuth flow, no app review, no callback route.

## 1. Create an App Password

On bsky.app (or any AT Protocol client) → **Settings → App Passwords →
Add App Password**. Name it something like `social-worker`.

**This is not your account password.** It's a scoped credential you can
revoke independently at any time without touching your login password —
use it, not your real password, in the secret below.

## 2. Set the secrets

```bash
wrangler secret put BLUESKY_HANDLE          # e.g. yourname.bsky.social
wrangler secret put BLUESKY_APP_PASSWORD    # the app password from step 1
```

Or drop them into `.dev.vars` / `secrets.json` and run `npm run secrets:push`.

## 3. Turn it on

Add `bluesky` to `ENABLED_PLATFORMS` in `wrangler.jsonc`:

```jsonc
"ENABLED_PLATFORMS": "linkedin,instagram,bluesky",
```

Redeploy. That's the entire setup — no `/auth/bluesky` route exists because
none is needed.

## How this actually works

Unlike LinkedIn or Instagram, `src/bluesky.ts` doesn't store a token in
Atlas at all. It calls `com.atproto.server.createSession` (the app
password login) fresh on every single publish — one extra HTTP call, once
a day, at this project's cadence. That trades a small amount of redundant
network work for skipping token-lifecycle management entirely: no
expiry, no refresh cron entry, nothing that can go stale.

Images (when a draft has one) go through `com.atproto.repo.uploadBlob`
before the post itself is created — if that upload fails for any reason,
the post still goes out as text-only rather than failing the whole publish
(Bluesky, unlike Instagram, accepts text-only posts).

## Character limit

Bluesky's real limit is 300 **graphemes**, not characters — emoji and some
accented characters count differently than raw string length would
suggest. `fitBlueskyText()` in `src/bluesky.ts` approximates this with
Unicode code-point counting rather than pulling in a full grapheme-
segmentation library; it's a heuristic, same trade-off class as the
carousel word-wrap in `src/carousel.ts`. The failure mode is truncating a
character or two early on exotic input, not broken output. The generated
draft is fit to this limit *before* it reaches you in Telegram for
approval — what you approve is what gets published, not silently
truncated later.

## Rate limits

5,000 points/hour, where a post costs 3 points. At this project's cadence
(at most a handful of posts a day) you will never come close.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `createSession` 401 | Wrong handle format (use the full `name.bsky.social`, not just `name`) or a revoked/mistyped app password |
| Post created but no image | Image upload failed silently — check the R2 object exists and is under Bluesky's size limits; the post itself still goes out |
| Text looks cut off | Working as intended past 300 graphemes — see `fitBlueskyText` above |
