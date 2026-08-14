# 07 — Operations

## Setup, in dependency order

You are starting from zero. Steps 1–3 are not code and can run in parallel with
everything else. Do them first.

| # | Step | Blocks | Time |
|---|---|---|---|
| 1 | **Submit the Meta app review** for `instagram_business_content_publish` | Instagram (v1.1) | **2–4 weeks** — start today |
| 2 | Create + verify a **LinkedIn Company Page** (this is also your freelance storefront) | Everything LinkedIn | Same day |
| 3 | LinkedIn app → verify → request **"Share on LinkedIn"** | LinkedIn publishing | Hours–days |
| 4 | **Run `spike/atlas-check.ts`** | The whole data layer | **1 hour** |
| 5 | Atlas M0 cluster, DB user scoped to `social` only, 32-char generated password | | 10 min |
| 6 | Atlas Network Access → `0.0.0.0/0` (see security note) | | 1 min |
| 7 | `wrangler r2 bucket create social-media` → **make it publicly readable** | Instagram media | 5 min |
| 8 | Telegram: `@BotFather` → bot token; chat id from `@userinfobot` | Approval gate | 5 min |
| 9 | Generate `TOKEN_KEY`: `openssl rand -base64 32` | **Token encryption** | 1 min |
| 10 | `wrangler secret put …` for every secret below | | 5 min |
| 11 | `wrangler deploy` | | |
| 12 | Run `src/migrate.ts` once to create indexes | | 1 min |
| 13 | Set the Telegram webhook to `https://…/tg/<WEBHOOK_SECRET>` | | 1 min |
| 14 | Visit `/auth/linkedin`, click Allow | | 30 s |
| 15 | **Bank 5–10 real seeds** | **Everything** | 10 min |

**Step 4 gates everything.** If the spike fails, you switch to the hybrid
fallback ([02](02-architecture.md)) before writing pipeline code, not after.

**Step 9 is not optional.** Generate the key *before* step 14, because that is
when the first token gets written. Retrofitting encryption means re-authing.

## Secrets

Never in `wrangler.jsonc`. Always `wrangler secret put`.

```
MONGODB_URI              non-SRV multi-host string
TOKEN_KEY                base64, 32 bytes — encrypts tokens at rest
LINKEDIN_CLIENT_ID
LINKEDIN_CLIENT_SECRET
IG_USER_ID
GITHUB_PAT               raises the GitHub search limit to 5,000/hr
TAVILY_API_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
WEBHOOK_SECRET           unguessable path segment for the Telegram webhook
```

**If a key has ever appeared in a file, a chat, a repo, or a screenshot, treat
it as compromised and rotate it.** Exported workflow JSON is a notorious leak
vector — n8n and similar tools embed header values, including bearer tokens,
directly in the export.

## Schedule

All crons are **UTC**. Cloudflare has no timezone field. You are UTC+5 (PKT) —
subtract 5 from your intended local time.

| Cron (UTC) | Local (PKT) | Job |
|---|---|---|
| `0 2 * * *` | 07:00 | Generate draft → Telegram |
| `0 4 * * *` | 09:00 | Publish approved LinkedIn |
| `0 9 * * *` | 14:00 | Publish approved Instagram (v1.1) |
| `0 22 * * *` | 03:00 | Token health + seed-queue check |

Free plan: 5 Cron Triggers per account. Four used, one spare.

The two-hour gap between generate and publish is your window to tap. If you're
routinely missing it, move generate earlier rather than publish later.

## Quota dashboard

Check monthly. Numbers are daily burn at 1 post/day.

| Resource | Limit | Use | Where |
|---|---|---|---|
| Workers requests | 100k/day | ~10 | Workers dashboard |
| Workers CPU | 10 ms/invocation | **see below** | Metrics → Errors → Exceeded CPU |
| Subrequests | 50 external/invocation | ~15 | — |
| Workers AI neurons | 10,000/day (00:00 UTC reset) | ~120 | **Workers AI dashboard** |
| R2 storage | 10 GB-month | ~15 MB/mo | R2 dashboard |
| Tavily credits | 1,000/month | ~30/mo | Tavily console |
| Atlas M0 | 512 MB | negligible | Atlas |
| IG publish cap | rolling — query it | 1 | `GET /<IG_ID>/content_publishing_limit` |

The only quota you'll plausibly hit is **CPU**. Everything else has 10×+
headroom.

