# Threads setup

Maps to `src/threads.ts`. Same Meta Developer App as Instagram — do
`docs/setup/facebook.md` first if you haven't. This just adds one more
product to that same app.

**Unverified, flagged rather than hidden:** the endpoints in
`src/threads.ts` follow Meta's documented Graph-API-family shape (the same
shape Instagram's API uses, which this project's docs describe as already
tested), but this specific integration hasn't been exercised against a
real Threads account. If something 404s during setup, check Meta's current
Threads API docs before assuming the code itself is wrong in some other
way.

## 1. Add the Threads product

In the same Meta App you created for Instagram (`developers.facebook.com/apps` →
your app) → **Add Product** → find **Threads** → **Set up**.

## 2. Get your App ID and Secret

**App settings → Basic** (or the Threads product's own setup page) → copy
the **App ID** and **App Secret**. These become `THREADS_CLIENT_ID` /
`THREADS_CLIENT_SECRET`.

```bash
wrangler secret put THREADS_CLIENT_ID
wrangler secret put THREADS_CLIENT_SECRET
```

## 3. Add yourself as a tester (same pattern as Instagram)

**Roles → Threads testers** (or wherever the Threads product surfaces it)
→ add your Threads/Instagram account → accept the invite from your phone,
same as the Instagram flow in `docs/setup/facebook.md` step 4.

Threads API publishing scopes require **Tech Provider Verification** for
full production access — a business-entity verification process, not
something built for a solo account. As with Instagram, the tester path
should let you use the full pipeline against your own account without
waiting for that; submit for broader review only if you eventually want
this working for accounts other than your own; which this project never
needs.

## 4. Set the redirect URI

Same screen as step 1 or 2, usually **OAuth redirect URIs**:

```
https://social-worker.<your-subdomain>.workers.dev/auth/threads/callback
```

Matching `THREADS_REDIRECT_URI` in `wrangler.jsonc` exactly.

## 5. Turn it on

```jsonc
"ENABLED_PLATFORMS": "linkedin,instagram,threads",
```

Redeploy, then visit `https://<your-worker>/auth/threads` and approve.
Same CSRF-cookie-guarded OAuth flow as LinkedIn and Instagram — see
`src/threads.ts`.

## Token lifecycle

Same shape as Instagram: a 60-day long-lived token, refreshed nightly and
unconditionally by the `0 22 * * *` health cron once it's more than 24h
old. Fully automatic — no re-auth tap required once connected.

## Character limit

500 characters, enforced (via truncation) at draft-generation time, same
principle as Bluesky and Mastodon — what you approve in Telegram is what
gets published.

## Troubleshooting

| Symptom | Cause |
|---|---|
| 400 "invalid or missing OAuth state" on callback | Same CSRF cookie guard as LinkedIn/Instagram — restart at `/auth/threads` |
| Container never reaches FINISHED | Check the image URL is actually publicly reachable, same class of issue as Instagram's R2/robots.txt checklist in `docs/setup/instagram.md` |
| Endpoint 404s | This file's top warning — verify against Meta's current Threads API docs, the API has shipped fast in 2026 |
