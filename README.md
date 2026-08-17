# social-worker

An assisted publishing pipeline for a solo Gen AI / ML engineer's public
presence — LinkedIn, Instagram, Bluesky, Threads, Mastodon, each toggled
independently. Cloudflare Workers, MongoDB Atlas, Telegram approval. Runs
on free tiers. Never publishes without a tap on your phone.

**Full documentation:** [`docs/`](docs/) — read [`docs/README.md`](docs/README.md) first.
Docs describe the original v1 design (LinkedIn only, Instagram deferred to
v1.1, no other platforms). **Instagram's carousel pipeline and three more
platforms have since been built** — see "Status vs. the docs" below for
exactly what changed and the trade-offs that came with it.

**Platform setup, step by step:** [`docs/setup/`](docs/setup/):
1. [`docs/setup/cloudinary.md`](docs/setup/cloudinary.md) — **do this first**, every other platform needs it: Cloudinary hosts every generated image now, replacing R2 entirely
2. [`docs/setup/linkedin.md`](docs/setup/linkedin.md) — Company Page, dev app, products, OAuth
3. [`docs/setup/facebook.md`](docs/setup/facebook.md) — the Meta Developer App that hosts Instagram's and Threads' APIs (this project never publishes to Facebook itself)
4. [`docs/setup/instagram.md`](docs/setup/instagram.md) — Professional account, permissions, `/auth/instagram`
5. [`docs/setup/threads.md`](docs/setup/threads.md) — same Meta App, add the Threads product, `/auth/threads`
6. [`docs/setup/bluesky.md`](docs/setup/bluesky.md) — an app password, no OAuth flow at all
7. [`docs/setup/mastodon.md`](docs/setup/mastodon.md) — a static token generated once in your instance's UI, no OAuth flow
8. [`docs/setup/email.md`](docs/setup/email.md) — optional last-resort alert channel if Telegram itself ever fails to deliver

Every platform above is off by default except LinkedIn and Instagram
(`ENABLED_PLATFORMS` in `wrangler.jsonc`) — set up only the ones you want.
**No Cloudflare billing profile is needed anywhere in this project** — R2
was the one thing that required a card, and it's gone.

## Layout


```
wrangler.jsonc              bindings, crons, vars, wasm/font bundler rules
spike/atlas-check.ts        RUN THIS FIRST — proves or kills the all-Atlas plan
assets/Inter-*.ttf          embedded fonts for carousel text rendering
src/index.ts                cron dispatch, OAuth routes, Telegram webhook
src/store.ts                MongoStore — the only data layer
src/secrets.ts              AES-GCM token encryption at rest
src/errors.ts               ambiguous-vs-clean publish failure classification
src/util.ts                 shared base64 helpers
src/platforms.ts            ENABLED_PLATFORMS parsing — the on/off switch for everything below
src/research.ts             the Researcher agent (shared by every platform)
src/cloudinary-storage.ts   image hosting — replaces R2, no billing profile needed anywhere
src/generate.ts             Writer/Art-Director/Editor/image toolkit (LinkedIn's shape; reused by others)
src/multiplatform-generate.ts  one seed, one research pass, one image -> N platform-voiced drafts
src/image-providers.ts      image provider FALLBACK CHAIN: Workers AI -> Gemini 2.5 Flash Image -> Pollinations
src/carousel.ts             Instagram: SVG slide template generator
src/rasterize.ts            Instagram: SVG -> PNG via resvg-wasm
src/instagram-generate.ts   Instagram: Carousel Writer + generation pipeline
src/linkedin.ts             OAuth + publish
src/instagram.ts            OAuth + token refresh + publish, real carousel container flow
src/threads.ts              OAuth + token refresh + publish
src/bluesky.ts              app-password session + publish, no stored token
src/mastodon.ts             static-token publish, no OAuth flow at all
src/email.ts                optional Gmail SMTP fallback if Telegram delivery fails
src/casestudy.ts            on-demand Company Page case-study writer (/casestudy)
src/rss.ts                  GET /feed.xml — public read-only archive feed
src/telegram.ts             approval gate — every platform, single-image and carousel drafts
src/migrate.ts              one-time index creation
docs/                       the nine original design docs — read in order
docs/setup/                  platform-by-platform setup guides
```

## Status vs. the docs — what's built beyond v1

