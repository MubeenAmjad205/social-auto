# Mastodon setup

Maps to `src/mastodon.ts`. No OAuth flow, no callback route — simpler than
even Bluesky in one way: the access token doesn't expire.

## 1. Pick your instance

If you don't already have a Mastodon account, join any instance —
`mastodon.social` is the default/largest, but any instance works
identically for this project. Note the instance's URL; you'll need it
below.

## 2. Create an Application and get a token

On your instance, go to **Settings → Development → New Application**:
- Name it anything (e.g. `social-worker`)
- Scopes: at minimum check **`write:statuses`** (for posting) and
  **`write:media`** (for image uploads) — uncheck everything else you
  don't need
- Submit

You'll land on the application's detail page, which shows **Your access
token** directly — no redirect flow, no authorization code exchange. This
is the one because you're creating the app while logged in as yourself;
Mastodon hands you a working user token in the same screen.

**This token does not expire** by default. No refresh cron entry exists
in `src/index.ts`'s `health()` for Mastodon because none is needed.

## 3. Set the secrets

```bash
wrangler secret put MASTODON_ACCESS_TOKEN
```

And in `wrangler.jsonc`, set the (non-secret) instance URL:

```jsonc
"MASTODON_INSTANCE_URL": "https://mastodon.social",   // or whatever your instance is
```

Mastodon is federated — there's no single API host the way
`graph.instagram.com` is for Instagram. Every API call in
`src/mastodon.ts` goes to whatever you put here.

## 4. Turn it on

Add `mastodon` to `ENABLED_PLATFORMS` in `wrangler.jsonc`:

```jsonc
"ENABLED_PLATFORMS": "linkedin,instagram,mastodon",
```

Redeploy. Done.

## Character limit

Mastodon's default is 500 characters, but individual instances can (and
some do) raise it. `MASTODON_MAX_CHARS` in `wrangler.jsonc` defaults to
`"500"` — bump it if your instance allows more. As with Bluesky, the
generated draft is truncated to this limit *before* you see it in
Telegram, so approval reflects exactly what gets published.

## Troubleshooting

| Symptom | Cause |
|---|---|
| 401 on every call | Token scope missing `write:statuses` — recreate the application with the right scopes checked |
| Image upload succeeds, post fails | Rare — check `MASTODON_INSTANCE_URL` doesn't have a trailing slash (the code strips one if present, but worth checking if debugging) |
| Post looks cut off | Working as intended past `MASTODON_MAX_CHARS` |
