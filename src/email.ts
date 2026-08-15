/**
 * src/email.ts — last-resort email alert via Gmail SMTP.
 *
 * WHY THIS EXISTS: Telegram is the entire monitoring channel for this
 * project (src/telegram.ts's own header comment says so directly). Nothing
 * in the original design covered what happens if a message TO Telegram
 * itself fails to send — a bad bot token, Telegram having an outage, the
 * chat being blocked. notify() in src/telegram.ts now checks the response
 * and calls sendFallbackEmail() when it isn't ok, so a Telegram-shaped
 * failure doesn't mean total silence.
 *
 * Plain `nodemailer` does NOT work in Workers — even with nodejs_compat, its
 * SMTP transport fails at the socket layer. `worker-mailer` is a small SMTP
 * client actually built on `cloudflare:sockets`, which is what makes this
 * work at all.
 *
 * MUST NOT BREAK ANYTHING IF UNCONFIGURED: every exported function here
 * checks for GMAIL_USER + GMAIL_APP_PASSWORD + ALERT_EMAIL_TO up front and
 * silently no-ops if any are missing. No error, no throw, no partial send —
 * email is entirely optional, and a caller that doesn't check the return
 * value should never notice whether it ran.
 */

import type { Env } from './index';

export function emailConfigured(env: Env): boolean {
  return !!(env.GMAIL_USER && env.GMAIL_APP_PASSWORD && env.ALERT_EMAIL_TO);
}

export async function sendFallbackEmail(env: Env, subject: string, text: string): Promise<boolean> {
  if (!emailConfigured(env)) return false;

  try {
    // Imported lazily so a Worker that never configures email never pays
    // for parsing/initializing the library's module graph on cold start.
    const { WorkerMailer } = await import('worker-mailer');

    const mailer = await WorkerMailer.connect({
      credentials: { username: env.GMAIL_USER, password: env.GMAIL_APP_PASSWORD },
      authType: 'plain',
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      startTls: true,
    });

    await mailer.send({
      from: { name: 'social-worker', email: env.GMAIL_USER },
      to: { name: 'alert', email: env.ALERT_EMAIL_TO },
      subject: `[social-worker] ${subject}`,
      text,
    });

    return true;
  } catch {
    // This IS the last resort — there is nowhere further to report a
    // failure of the fallback itself. Swallow it; the caller (notify())
    // already knows Telegram failed too, and that's the signal that
    // actually matters here: both channels down is a "check the Worker
    // logs" situation, not one more notification to fail to deliver.
    return false;
  }
}