The docs scope Instagram out of v1 because rendering legible text onto
carousel slides needs "a deterministic rasteriser... both viable options are
CPU-heavy against 10ms" (docs/08). That's been implemented now, not just
scoped. What that actually involved, and where it's honest to say "verified"
stops:

- **Verified** (typechecks, bundles, runs no network/credentials to build):
  `src/carousel.ts` (SVG template generator), the Carousel Writer prompt in
  `src/instagram-generate.ts`, the real Instagram carousel container API in
  `src/instagram.ts` (child containers -> parent `CAROUSEL` container ->
  publish), the Telegram album + approval UX in `src/telegram.ts`.
- **Not verified — needs your real Cloudflare account to know for sure:**
  whether `resvg-wasm` rendering 5-7 slides actually fits the 10ms CPU
  budget. This is the same open question docs/08 lists for the LinkedIn
  image path (`#1: Does the Atlas cold connect plus the base64 decode fit in
  10ms?`), extended to a second, heavier rasterizer running multiple times
  per Instagram post instead of once. If "Exceeded CPU limit" shows up on
  the 11:00 PKT generate-carousel cron once this is live, the mitigation
  ladder is the same one already documented for FLUX: shrink `SIZE` in
  `src/carousel.ts`, then move rendering into its own Worker behind a
  service binding for a fresh budget per slide.
- **Real deviations from the docs, made deliberately:**
  - Carousel slides render as flat editorial-gradient backgrounds, not
    FLUX-generated art. Generating 5-7 FLUX images per Instagram post
    instead of LinkedIn's one would multiply the neuron burn per post
    roughly 5-7x — flat color blocks cost zero neurons and are the more
    legible backdrop for slide text anyway.
  - Output is PNG, not JPEG. `resvg-wasm` only emits PNG; docs/06 says
    "Serve JPEG, not PNG — more reliable and faster for Meta to fetch."
    PNG is generally accepted by the Graph API, but this is unverified
    against a real Instagram account. If Meta rejects it, the fix is a
    PNG->JPEG re-encode step before the GitHub upload (e.g. `@jsquash/jpeg`) —
    not added yet because it's another WASM codec on top of an already
    1.49MB-gzip bundle.
  - **The free-plan cron budget is now fully spent.** Docs/02 and docs/07
    both note "4 used, one spare" — the spare slot now runs Instagram
    generation (`0 6 * * *`, 11:00 PKT). There is no headroom left for a
    fifth cron on the free plan.
  - Instagram generation draws from the same `seeds` collection as
    LinkedIn. Running both drains the queue roughly twice as fast — bank
    more than the docs' stated 5-10 if you run both platforms, or one will
    starve the other.
  - Bundle size grew from 237 KB gzip to **1.49 MB gzip** (resvg-wasm +
    two embedded font weights). Still comfortably under the 3MB compressed
    free-plan cap, but worth knowing if you add more to the bundle later.

Update: the font-family risk above is now resolved rather than open —
`assets/Inter-*.ttf`'s embedded family name was checked directly (`fonttools`
name table, ID 1) and is exactly `"Inter"` in both weights, matching what
`src/carousel.ts` and `src/rasterize.ts` request. Text rendering should not
silently fail on a name mismatch.

## Multi-platform expansion — Bluesky, Threads, Mastodon, email, more

Three more platforms, an optional email fallback, a client case-study
generator, and a public RSS feed, all added after the docs and all off by
default except the two that shipped with v1.

- **The free plan's 5-Cron-Trigger cap forced a real redesign, not just an
  add-on.** The docs' own layout already used all 5 slots. Adding
  Bluesky/Threads/Mastodon the naive way (a generate + publish cron each)
  would have needed 11. Instead, `src/multiplatform-generate.ts` pulls
  **one seed**, runs the Researcher **once**, renders **one shared image**,
  and writes an independent, platform-voiced post for every platform in
  `ENABLED_PLATFORMS` — still exactly 5 crons regardless of how many
  platforms are on. This is also, not incidentally, what docs/03 describes
  as the intended design and what the original build never actually did:
  "the shared asset is the seed, not the post."
- **This directly serves seed-queue health**, the docs' own stated top
  risk ("High likelihood, Fatal in practice"). One seed now produces posts
  for every enabled text platform instead of each platform draining its
  own — the opposite of what naively bolting on 3 more platforms would
  have done.
