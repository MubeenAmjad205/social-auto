# 02 — Architecture

## The whole system on one page

```
                        ┌──────────────────────────────────────┐
   cron 02:00 UTC ─────►│  GENERATE                            │
   (07:00 PKT)          │                                      │
                        │  1. pull unused seed from Atlas      │
                        │  2. RESEARCHER  ─────────┐           │
                        │  3. WRITER               │           │
                        │  4. ART DIRECTOR         │           │
                        │  5. FLUX.2 klein-4b → R2 │           │
                        │  6. EDITOR (validator)   │           │
                        │  7. draft doc → Atlas    │           │
                        └──────────┬───────────────┼───────────┘
                                   │               │
                                   ▼               ▼
                        ┌──────────────────┐  ┌──────────────────────┐
                        │ TELEGRAM         │  │ FREE SOURCES         │
                        │ photo + caption  │  │  arXiv     no key    │
                        │ + ⚠️ editor flags │  │  HN Algolia no key   │
                        │ [✅][🎲][🗑]      │  │  GitHub     PAT      │
                        └──────────┬───────┘  │  HF Hub     no key   │
                                   │          │  RSS        no key   │
                    tap ──────────►│          │  Tavily     1k/mo    │
                                   ▼          └──────────────────────┘
                        ┌──────────────────┐
   POST /tg/<secret> ──►│ status=approved  │
                        └──────────┬───────┘
                                   │
   cron 04:00 UTC ─────────────────▼─────────────────────┐
   (09:00 PKT)          │  PUBLISH LinkedIn              │
                        │  /rest/images?initializeUpload │
                        │  → PUT bytes streamed from R2  │
                        │  → /rest/posts                 │
                        │  → urn in x-restli-id header   │
                        └──────────┬─────────────────────┘
                                   │
   cron 09:00 UTC ─────────────────┼── PUBLISH Instagram (v1.1)
   (14:00 PKT)                     │   /media → poll → /media_publish
                                   ▼
                        ┌───────────────────────────────┐
   cron 22:00 UTC ─────►│ TOKEN HEALTH                  │
   (03:00 PKT)          │  IG: auto-refresh, silent     │
                        │  LI: Telegram nag at T-10 days│
                        └───────────────────────────────┘

   GET /auth/linkedin          ─► 302 to LinkedIn consent
   GET /auth/linkedin/callback ─► exchange code, encrypt, store
```

## Component choices

| Component | Choice | What it actually solves | Rejected |
|---|---|---|---|
| Compute | **Cloudflare Workers** | Needs *both* a cron and a public HTTPS route. LinkedIn's OAuth redirect has to land somewhere | GitHub Actions (no URL to receive the callback), Express on a VPS (costs money, adds ops) |
| Scheduler | **Workers Cron Triggers** | 4 fixed daily runs; free plan allows 5 per account | node-cron (needs a live process), Actions cron (15+ min drift, silent 60-day disable) |
| Datastore | **MongoDB Atlas M0** | All state: tokens, drafts, seeds, runs, published record | D1 (rejected by decision — rationale and mitigations below) |
| Media | **Cloudflare R2**, public bucket | Instagram fetches media by URL and will not accept bytes. Hard requirement | Anything auth-gated or pre-signed |
| Text gen | **Workers AI** `gpt-oss-20b` | ~14 neurons/post | External LLM APIs — another key, quota, and failure mode |
| Image gen | **Workers AI** FLUX.2 `klein-4b` | ~104 neurons per 1024², multi-reference for visual identity | flux-1-schnell (older generation), klein-9b (13× cost, marginal gain at this volume) |
| Approval | **Telegram Bot API** | Free, instant, inline buttons, nothing to build | Email (no buttons), web dashboard (a whole product) |
| Search | **Tavily + keyless sources** | Grounding — see [04](04-research-layer.md) | Brave (free tier retired Feb 2026), Google CSE (closed, sunsets Jan 2027), Bing (deprecated Aug 2025) |

## MongoDB Atlas as the sole datastore

This was decided against my recommendation. It's a legitimate call — one
database, one mental model, skills you already have, and portable off
Cloudflare if you ever leave. What follows is not an argument; it's the list of
things that must be true for it to work.

### Four constraints, and the mitigation for each

**1. The Atlas Data API is gone.** App Services, Data API and HTTPS Endpoints
reached end-of-life on 30 September 2025. Every tutorial describing "call Atlas
over HTTPS from a Worker" is describing something that no longer exists.

→ *Mitigation:* use the Node driver directly. Cloudflare has since landed
`node:net` and TLSSocket/`connect` in `node:tls`, which were the blockers.

