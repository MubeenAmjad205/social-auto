# Email fallback setup (optional)

Maps to `src/email.ts`. **Entirely optional** — skip this file if you're
fine with Telegram being the only monitoring channel, which is the
default and matches the original design.

## Why this exists

Telegram is this project's entire monitoring channel — `src/telegram.ts`
says so directly in its header comment. Nothing in the original design
covered what happens if a message *to* Telegram itself fails to send: a
bad bot token, Telegram having an outage, the bot losing access to the
chat. `notify()` now checks whether that send actually succeeded and, only
if it didn't, tries this as a last resort.

**Plain `nodemailer` does not work in Cloudflare Workers** — its SMTP
transport fails at the socket layer even with `nodejs_compat` enabled. This
uses [`worker-mailer`](https://github.com/zou-yu/worker-mailer) instead, a
small SMTP client actually built on `cloudflare:sockets`, which is what
makes Gmail SMTP work here at all.

## 1. Generate a Gmail App Password

Requires 2-Step Verification enabled on the Gmail account first (Google
won't offer app passwords without it — enable it at
`myaccount.google.com/security` if you haven't).

Then: `myaccount.google.com/apppasswords` → create one, name it
`social-worker`. **This is not your Gmail password** — a scoped credential
you can revoke independently.

## 2. Set the secrets

```bash
wrangler secret put GMAIL_USER            # the full gmail address
wrangler secret put GMAIL_APP_PASSWORD    # the app password from step 1
```

And in `wrangler.jsonc`, the destination address (not a secret — just
where alerts go):

```jsonc
"ALERT_EMAIL_TO": "you@example.com",
```

## That's it — no code change, no redeploy step beyond the secrets

`emailConfigured()` in `src/email.ts` checks all three of
`GMAIL_USER`/`GMAIL_APP_PASSWORD`/`ALERT_EMAIL_TO` before doing anything.
Leave any one unset and the fallback silently no-ops — `notify()` behaves
exactly as it did before, Telegram-only, no error, no partial send.

## What you'll actually receive

Only messages that Telegram itself failed to deliver — not a duplicate of
every notification. On a normal day, running with a valid bot token and an
intact chat, you should never receive an email at all. Getting one is
itself the signal that something is wrong with the primary channel, not
just with the pipeline.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Never receive a fallback email, even when testing | Check all three of `GMAIL_USER`/`GMAIL_APP_PASSWORD`/`ALERT_EMAIL_TO` are actually set — `emailConfigured()` requires all three |
| Gmail rejects the login | 2-Step Verification isn't enabled, or you used your real password instead of an app password |
| Fallback silently doesn't help when Telegram is down | Intentional — see `src/email.ts`'s comment: this is the last resort, and there's nowhere further to report its own failure |