- **Cross-posting identical text was never on the table** — docs/01 lists
  it as an explicit non-goal ("performs worse on both"). Bluesky, Threads,
  and Mastodon each get their own Writer call, sized and voiced for that
  platform, not LinkedIn's text pasted elsewhere.
- **Bluesky and Mastodon need no OAuth flow at all** — Bluesky
  re-authenticates with an app password on every publish (no token to
  expire), Mastodon uses a token generated once in your instance's own
  settings UI. Threads mirrors Instagram's OAuth pattern exactly (same
  Meta App, same CSRF-cookie guard), since it's the same platform family.
- **`notify()` no longer assumes Telegram succeeded.** It now checks the
  response and falls back to email (`src/email.ts`) if the send itself
  failed — closing a real gap where Telegram, the entire monitoring
  channel, had no fallback if it was the thing that broke. Plain
  `nodemailer` doesn't work in Workers (no raw TCP, even with
  `nodejs_compat`); this uses `worker-mailer`, built on `cloudflare:sockets`,
  instead. **Every part of this is optional and fails silently closed** —
  unset `GMAIL_USER`/`GMAIL_APP_PASSWORD`/`ALERT_EMAIL_TO` and `notify()`
  behaves exactly as it always did.
- **`/casestudy <description>`** writes a Company Page–voiced post from a
  delivered project. It does not publish anywhere — Company Page
  publishing needs Marketing Developer Platform approval this project
  doesn't have (docs/06) — the text comes back over Telegram to paste in
  yourself.
- **`GET /feed.xml`** is a public, unauthenticated RSS 2.0 feed of
  everything ever published, across every platform, straight from the
  `posts` archive that already existed.
- **Unverified, same honesty policy as everything else in this project:**
  Threads' exact endpoints haven't been exercised against a real account
  (flagged in `src/threads.ts`); Bluesky's and Threads' character limits
  are enforced via Unicode code-point counting, not true grapheme
  segmentation (a heuristic, not a bug — see `src/bluesky.ts`).

## R2 removed entirely — image hosting moved to GitHub

Every doc, and this README until now, described Cloudflare R2 as the media
store. **It's gone.** R2 is the one component in this whole stack that
needs a Cloudflare billing profile (a card on file) just to activate — and
unlike everything else here, it's genuine pay-as-you-go beyond the free
tier, not a hard-capped sandbox. `src/cloudinary-storage.ts` replaces it:
every generated image is hosted via Cloudinary instead — verified before
switching, not assumed: Cloudinary's free plan needs no card either, and
fails the same way (warnings, then account disable) rather than billing
automatically past the free tier. (A GitHub-repo-based approach was tried
first and works fine technically, but Cloudinary is the purpose-built tool
for this job rather than repurposing a git host — swapped before ever
shipping the GitHub version to production.)

This wasn't originally a planned full removal of R2 — it fell out of
actually tracing the code: `style_refs` (the multi-reference visual-
consistency feature) just point at a *previous* draft's image. Once that
image lives off R2, the reference has to follow it there too — which meant
R2 ended up with nothing left to do. Keeping a half-used R2 binding around
"just in case" would have been worse than removing it: dead config
protecting nothing.

Two things this adds beyond just removing the risk:
- **A hard, self-imposed safety ceiling**, checked before every upload via
  Cloudinary's own usage API (`src/cloudinary-storage.ts`) — refuses and
  alerts via Telegram once usage crosses 80% of the free plan's monthly
  credits, itself already ~30x this project's expected usage. Not a
  monitoring dashboard you have to remember to check; a check that runs on
  every write.
- `draft.image_key` / `draft.image_keys` in Atlas keep their field names
  (schema stability) but now hold full public URLs, not object-storage
  keys — worth knowing if you're inspecting the `drafts` collection directly.

See [`docs/setup/cloudinary.md`](docs/setup/cloudinary.md) for setup —
it's now the first thing to configure, since every platform's image path
depends on it.

## Hardening pass — bugs found and fixed after the initial build

A self-review after the v1.1 build turned up several real gaps, since fixed:

- **Telegram webhook had no sender authorization check.** The unguessable
  webhook URL was the only thing standing between a stranger and approving
  drafts under your name. `src/telegram.ts` now verifies the update's
  `chat.id` against `TELEGRAM_CHAT_ID` before doing anything else.