## Failure modes

Ordered by likelihood.

### 1. Silent cron death — the most dangerous

Cron Triggers **do not retry**. A thrown exception means the run is skipped
until the next tick, and Cloudflare sends you nothing.

*Mitigation:* every cron body is wrapped; every catch posts to Telegram. **A
weekday with no 07:00 message is itself the alarm.** Add a weekly heartbeat so
silence is always meaningful.

### 2. Empty seed queue

Not a bug — the system correctly refuses to invent material.

*Mitigation:* the nightly cron warns when the queue drops below 3. Add seeds by
texting the bot. Keep 5–10 banked.

### 3. Atlas connection failure or CPU blowout

New with the all-Atlas decision. Symptoms: timeouts, or "Exceeded CPU limit"
on runs that used to pass.

*Mitigation:* re-run the spike to isolate. If the handshake is the cost, switch
to the hybrid fallback — the `Store` interface makes it a one-file change.

### 4. LinkedIn token expired

401 on publish. Predictable to the day.

*Mitigation:* nightly check nags at T-10 days with a one-tap link. If you miss
it entirely, drafts accumulate as `approved` and publish once you re-auth.
Nothing is lost.

### 5. Exceeded CPU limit on image generation

Workers AI image models return a base64 string, not a stream — the decode is
unavoidable.

*Mitigation, in order:* `Uint8Array.fromBase64` (runtime-native, far cheaper
than the `atob` loop) → generate at 768×768 → move image generation into its
own Worker behind a service binding for a fresh 10 ms budget.

### 6. Instagram "Only photo or video can be accepted as media type"

Almost always the URL, not the image. Check in order: is the bucket public?
does the URL return raw JPEG rather than HTML or a redirect? is robots.txt
blocking Meta's crawler? is the file under 8 MB?

### 7. `LinkedIn-Version` sunset

`/rest/*` starts failing after a version retirement.

*Mitigation:* bump `LINKEDIN_VERSION`, redeploy. Quarterly calendar reminder.

### 8. Duplicate post

A publish that timed out but actually succeeded, then retried.

*Mitigation:* unique index on `idempotency_key`, and `attempts` increments
**before** the network call.

## Monitoring

There is no dashboard, and building one is scope creep. Three signals:

1. **Telegram is the monitor.** Every generate, publish and failure reports
   there. Quiet on a weekday means something is wrong.
2. **`runs` collection** holds per-step timings, source counts and neuron
   estimates. Query it when Telegram says something failed and you want to know
   where.
3. **Workers AI dashboard** for neuron burn. Monthly. Climbing without a
   cadence change means something is retrying.

## Security posture

| Asset | Exposure | Control |
|---|---|---|
| **OAuth tokens** | Can post as you for 60 days | **AES-GCM encrypted at rest.** Key only in `wrangler secret`. Never logged, never in env vars |
| Atlas cluster | Open to `0.0.0.0/0` by necessity | DB user scoped to `social` only; 32-char generated password; token encryption above makes a dump non-fatal |
| Telegram webhook | URL holder can approve drafts | Unguessable secret path segment. Rotate if leaked |
| R2 public bucket | Publicly readable by design | Generated images only. Nothing sensitive |
| Worker source | Public deploy | No secrets in code |

**The tokens are the crown jewels.** Anything that widens their exposure — a
token in a log line, a key in an exported config, an unencrypted database
reachable from the internet — is a larger risk than every reach penalty
discussed in these docs combined.

## Runbook

**Add a seed** → text the bot `/seed <what happened>` or `/seed client <what happened>`

**Reject an image, keep the copy** → tap 🎲. Costs ~104 neurons of 10,000. Do
it twenty times a day for free.

**Publish off-schedule** → approve it; it goes at the next publish cron. There
is deliberately no "publish now" path. The delay is a feature.

**Pause everything** → comment out the crons and redeploy, or disable the
Worker in the dashboard. Approved drafts wait.

**Change the visual identity** → replace `style_refs` with three new approved
images, each under 512×512.

**Rotate a leaked secret** → revoke at the provider, `wrangler secret put` the
new value, redeploy. For LinkedIn, re-run `/auth/linkedin`.

**Rotate `TOKEN_KEY`** → decrypt with the old key, re-encrypt with the new, or
simply re-auth both platforms. Re-auth is easier.
