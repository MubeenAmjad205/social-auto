# 08 — Roadmap

## Week 0 — before any code

Nothing here is engineering, and everything here can block you.

- [ ] Submit the **Meta app review** (2–4 weeks — start it today)
- [ ] Create + verify the **LinkedIn Company Page**, positioned as your practice
- [ ] LinkedIn app → verify → request "Share on LinkedIn"
- [ ] Run **`spike/atlas-check.ts`** — settles the data layer in an hour
- [ ] **Write and publish three posts by hand.** No pipeline
- [ ] Bank 10 seeds while writing them

The manual posts are not a warm-up exercise. They calibrate the persona in Doc
03 against reality, they give you a baseline to measure against, and they
produce the seeds the pipeline will need on day one. Skipping them means
launching a system with an empty queue and an unvalidated voice.

## v1 — LinkedIn, assisted, grounded

**Definition of done:** for four consecutive weeks, a grounded draft arrives on
your phone every weekday morning, you approve three of them, and they publish
without you opening a laptop.

- [ ] `spike/atlas-check.ts` passes (or the hybrid fallback is adopted)
- [ ] `src/secrets.ts` — AES-GCM token encryption, **before the first token is stored**
- [ ] `src/store.ts` — `MongoStore implements Store`
- [ ] `src/migrate.ts` — indexes, including the unique `idempotency_key`
- [ ] Worker: 4 crons + `/auth/linkedin` + callback + Telegram webhook
- [ ] `src/research.ts` — arXiv, HN, GitHub, HF Hub, RSS, Tavily + ranking + dedupe
- [ ] Writer with enforced fact envelope + the empty-result fallback
- [ ] Editor validator: length, links, unverified claims, banned phrases
- [ ] FLUX.2 klein-4b with `style_refs` multi-reference — **every post gets an image**
- [ ] Telegram: Approve / Redraw / Reject, `/seed`, `/seed client`
- [ ] LinkedIn publish via `/rest/images` + `/rest/posts`
- [ ] Token health cron: IG auto-refresh, LinkedIn nag, seed-queue warning

**Not in v1:** Instagram generation, analytics, any web UI.

## v1.1 — Instagram, done properly

Blocked on Meta app review. The API client is already written; the real work is
**rendering legible text onto carousel slides**, which needs a deterministic
rasteriser, not an image model.

| Approach | Cost | Trade-off |
|---|---|---|
| `satori` + `resvg-wasm` in the Worker | Free | CPU-heavy against 10 ms. Likely one Worker per slide, or a paid plan |
| Cloudflare Browser Rendering | Paid | HTML/CSS → PNG. The correct tool, if you'll leave the free tier |
| Render locally, upload to R2 | Free | Breaks the "no laptop" property that makes v1 work |
| Ask FLUX to render slide text | Free | **Rejected.** ~1 in 5 unusable. Unacceptable for a teaching format |

Build the SVG template generator first and validate it locally. The template is
the hard part; where it runs is a deployment detail.

Also: a Researcher variant tuned for visual explanation, carousel-shaped Writer
output, IG publish cron wired to real drafts.

## v1.2 — closing the loop

Right now the system has no idea whether any of this works. That's the largest
gap in v1, and it's deliberate — measuring nothing beats measuring the wrong
thing.

- [ ] Pull LinkedIn post analytics into `posts.metrics`
- [ ] Weekly Telegram digest: what travelled, what didn't
- [ ] Correlate performance against post **shape** (debugging story vs benchmark
      vs client outcome). This is the one analysis likely to change what you write
- [ ] Correlate against seed `kind` — do client-outcome posts actually generate
      enquiries, or just fewer impressions?
- [ ] Track **rejection rate**. Below 20%, the digest should tell you the gate
      has become decorative

## v2 — ideas, unranked and uncommitted

Recorded so they stop occupying attention, not because they're planned.

- **Seed capture from git.** A post-commit hook offering to file a seed when a
  commit message runs past three lines. Lowers friction on the one input only
  you can provide.
- **Style-ref evolution.** Promote high-performing images into `style_refs` so
  the visual identity drifts toward what works.
- **Threads.** Meta's text-first platform; the API is a sibling of Instagram's
  (`th_refresh_token`). Closest thing to a free extra platform, and unlike
  Instagram it accepts text.
- **A correction trigger.** When retrieval surfaces something contradicting a
  post you published, draft a follow-up. Correction posts are rare and
  disproportionately credible.
- **Client case-study generator.** Given a delivered project, produce a
  Company Page post plus a portfolio entry. Directly serves the freelance goal.

## Explicitly rejected

| Idea | Why not |
|---|---|
| Auto-publish without approval | The entire premise. A fabricated claim under your name is permanent |
| Cross-posting identical content | Performs worse on both. Share the seed, not the post |
| Comment / DM / connection automation | Enforced against, and it's spam — visible to the people you're trying to impress |
| Engagement pods | Detected; reputational downside exceeds reach gain |
| Scraping either platform | The line between an integration and a bot |
| More than ~4 posts/week | Volume doesn't buy distribution. It buys a public record of low-effort output |
| "Available for hire" in post copy | Costs you inbound from full-time employers. Availability belongs in the profile field |
| A third-party "Data API" replacement for Atlas | Putting posting credentials behind a vendor whose predecessor was just shut down |

## Open questions

Resolve with measurement, not argument.

1. **Does the Atlas cold connect plus the base64 decode fit in 10 ms?** The
   most consequential unknown in the project. The spike answers half of it;
   the dashboard answers the rest.
2. **Is `gpt-oss-20b` good enough at the Writer's voice constraints?** The
   banned-phrase list is a crutch for a weak model. If it fights you,
   `llama-4-scout-17b` or `gemma-4-26b` cost more neurons — and you have ~80
   images/day of spare budget to trade.
3. **Does the 07:00 → 09:00 approval window match how you actually live?** Two
   weeks of data will tell you.
4. **Is the unverified-claim check too noisy to be useful?** If you start
   ignoring the ⚠️ line, it's worse than not having it.
5. **Does grounding actually improve performance?** Compare grounded posts
   against seed-only ones. It's genuinely plausible the seed-only posts do
   better — your own experience is the scarcer input.
6. **Do client-outcome posts produce enquiries?** If not after three months,
   the freelance channel is Upwork and outreach, not LinkedIn, and the mix
   should go back to 100% depth posts.

## Risks

| Risk | Likelihood | Impact | Response |
|---|---|---|---|
| LinkedIn rejects the Company Page or app | Low | **Fatal to v1** | Discover it in week 0, before building |
| Atlas hot path too slow / too CPU-costly | **Medium** | Rework | Spike first. Hybrid fallback is one file |
| Meta app review rejected | Medium | Kills v1.1 only | LinkedIn unaffected |
| Free tier changes underneath you | Medium | Varies | Tier 0 sources are keyless and can't be repriced. Workers AI is the main exposure |
| CPU limit blocks image generation | Medium | Degraded | Documented mitigation ladder in [07](07-operations.md) |
| **Seed queue stays empty** | **High** | **Fatal in practice** | No technical fix exists |
| Posts perform badly despite all this | Medium | Demoralising | v1.2 exists to answer it. Grounding and review raise the floor; nothing guarantees the ceiling |
| Freelance leads never materialise | **Medium-high** | Goal partially unmet | Expected in year one. LinkedIn compounds; it doesn't prospect. Keep Upwork and outreach running |

The last three are the real ones. Everything above them is engineering, and
engineering problems have solutions. An empty seed queue, a bored audience, and
a channel that takes a year to pay off do not.