**2. `mongodb+srv://` will not resolve.** workerd has no `dns.resolveTxt`.

→ *Mitigation:* use the legacy multi-host connection string from Atlas
(Connect → Drivers → "Node.js 2.2.12 or later"). Note this breaks if Atlas
reshuffles cluster nodes — a real, if rare, operational risk.

**3. No static egress IP** means Atlas Network Access must be `0.0.0.0/0`.
Your database — holding OAuth tokens that can post as you for 60 days — is then
reachable from the whole internet behind only a password.

→ *Mitigation, and this one is not optional:* **encrypt tokens at rest with
AES-GCM using a key that lives only in `wrangler secret`.** A database
compromise then yields ciphertext, not your LinkedIn account. WebCrypto is
native, so the CPU cost is negligible. See `src/secrets.ts`. Also: restrict the
DB user to this one database, and use a generated 32-character password.

**4. Fresh TCP + TLS + SCRAM on every invocation.** Worker isolates are
ephemeral; there is no connection pool to reuse. That handshake is real CPU
against a 10 ms budget already carrying the image decode.

→ *Mitigation:* `maxPoolSize: 1`, aggressive timeouts, and — critically —
**measure it before building.** `spike/atlas-check.ts` answers this in an hour.

### The order of operations this implies

```
   spike/atlas-check.ts
          │
    ┌─────┴─────┐
    │           │
  PASSES      FAILS
    │           │
    │           └──► fall back: D1 for tokens + drafts (hot path),
    │                Atlas for runs + posts (archive).
    │                Same Store interface, one binding swap.
    ▼
  build on Atlas
```

The `Store` interface in [05](05-data-model.md) exists precisely so this
fallback is a one-file change rather than a rewrite. Run the spike first.

## The four agents

Full prompts and voice rules in [03](03-agents-and-personas.md). Pipeline shape:

```
seed ──► RESEARCHER ──► facts[] ──► WRITER ──► post ──► ART DIRECTOR ──► prompt ──► FLUX.2
             │                        ▲                                              │
             │                        │                                              ▼
             └── retrieval only ──────┘                                          EDITOR
                 never writes prose    no tools, no network                    (validator)
```

The wall between Researcher and Writer is the design, not an implementation
detail. **The Writer has no network access, so it cannot invent a source** —
it has never seen the internet. That's a structural guarantee; a prompt
instruction is not.

The n8n workflow this replaces collapsed both roles into one agent, told it to
cite sources, and handed it a search capped at one result inside a date window
that had already closed. That combination doesn't fail loudly — it produces
polished posts containing invented statistics.

## Free-tier budget

Daily burn at 1 post/day:

| Resource | Free allowance | Daily use | Headroom |
|---|---|---|---|
| Workers requests | 100,000/day | ~10 | 99.99% |
| Workers CPU | **10 ms/invocation** | see note | **tightest** |
| Workers subrequests | 50 external/invocation | ~15 | 3× |
| Cron Triggers | 5/account | 4 | 1 spare |
| Workers AI neurons | 10,000/day, resets 00:00 UTC | ~120 | ~80 more images/day |
| R2 storage | 10 GB-month | ~15 MB/month | decades |
| Tavily credits | 1,000/month | ~30/month | 33× |
| Atlas M0 | 512 MB | negligible | fine |
| Telegram | unmetered | ~5 messages | — |

**Total: $0/month. No credit card anywhere in the stack.**

**The CPU note.** 10 ms is per invocation and excludes time spent waiting on
`fetch()`. Two things consume it: the base64 image decode (Workers AI image
models return base64, not a stream — you cannot avoid this) and now the Atlas
TLS handshake. If it trips, in order: `Uint8Array.fromBase64` instead of the
`atob` loop → generate at 768×768 → move image generation into its own Worker
behind a service binding so it gets a fresh 10 ms budget.

## Failure philosophy

Cron Triggers **do not retry**. An exception in a scheduled run is silently
lost until the next tick and Cloudflare tells you nothing. Three rules follow:

1. **Every cron body is wrapped, every catch reports to Telegram.** A silent
   pipeline is worse than a broken one — you find out three weeks later. A
   weekday with no 07:00 message is itself the alarm.
2. **Publishing is idempotent.** Each draft carries a unique
   `idempotency_key`, and `attempts` increments *before* the network call, so
   an ambiguous timeout cannot produce a duplicate post.
3. **Non-critical writes never block critical ones.** Run logging goes through
   `ctx.waitUntil()`. With Atlas now on the critical path, this matters more,
   not less — a logging failure must never take down a publish.
