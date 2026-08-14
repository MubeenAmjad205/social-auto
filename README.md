# social-worker

An assisted LinkedIn + Instagram publishing pipeline for a solo Gen AI / ML
engineer. Cloudflare Workers, MongoDB Atlas, Telegram approval. Runs on free
tiers. Never publishes without a tap on your phone.

**Full documentation:** [`docs/`](docs/) — read [`docs/README.md`](docs/README.md) first.
Docs describe the original v1 design (LinkedIn only, Instagram deferred to
v1.1). **The Instagram carousel pipeline described there as deferred has
since been built** — see "Status vs. the docs" below for exactly what
changed and the trade-offs that came with it.

## Layout

```
wrangler.jsonc            bindings, crons, vars, wasm/font bundler rules
spike/atlas-check.ts      RUN THIS FIRST — proves or kills the all-Atlas plan
assets/Inter-*.ttf        embedded fonts for carousel text rendering
src/index.ts              cron dispatch, OAuth routes, Telegram webhook
src/store.ts              MongoStore — the only data layer
src/secrets.ts            AES-GCM token encryption at rest
src/research.ts           the Researcher agent (shared by both platforms)
src/generate.ts           LinkedIn: Writer + Art Director + Editor + FLUX image
src/carousel.ts           Instagram: SVG slide template generator
src/rasterize.ts          Instagram: SVG -> PNG via resvg-wasm
src/instagram-generate.ts Instagram: Carousel Writer + generation pipeline
src/linkedin.ts           OAuth + publish
src/instagram.ts          token refresh + publish, incl. real carousel container flow
src/telegram.ts           approval gate — single-image and carousel drafts
src/migrate.ts            one-time index creation
docs/                     the nine original design docs — read in order
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
    PNG->JPEG re-encode step before the R2 upload (e.g. `@jsquash/jpeg`) —
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

# 4. Wire the Telegram webhook, then authorize LinkedIn
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<worker>/tg/<WEBHOOK_SECRET>"
# visit https://<worker>/auth/linkedin in a browser, click Allow
```

`PUBLIC_R2_BASE`, `LINKEDIN_VERSION`, `LINKEDIN_REDIRECT_URI`, `IMAGE_MODEL`,
`TEXT_MODEL`, `MONGODB_DB` are plain vars, not secrets — edit them directly in
[`wrangler.jsonc`](wrangler.jsonc). `PUBLIC_R2_BASE` needs either a custom
domain on the R2 bucket or its `r2.dev` public URL; `LINKEDIN_REDIRECT_URI`
needs your Worker's actual `workers.dev` subdomain (`wrangler whoami` or the
Cloudflare dashboard) and must match the redirect URL registered on the
LinkedIn app exactly.

### Dummy values — every one of these needs to be replaced

The project is fully wired end-to-end right now with placeholders so it
typechecks and bundles cleanly. Nothing here needs a real account until you
actually deploy or run the spike. `grep -rn "REPLACE_ME\|REPLACE-ME" .`
(excluding `node_modules`) finds all of them:

| File | Key(s) | Replace with |
|---|---|---|
| `wrangler.jsonc` | `PUBLIC_R2_BASE` | The R2 bucket's public URL (custom domain or `r2.dev`) |
| `wrangler.jsonc` | `LINKEDIN_REDIRECT_URI` | `https://social-worker.<your-subdomain>.workers.dev/auth/linkedin/callback` — must exactly match the LinkedIn app's registered redirect URL |
| `.dev.vars`, `secrets.json` | `MONGODB_URI` | Atlas non-SRV multi-host connection string |
| `.dev.vars`, `secrets.json` | `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` | From the LinkedIn developer app's Auth tab |
| `.dev.vars`, `secrets.json` | `IG_USER_ID` | Instagram Professional account's numeric id (v1.1, deferred) |
| `.dev.vars`, `secrets.json` | `GITHUB_PAT` | A PAT with no special scopes, just for search rate limit |
| `.dev.vars`, `secrets.json` | `TAVILY_API_KEY` | app.tavily.com, free tier |
| `.dev.vars`, `secrets.json` | `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | From @BotFather / @userinfobot |
| `spike/.dev.vars` | `MONGODB_URI` | Same Atlas string as above |

`TOKEN_KEY` and `WEBHOOK_SECRET` are **not** dummies — they're real generated
values, already usable as-is. Only regenerate them if you specifically want
to (`openssl rand -base64 32` / `openssl rand -hex 24`), and if you do,
update both `.dev.vars` and `secrets.json` to match.

`bucket_name: "social-media"` in `wrangler.jsonc` isn't a placeholder either
— it's the name the R2 bucket needs to be created with, or edit the binding
to match whatever name you actually create.

Before any of this: create the LinkedIn Company Page, request "Share on
LinkedIn", and file the Meta app review for Instagram. See
[`docs/07-operations.md`](docs/07-operations.md) for the full dependency-ordered
setup checklist and [`docs/08-roadmap.md`](docs/08-roadmap.md) for what "done"
means for v1.
