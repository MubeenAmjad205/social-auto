# social-worker — v1.0 (final)

An assisted publishing pipeline for a solo Gen AI / ML engineer's LinkedIn
presence, built to serve two goals at once: **being findable for roles** and
**being hireable for contract work**.

Runs entirely on free tiers. Never publishes without a tap on your phone.

## Status of decisions

| Decision | Final | Locked in |
|---|---|---|
| Host | Cloudflare Workers | Needs both cron *and* a public URL for LinkedIn's OAuth redirect |
| Database | **MongoDB Atlas M0 — everything** | Your call; de-risked with a connection spike + token encryption |
| Media store | Cloudflare R2, public bucket | Instagram fetches media by URL; it will not accept bytes |
| Text model | Workers AI `gpt-oss-20b` | ~14 neurons/post. Effectively free |
| Image model | Workers AI **FLUX.2 `klein-4b`** | ~104 neurons/image, ~96/day free, multi-reference for visual consistency |
| Every post has an image | Yes | Mandatory on Instagram, materially better reach on LinkedIn |
| Approval channel | Telegram bot, inline buttons | Free, instant, phone-native, nothing to build |
| Cadence | 3–4× / week, LinkedIn only | Instagram deferred to v1.1 — see [08](docs/08-roadmap.md) |
| Purpose | Roles **and** freelance clients | Shapes the persona; see [03](docs/03-agents-and-personas.md) |

## Documentation

Read in order.

| Doc | Contents |
|---|---|
| [01 — Purpose & Scope](docs/01-purpose-and-scope.md) | Why this exists, the dual-audience problem, success metrics, hard non-goals |
| [02 — Architecture](docs/02-architecture.md) | Components, data flow, why each choice, free-tier budget, failure philosophy |
| [03 — Agents & Personas](docs/03-agents-and-personas.md) | The four agents, LinkedIn voice, the roles-vs-freelance tension, banned patterns |
| [04 — Research Layer](docs/04-research-layer.md) | Free data sources, the grounding contract, ranking, the empty-result rule |
| [05 — Data Model](docs/05-data-model.md) | Atlas collections, indexes, token encryption, the Store interface |
| [06 — Platform APIs](docs/06-platform-apis.md) | LinkedIn + Instagram: auth, endpoints, tokens, limits, traps |
| [07 — Operations](docs/07-operations.md) | Setup order, runbook, failure modes, quotas, security posture |
| [08 — Roadmap](docs/08-roadmap.md) | v1 checklist, deferred items with rationale, open questions, risks |
| [09 — Resources](docs/09-resources.md) | Every link, free tier, endpoint and reference in one place |

## Code

```
wrangler.jsonc          bindings, crons, vars
spike/atlas-check.ts    RUN THIS FIRST — proves or kills the all-Atlas plan
src/index.ts            cron dispatch, OAuth routes, Telegram webhook
src/store.ts            MongoStore — the only data layer
src/secrets.ts          AES-GCM token encryption at rest
src/research.ts         the Researcher agent
src/generate.ts         Writer + Art Director + Editor
src/linkedin.ts         OAuth + publish
src/instagram.ts        token refresh + publish (v1.1)
src/telegram.ts         approval gate
```

## The three rules the whole design serves

1. **No source, no claim.** The Writer has no network access. It can only state
   facts it was handed. If retrieval comes back empty it writes about your own
   work instead, which needs no citation.
2. **A human taps before anything is public.** Reach is recoverable. A
   fabricated statistic under your own name is not.
3. **Free means free.** No credit card on file anywhere. Every quota is
   documented in [07](docs/07-operations.md) with actual daily burn.

## Start here, this week

Do not start with code.

1. Create your **LinkedIn Company Page** — this is both an API prerequisite
   and your freelance storefront. One job, two purposes.
2. Submit the **Meta app review** for Instagram. 2–4 weeks, longest lead time,
   nothing depends on it.
3. Run `spike/atlas-check.ts`. One hour. It settles the database question.
4. **Write and post three posts by hand.** You will learn more about the voice
   from this than from Doc 03, and you will have real seeds banked by the time
   the pipeline can consume them.