- **The LinkedIn approval message could silently truncate the post text**
  (Telegram's 1024-char photo-caption limit vs. a post plus flags). Approval
  text now always goes out as its own message, capped at Telegram's 4096-char
  message limit instead — same pattern the carousel flow already used.
- **`idempotency_key` didn't actually prevent duplicate posts** — it guarded
  the database, not the LinkedIn/Instagram API call itself. `src/errors.ts`
  now distinguishes a clean non-2xx response (safe to retry) from a
  network-level failure with no response at all (genuinely ambiguous — the
  post may have gone out). Ambiguous failures now stop auto-retrying and page
  you to check manually, instead of silently re-queuing.
- **Seed selection had a race window and burned seeds on failure.**
  `nextSeed()` now atomically claims a seed in one `findOneAndUpdate` instead
  of read-then-write-later. Seeds are now returned to the pool (not
  permanently burned) when a draft is rejected or when generation fails after
  claiming a seed.
- **`fetch()` routes had no error handling.** Only `scheduled()` reported
  failures to Telegram; a bug in the OAuth callback or the webhook itself
  failed silently. Both are now wrapped, same as crons.
- **OAuth `state` was generated but never checked** on the LinkedIn callback
  — a CSRF gap. It now round-trips through a short-lived HttpOnly cookie and
  is verified before exchanging the code.
- **Carousel word-wrap had no long-word fallback** — a single unbreakable
  token could overflow the slide edge. Long words now force-break.

Also added, as direct value-adds rather than bug fixes: `/pending` (list
active drafts from Telegram without waiting for the next message), `/status`
now shows the last run's health, `/seed <note> | angle: <text>` syntax, and a
⭐ button on published LinkedIn posts to save that image as a style ref
without touching Atlas directly.

## Setup

```bash
npm install
npm run typecheck
```

### Secrets — two files, two purposes

- **`.dev.vars`** (gitignored) — read automatically by `wrangler dev` for
  local runs. Copy from `.dev.vars.example` if you need to recreate it.
  `TOKEN_KEY` and `WEBHOOK_SECRET` are already generated in there since they
  don't depend on any external account — just fill in the rest as you collect
  each credential from LinkedIn / Atlas / Telegram / Tavily / GitHub.
- **`secrets.json`** (gitignored) — same shape, for pushing everything to the
  *deployed* Worker in one shot instead of nine separate `wrangler secret put`
  calls. Same pre-filled `TOKEN_KEY`/`WEBHOOK_SECRET`.

```bash
# 1. Prove the database plan works before anything else (docs/07, step 4)
#    Put MONGODB_URI in spike/.dev.vars, then:
npm run spike            # local check via wrangler dev
# or deploy it and hit the real URL:
npm run secrets:push:spike
npm run spike:deploy
curl https://atlas-spike.<you>.workers.dev

# 2. Once that passes and secrets.json is fully filled in:
npm run secrets:push     # wrangler secret bulk secrets.json

# 3. Deploy, then create indexes once
npm run deploy
npm run migrate

# 4. Wire the Telegram webhook, then authorize both platforms
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<worker>/tg/<WEBHOOK_SECRET>"
# visit https://<worker>/auth/linkedin in a browser, click Allow
# visit https://<worker>/auth/instagram in a browser, click Allow
```

`CLOUDINARY_CLOUD_NAME`, `LINKEDIN_VERSION`, `LINKEDIN_REDIRECT_URI`,
`INSTAGRAM_REDIRECT_URI`, `THREADS_REDIRECT_URI`, `ENABLED_PLATFORMS`,
`MASTODON_INSTANCE_URL`, `MASTODON_MAX_CHARS`, `ALERT_EMAIL_TO`,
`IMAGE_MODEL`, `TEXT_MODEL`, `IMAGE_PROVIDER`, `MONGODB_DB` are plain vars,
not secrets — edit them directly in [`wrangler.jsonc`](wrangler.jsonc).
`LINKEDIN_REDIRECT_URI`/`INSTAGRAM_REDIRECT_URI`/`THREADS_REDIRECT_URI` need
your Worker's actual `workers.dev` subdomain (`wrangler whoami` or the
Cloudflare dashboard) and must match the redirect URL registered on each
platform's app exactly.

### Dummy values — every one of these needs to be replaced

