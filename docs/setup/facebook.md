# Facebook / Meta Developer App setup

**This project never publishes to Facebook.** There's no Facebook Page
posting anywhere in the code. This guide exists because the app that hosts
Instagram's API — the one you actually need — lives inside Meta's developer
console, which everyone still calls "the Facebook app." This is the
container; `docs/setup/instagram.md` is what you actually do with it.

## Why this step exists at all

Instagram's API isn't a standalone product — permissions, tokens, and app
review are all attached to a **Meta App**. `INSTAGRAM_CLIENT_ID` /
`INSTAGRAM_CLIENT_SECRET` (used in `src/instagram.ts`'s OAuth flow) are this
app's credentials, not anything Instagram-specific on their own.

## 1. Create the Meta App

`developers.facebook.com/apps` → **Create App**:
- Use case: **Other** (or **Business**, if offered — either works; you're
  not using any Business-Suite-specific features)
- App type: **Business**
- Name it, attach a contact email, create

## 2. Add the Instagram product

In the app dashboard sidebar → **Add Product** → find **Instagram** → **Set up**.

You'll be offered two integration paths. **Pick "API setup with Instagram
login"** — not "API setup with Facebook Login for Business". Doc 06's
reasoning: Facebook Login is for managing many linked accounts through a
Page; Instagram Login is direct and simpler for one account, which is all
this project ever needs. `src/instagram.ts`'s OAuth flow
(`startInstagramAuth`) is built specifically against the Instagram Login
endpoints (`www.instagram.com/oauth/authorize`, `api.instagram.com/oauth/access_token`)
— the Facebook Login path uses different endpoints entirely and will not
work with that code as written.

## 3. Get your App ID and Secret

Still on the Instagram product's setup page (or **App settings → Basic**):
copy the **Instagram App ID** and **Instagram App Secret**. These are
`INSTAGRAM_CLIENT_ID` / `INSTAGRAM_CLIENT_SECRET` — set them the same way as
the LinkedIn secrets:

```bash
wrangler secret put INSTAGRAM_CLIENT_ID
wrangler secret put INSTAGRAM_CLIENT_SECRET
```

## 4. Add yourself as an Instagram tester

**Roles → Instagram testers** (or similar, under the Instagram product) →
add your Instagram account's username → send the invite.

Then, from your **phone**, open the Instagram app → Settings → **Apps and
websites** → **Tester invites** → accept it.

This step matters more than it looks: per docs/06's traps table,
**development mode only touches accounts added as Testers/Admins until app
review passes.** Since this project only ever posts to your own account,
and you just added it as a tester, **you don't have to wait for review to
start using this end-to-end** — review only matters for opening the app to
users who aren't testers, which will never apply here. Submit the review
anyway (docs/setup/instagram.md covers it) since tester status is a
development-mode convenience, not a long-term guarantee, but don't block on
it.

## 5. Set the redirect URI

Same screen as step 2 or 3, usually labelled **OAuth redirect URIs**: add

```
https://social-worker.<your-subdomain>.workers.dev/auth/instagram/callback
```

matching `INSTAGRAM_REDIRECT_URI` in `wrangler.jsonc` exactly — same
requirement as LinkedIn's redirect URI.

## Next

`docs/setup/instagram.md` — permissions, the Professional-account
requirement, and the actual `/auth/instagram` flow.
