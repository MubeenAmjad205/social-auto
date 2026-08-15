# Image hosting setup (GitHub, replacing R2)

Maps to `src/github-storage.ts`. Every generated image — LinkedIn's post
image, Instagram/carousel slides, Threads' image, the bytes Bluesky and
Mastodon upload — is hosted here now.

## Why this exists instead of Cloudflare R2

R2 is the one part of this stack that needs a **Cloudflare billing
profile** (a card on file) just to activate — even though usage stays at
$0 under the free tier. Once a card is attached, R2 is genuine
pay-as-you-go: if something ever went badly wrong (a runaway upload loop,
say), Cloudflare would bill the overage automatically rather than just
stopping. GitHub has no equivalent billing model for individual accounts —
there is no card to attach here, and exceeding a soft size guideline gets
you an email, never a charge.

## 1. Create a dedicated public repo

**Not the code repo.** Every generated image becomes a commit; doing that
against the code repo would bury real commits in image noise. Create a new
one — public (required: `raw.githubusercontent.com` only serves public
repos without authentication):

```
github.com/new -> name it e.g. "social-media" -> Public -> Create repository
```

Nothing else needed in it — no README, no initial commit required first.

## 2. Make sure your GITHUB_PAT can write to it

The same PAT already used for search rate limits (`src/research.ts`) is
reused here — but read-only search access isn't enough to push commits.
If your existing token was created narrowly for search:

**Fine-grained token** (recommended): `github.com/settings/tokens?type=beta`
→ Repository access: select the new media repo specifically → Permissions
→ **Contents: Read and write**.

**Classic token**: `github.com/settings/tokens` → needs the `repo` scope.

```bash
wrangler secret put GITHUB_PAT
```

(Same command whether you're setting it for the first time or replacing a
narrower one — the new value just needs the wider scope.)

## 3. Point the config at your repo

In `wrangler.jsonc`:

```jsonc
"GITHUB_MEDIA_REPO": "your-username/social-media",
```

No redirect URI, no OAuth flow, no callback route — this one's just a var.

## The self-imposed safety ceiling

Beyond removing the billing-risk category entirely, `src/github-storage.ts`
also checks the media repo's actual size (via GitHub's own API) **before**
every upload and refuses — with a Telegram alert — if it ever crosses
500MB. This project's real usage is ~15MB/month, so hitting that ceiling
under normal operation should be essentially impossible; if it ever
happens, that's the signal something is looping/broken, not a milestone to
raise the number past.

## What changed from the original docs

`docs/05-data-model.md` and `docs/07-operations.md` describe an R2 bucket
setup step (`wrangler r2 bucket create social-media`, "make it publicly
readable") — **skip that entirely.** There is no R2 bucket, no
`PUBLIC_R2_BASE` var, and no billing profile needed anywhere in this
project as shipped. `draft.image_key` / `draft.image_keys` in Atlas still
use those field names (schema stability), but they now hold full public
GitHub URLs, not R2 object keys.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `github media upload 404` | `GITHUB_MEDIA_REPO` is wrong, or the repo doesn't exist yet |
| `github media upload 403` | Token lacks write access — see step 2 |
| `media repo hit the self-imposed 500MB safety ceiling` | Either something is genuinely looping (check `runs` in Atlas for repeated identical uploads), or you've been running this a very long time — the fix is to raise `SAFETY_CEILING_KB` in `src/github-storage.ts` deliberately, not to ignore the alert |
| Instagram/Threads reject the image URL | Same class of issue as R2 used to have — confirm the repo is actually **public**, not private |