The project is fully wired end-to-end right now with placeholders so it
typechecks and bundles cleanly. Nothing here needs a real account until you
actually deploy or run the spike. `grep -rn "REPLACE_ME\|REPLACE-ME" .`
(excluding `node_modules`) finds all of them:

| File | Key(s) | Replace with |
|---|---|---|
| `wrangler.jsonc` | `CLOUDINARY_CLOUD_NAME` | From the Cloudinary dashboard home page. See `docs/setup/cloudinary.md` (**do this one first**) |
| `wrangler.jsonc` | `LINKEDIN_REDIRECT_URI` | `https://social-worker.<your-subdomain>.workers.dev/auth/linkedin/callback` — must exactly match the LinkedIn app's registered redirect URL. See `docs/setup/linkedin.md` |
| `wrangler.jsonc` | `INSTAGRAM_REDIRECT_URI` | Same subdomain, `/auth/instagram/callback` — registered on the Meta App's Instagram product. See `docs/setup/facebook.md` |
| `wrangler.jsonc` | `THREADS_REDIRECT_URI` | Same subdomain, `/auth/threads/callback`. See `docs/setup/threads.md` |
| `wrangler.jsonc` | `MASTODON_INSTANCE_URL` | Only if `"mastodon"` is in `ENABLED_PLATFORMS`. See `docs/setup/mastodon.md` |
| `.dev.vars`, `secrets.json` | `MONGODB_URI` | Atlas non-SRV multi-host connection string |
| `.dev.vars`, `secrets.json` | `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` | From the LinkedIn developer app's Auth tab. See `docs/setup/linkedin.md` |
| `.dev.vars`, `secrets.json` | `INSTAGRAM_CLIENT_ID` / `INSTAGRAM_CLIENT_SECRET` | The Meta App's Instagram API credentials. See `docs/setup/facebook.md`. There is no `IG_USER_ID` secret — visiting `/auth/instagram` now captures the IG business user id automatically |
| `.dev.vars`, `secrets.json` | `THREADS_CLIENT_ID` / `THREADS_CLIENT_SECRET` | Only if `"threads"` is enabled. Same Meta App as Instagram. See `docs/setup/threads.md` |
| `.dev.vars`, `secrets.json` | `BLUESKY_HANDLE` / `BLUESKY_APP_PASSWORD` | Only if `"bluesky"` is enabled. An app password, not your real password. See `docs/setup/bluesky.md` |
| `.dev.vars`, `secrets.json` | `MASTODON_ACCESS_TOKEN` | Only if `"mastodon"` is enabled. Generated once in your instance's UI, no OAuth flow. See `docs/setup/mastodon.md` |
| `.dev.vars`, `secrets.json` | `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | From the Cloudinary dashboard home page, next to `CLOUDINARY_CLOUD_NAME`. See `docs/setup/cloudinary.md` |
| `.dev.vars`, `secrets.json` | `GITHUB_PAT` | Read-only is fine — only used for search rate limits, doesn't host images |
| `.dev.vars`, `secrets.json` | `TAVILY_API_KEY` | app.tavily.com, free tier |
| `.dev.vars`, `secrets.json` | `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | From @BotFather / @userinfobot |
| `spike/.dev.vars` | `MONGODB_URI` | Same Atlas string as above |

`TOKEN_KEY` and `WEBHOOK_SECRET` are **not** dummies — they're real generated
values, already usable as-is. Only regenerate them if you specifically want
to (`openssl rand -base64 32` / `openssl rand -hex 24`), and if you do,
update both `.dev.vars` and `secrets.json` to match. `GMAIL_USER` /
`GMAIL_APP_PASSWORD` / `GEMINI_API_KEY` are genuinely optional — leave them
blank unless you're using the email fallback or want `gemini` active in the
`IMAGE_PROVIDER` fallback chain (leaving `GEMINI_API_KEY` blank while
`gemini` is still listed in the chain is safe — it just fails fast and
falls through to the next provider, see `src/image-providers.ts`).

There is no R2 bucket to create and no Cloudflare billing profile needed
anywhere — see `docs/setup/cloudinary.md` for why and what replaced it.

Before any of this: create the LinkedIn Company Page, request "Share on
LinkedIn", and file the Meta app review for Instagram. See
[`docs/07-operations.md`](docs/07-operations.md) for the full dependency-ordered
setup checklist and [`docs/08-roadmap.md`](docs/08-roadmap.md) for what "done"
means for v1.
