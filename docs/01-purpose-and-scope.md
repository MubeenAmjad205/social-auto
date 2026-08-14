# 01 — Purpose & Scope

## Who this is for

A full-stack Gen AI / ML engineer, roughly three years in, building a public
technical reputation from a standing start. Solo operator.

**Two goals, one account:**

1. **Roles.** Be findable and credible to hiring managers and engineering leads.
2. **Freelance / contract work.** Be visibly capable of delivering a client outcome.

That profile drives every decision here. The target audience — senior
engineers, hiring managers, technical founders — is the segment of the internet
*best* at spotting LLM boilerplate. Anything that reads as generated will be
discounted by exactly the people the account exists to earn.

## The dual-audience problem

The two goals want almost the same content and one very different thing.

**Where they agree (95% of it):** both audiences want evidence of judgment and
delivery. A post about a bug you chased for two days serves a hiring manager
and a prospective client identically. Neither wants a listicle about the future
of AI.

**Where they conflict:** advertising freelance availability signals to
employers that you're looking for gigs, not a role. A headline reading
"Available for AI/ML contracts" costs you inbound from companies hiring
full-time.

**The resolution is a separation of layers, not of voice:**

| Layer | Job | Audience signal |
|---|---|---|
| **Posts** | Build credibility | Identical for both. Never split the voice |
| **Personal profile** | Convert | Where availability lives. One field, changeable in ten seconds |
| **Company Page** | Freelance storefront | Separate surface. Carries the offer, no signal bleed onto your profile |

The Company Page is a LinkedIn API prerequisite you cannot avoid. Treat it as
the freelance front door you needed anyway rather than a compliance checkbox.

**One honest calibration:** organic LinkedIn is a *slow* channel for freelance
leads — months, not weeks. In year one, most contract work comes from Upwork,
direct outreach, and referrals. This pipeline compounds; it does not prospect.
Do not let it displace the channels that actually produce clients now.

## The actual problem being solved

Publishing consistently is a five-step loop that is individually trivial and
collectively exhausting:

1. Notice something worth saying
2. Check whether it's still true / find the source
3. Write it without sounding like everyone else
4. Make a graphic
5. Post it at a reasonable hour

Steps 2, 4 and 5 are mechanical. Step 3 is semi-mechanical. Step 1 is the only
part that requires being you — and it is the part that gets skipped when the
other four are annoying.

**v1 automates 2, 4 and 5, assists with 3, and refuses to do 1.**

## Explicit non-goals

These are decisions, not deferrals.

| Not doing | Why |
|---|---|
| Auto-publish without review | The failure mode is a fabricated claim under your own name, permanently, publicly. Asymmetric downside |
| Maximising volume | LinkedIn's 2026 model suppresses generic content rather than banning it. Volume buys a public record of low-effort output, not reach |
| Comment / connection / follow automation | Explicitly enforced against. Also: it's spam, and it's visible to the people you're trying to impress |
| Engagement pods | Detected. Reputational downside exceeds any reach gain |
| Scraping either platform | Official APIs only. This is the line between an integration and a bot |
| Multi-account / SaaS | One person, two accounts. Scope creep doubles auth complexity for zero benefit |
| Topic-form input ("write a post about X") | Produces content indistinguishable from everyone else's. Input is a seed from your own week |
| Cross-posting identical content | Performs worse on both. Share the seed, not the post |

## Cadence

**LinkedIn: 3–4× per week. Instagram: deferred to v1.1.**

Deliberately below the 1–2× daily originally scoped. The reasoning:

- Post quality is the only lever that affects distribution. Frequency isn't.
- At 3–4×/week every post can be anchored to something real. At 14×/week it
  cannot, and the pipeline starts generating filler — which is worse than
  posting nothing, because it's permanent and attributable.
- Instagram's API refuses text-only posts, and static AI imagery gets minimal
  reach in 2026. Doing it properly means carousels, which is a different
  production pipeline. See [08](08-roadmap.md).

The system supports higher frequency. The recommendation is not to use it.

## Success metrics

Follower count is the wrong metric and will actively mislead you.

**Leading (weekly)**
- Profile views — and specifically *whose*. Job titles, not headcount
- Saves and shares. LinkedIn weights these far above likes
- Comments containing a substantive question, not "Great post!"

**Lagging (quarterly)**
- Inbound DMs from people in target roles
- Interview requests, contract enquiries, speaking invitations traceable to a post
- Whether you'd be comfortable with a hiring manager reading your last ten posts

**Process (the honest ones)**
- **Rejection rate.** What fraction of drafts you kill. Below ~20% means you
  have stopped reading them and the gate has become decorative
- **Seed-queue depth.** Chronically empty means the bottleneck was never
  tooling
- **Time from draft to tap.** Routinely days means the cadence is wrong

## In scope for v1

- Cloudflare Worker: 4 crons, OAuth callback, Telegram webhook
- Research layer over free keyless sources + Tavily
- Grounded drafting with an enforced source contract
- Text-free editorial image on **every** post via FLUX.2 klein-4b
- Telegram approval: Approve / Redraw / Reject, plus `/seed`
- LinkedIn publishing via `/rest/images` + `/rest/posts`
- Token lifecycle: automatic for Instagram, one-tap re-auth for LinkedIn
- MongoDB Atlas as the sole datastore, with tokens encrypted at rest

## Out of scope for v1

- Instagram generation (API client is written; slide rendering is not)
- Analytics ingestion
- Any web UI — Telegram is the entire interface
- Scheduling beyond fixed daily crons
- Multi-language output
