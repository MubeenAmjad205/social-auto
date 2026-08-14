# Instagram setup

Maps to `src/instagram.ts` (OAuth + publish) and `src/instagram-generate.ts`
(carousel generation). Do `docs/setup/facebook.md` first — this assumes the
Meta App and its Instagram product already exist.

## 1. Instagram Professional account

Instagram app on your phone → Settings → **Account type and tools** →
switch to **Professional account** → choose **Creator** or **Business**
(either works here). Free, instant.

## 2. Permission + app review

**App Review → Permissions and Features** in the Meta App dashboard →
request **`instagram_business_content_publish`**.

**File this today regardless of the tester note below** — 2–4 weeks, no
expedited path, and it's the single longest lead time in the whole project.
Nothing else depends on it finishing, so it runs in the background while you
do everything else.

**But you likely don't need to wait for it.** Per docs/06's traps table and
`docs/setup/facebook.md` step 4: development mode already works fully for
accounts added as Testers — which is your own account, once you accepted
that invite. Review is only required to open the app to accounts that
*aren't* testers. Since this project only ever posts to your own account,
try the full flow below now; if it works, the review is just insurance for
later, not a blocker today.

## 3. Connect it — now automatic

This used to require manually extracting a token via Meta's Graph API
Explorer and hand-writing it into Atlas. **It doesn't anymore** —
`src/instagram.ts` now has a full OAuth pair mirroring LinkedIn's:

1. `npm run deploy`
2. Visit `https://<your-worker>/auth/instagram`, log in, approve
3. `handleInstagramCallback` exchanges the code for a short-lived token,
   exchanges *that* for a 60-day long-lived token, and — critically — reads
   the numeric **IG business user id back from the same response**. No
   separate lookup needed.
4. Token + user id get saved via `store.saveToken('instagram', …)`, encrypted
   the same way as LinkedIn's. You'll see "Instagram connected."

There is **no `IG_USER_ID` secret anymore** — if you're looking at an older
version of this doc or a stale `secrets.json`, remove it. The user id now
lives on the token document (`tokens.instagram.member_urn`, reusing the
field LinkedIn's URN lives in) and every publish call reads it from there.

## Token lifecycle — the easy side

Once connected, this is **fully automatic forever**:

- Long-lived token, 60 days
- The 03:00 PKT health cron (`0 22 * * *`) refreshes it nightly,
  unconditionally, once it's more than 24h old — `refreshInstagramToken` in
  `src/instagram.ts`
- Each refresh resets the clock to 60 days from that moment, so it never
  actually approaches expiry
- **No human involvement, ever** — the opposite of LinkedIn's every-60-days tap

The only way this breaks is never running `/auth/instagram` in the first
place, or a gap long enough (>60 days of the Worker not running) that
refreshing lapses — in which case `refreshInstagramToken` throws "no
Instagram token — visit /auth/instagram" and the health cron reports it to
Telegram.

## 4. R2 checklist (Instagram-specific requirements)

Instagram fetches every image by URL — it will not accept uploaded bytes.
This is why R2 must be public. Specifically:

- Bucket is publicly readable (custom domain or `r2.dev` subdomain) → `PUBLIC_R2_BASE` in `wrangler.jsonc`
- **robots.txt on that domain must not block Meta's crawler** — if it does, you'll see the deeply unhelpful "Only photo or video can be accepted as media type" error with a perfectly valid image
- Files under 8 MB (carousel PNGs from `src/rasterize.ts` are nowhere near this)

One deviation from docs/06 worth knowing: images are served as **PNG, not
JPEG** (`resvg-wasm` only emits PNG). Docs/06 recommends JPEG as "more
reliable"; PNG is generally accepted but this is unverified against a real
account. If you hit the media-type error above and the bucket/robots.txt
checks out, this is the next thing to suspect.

## 5. Publishing behavior already handled in code

- **Publish cap is queried, not hardcoded** — `GET /content_publishing_limit` before every publish, since Meta's own docs contradict themselves on the actual number (25 / 50 / 100 all appear somewhere)
- **A carousel counts as one post** against that cap, however many slides
- **Containers expire after 24h** — creation and publish always happen in the same `publishInstagram` call, never split across cron runs
- **A network failure on the final `media_publish` call is treated as ambiguous** (`src/errors.ts`) — if it might have actually posted, the draft goes straight to `failed` with a Telegram alert asking you to check Instagram manually, instead of silently retrying into a duplicate

## Troubleshooting

| Symptom | Cause |
|---|---|
| "Only photo or video can be accepted as media type" | Check in order: bucket public? URL returns raw image not HTML/redirect? robots.txt blocking Meta? under 8MB? |
| Bare 400 on publish | Container wasn't `FINISHED` yet — shouldn't happen, `waitUntilFinished` polls first, but a Meta-side processing delay past 5 tries would surface as this |
| "no Instagram token — visit /auth/instagram" | Token missing or refresh lapsed — just revisit the URL |
| App review pending but posts still go out | Expected — you're a tester on your own app, see step 2 |
| 400 "invalid or missing OAuth state" on callback | Same CSRF cookie guard as LinkedIn — restart at `/auth/instagram` |
