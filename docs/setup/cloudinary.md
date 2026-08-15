# Image hosting setup (Cloudinary, replacing R2)

Maps to `src/cloudinary-storage.ts`. Every generated image — LinkedIn's
post image, Instagram/carousel slides, Threads' image, the bytes Bluesky
and Mastodon upload — is hosted here now. **Do this first**, before any
other platform setup guide — every one of them depends on this working.

## Why Cloudinary instead of Cloudflare R2

R2 is the one part of this stack that needs a **Cloudflare billing
profile** (a card on file) just to activate — even though usage stays at
$0 under the free tier. Once a card is attached, R2 is genuine
pay-as-you-go: if something ever went wrong (a runaway upload loop, say),
Cloudflare would bill the overage automatically rather than just stopping.

Cloudinary's free plan needs **no credit card**, and — verified before
building this, not assumed — it fails closed the same way GitHub does:
crossing the free tier's 25 monthly credits (1 credit ≈ 1GB storage, 1GB
bandwidth, or 1,000 transformations — one shared pool) doesn't auto-bill.
You get warnings from ~90% usage, then the account gets disabled if it
stays over. No card anywhere in this project, for anything, as shipped.

## 1. Sign up

`cloudinary.com` → free plan, no card required.

## 2. Get your three values

On the dashboard home page right after signup:
- **Cloud name**
- **API Key**
- **API Secret** (click to reveal)

## 3. Configure

```jsonc
// wrangler.jsonc — not sensitive, it's part of every delivery URL anyway
"CLOUDINARY_CLOUD_NAME": "your-cloud-name",
```

```bash
wrangler secret put CLOUDINARY_API_KEY
wrangler secret put CLOUDINARY_API_SECRET
```

Or drop them into `.dev.vars` / `secrets.json` and run `npm run secrets:push`.

That's it — no upload preset to create in the dashboard, no other manual
step. `src/cloudinary-storage.ts` uses **signed uploads** (computed with
your API secret, per-request) specifically to avoid needing one.

## The self-imposed safety ceiling

Beyond Cloudinary's own free-tier protection, `src/cloudinary-storage.ts`
also checks your account's actual credit usage (via Cloudinary's own usage
API) **before** every upload and refuses — with a Telegram alert — once
you cross 80% of your plan's credits. This project's real usage is
~15MB/month, a rounding error against 25GB-equivalent of monthly credits,
so hitting that ceiling under normal operation should be essentially
impossible; if it ever happens, that's the signal something is
looping/broken, not a milestone to raise the number past.

## What changed from the original docs

`docs/05-data-model.md` and `docs/07-operations.md` describe an R2 bucket
setup step (`wrangler r2 bucket create social-media`, "make it publicly
readable") — **skip that entirely.** There is no R2 bucket, no
`PUBLIC_R2_BASE` var, and no billing profile needed anywhere in this
project as shipped. `draft.image_key` / `draft.image_keys` in Atlas still
use those field names (schema stability), but they now hold full public
Cloudinary delivery URLs, not R2 object keys.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `cloudinary upload 401` | Wrong `CLOUDINARY_API_KEY`/`SECRET`, or the signature computation doesn't match — check `CLOUDINARY_CLOUD_NAME` is exactly right too (it's part of the request URL) |
| `cloudinary usage at .../... credits — refusing to upload` | Either something is genuinely looping (check `runs` in Atlas for repeated identical uploads), or you've had this running a long time — the fix is deliberately raising `SAFETY_CEILING_FRACTION` in `src/cloudinary-storage.ts`, not ignoring the alert |
| Instagram/Threads reject the image URL | Confirm the URL Cloudinary returned is actually reachable in a browser — free-tier delivery is public by default, this would be unusual |
