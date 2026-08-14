# LinkedIn setup

Everything here maps directly to `src/linkedin.ts` and the `LINKEDIN_*`
entries in `wrangler.jsonc` / your secrets. Cross-reference: docs/06-platform-apis.md.

## What this account actually does

Posts go to **your personal profile**, not the Company Page. The Page below
is only a LinkedIn platform requirement for *registering an app* — it never
appears in the publishing path. See docs/01 for why the Page is worth
building out anyway (it's your freelance storefront), but nothing here
blocks on that.

## 1. Company Page

`linkedin.com/company/setup/new/` → create a Page, become its admin. Done
once you have one — no further action needed for the API to work.

## 2. Developer app

`linkedin.com/developers/apps` → **Create app**:
- Name it anything (e.g. "social-worker")
- **LinkedIn Page**: select the Page from step 1 — mandatory, the app cannot exist without it
- Upload a logo, accept the agreement, create

## 3. Verify the app

**Settings** tab → **Verify** → generates a link. You're the Page admin, so
you click it yourself. ~1 minute.

## 4. Request products

**Products** tab → request both:

| Product | Grants | Why the code needs it |
|---|---|---|
| **Share on LinkedIn** | `w_member_social` | The actual publish permission — `POST /rest/posts` in `src/linkedin.ts` |
| **Sign In with LinkedIn using OpenID Connect** | `openid`, `profile` | `GET /v2/userinfo` in `handleLinkedInCallback` — fetches your `sub`, which becomes `urn:li:person:<sub>`, the `author` field on every post |

Both are usually auto-approved instantly for personal use. If you only
request the first, OAuth will fail at the `/v2/userinfo` call.

## 5. Auth tab

- Copy **Client ID** and **Client Secret**
- Add an **OAuth 2.0 redirect URL**. It must **exactly** match
  `LINKEDIN_REDIRECT_URI` in `wrangler.jsonc`:
  `https://social-worker.<your-subdomain>.workers.dev/auth/linkedin/callback`
  — find your subdomain with `npx wrangler whoami` or the Cloudflare
  dashboard (Workers & Pages → your account → subdomain). If you deploy
  before you know it, come back and fix both places once you do; nothing
  else depends on getting this right on the first try.

## 6. Set the secrets

Run these yourself — don't paste real values into a chat:

```bash
wrangler secret put LINKEDIN_CLIENT_ID
wrangler secret put LINKEDIN_CLIENT_SECRET
```

Or drop them into `secrets.json` / `.dev.vars` (gitignored) and run
`npm run secrets:push`.

## 7. Update wrangler.jsonc

- `LINKEDIN_REDIRECT_URI` — the real URL from step 5
- `LINKEDIN_VERSION` — format `YYYYMM`. Already set to `202608`; LinkedIn
  sunsets versions on a rolling basis, so bump this quarterly and redeploy.
  Omitting this header entirely makes every `/rest/*` call fail outright.

## 8. Authorize

`npm run deploy`, then visit `https://<your-worker>/auth/linkedin` in a
browser and click **Allow**. `handleLinkedInCallback` exchanges the code,
fetches your `sub`, encrypts the token (`src/secrets.ts`), and stores it —
you'll see "LinkedIn connected. You can close this tab."

What's happening under the hood, in case something fails partway:
- `startLinkedInAuth` sets a short-lived HttpOnly `state` cookie and redirects to LinkedIn
- The callback checks the returned `state` against that cookie before doing anything else (CSRF guard) — a mismatch returns 400 with "restart at /auth/linkedin"
- Token, expiry, and `member_urn` get written via `store.saveToken('linkedin', …)`, encrypted before Atlas ever sees them

## Token lifecycle

**60 days, no refresh token** — standard "Share on LinkedIn" apps never get
one; only Marketing Developer Platform partners do. This can't be
automated, only reduced to one tap:

- The 03:00 PKT health cron (`0 22 * * *`) checks `tokens.linkedin.expires_at`
  nightly and, at T-10 days, sends a Telegram message with a direct link to
  `/auth/linkedin`
- Miss it entirely and the token just expires — publish attempts start
  failing with 401, drafts pile up as `approved`, and nothing is lost. Visit
  `/auth/linkedin` whenever you notice and everything queued goes out on the
  next publish cron.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `/rest/*` calls fail outright | Missing or stale `LINKEDIN_VERSION` header |
| 400 "invalid or missing OAuth state" | Cookie didn't round-trip (blocked cookies, or you opened the auth link in a different browser/context than the callback) — just restart at `/auth/linkedin` |
| Callback succeeds but publish 401s | Token expired — re-visit `/auth/linkedin` |
| Post URN missing | It's in the `x-restli-id` **response header**, not the JSON body — already handled in `publishLinkedIn`, but relevant if you're debugging with curl |
| initializeUpload fails | Check `member_urn` was actually saved — inspect the `tokens` collection in Atlas |
