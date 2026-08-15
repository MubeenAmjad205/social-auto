/**
 * src/telegram.ts — the approval gate and the entire user interface.
 *
 * This is the single most valuable component in the system. It is the
 * difference between a drafting assistant and an autopilot that publishes a
 * hallucinated statistic under your own name at 4am.
 */

import type { Env } from './index';
import { renderImage } from './generate';
import { renderAndUploadCarousel } from './instagram-generate';
import { sendFallbackEmail } from './email';
import { generateCaseStudy } from './casestudy';

const api = (env: Env, method: string) =>
  `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;

/**
 * Telegram is the entire monitoring channel — if a send silently fails
 * (bad token, Telegram outage, chat blocked), the previous version of this
 * function had no way of knowing or telling you. It now checks the actual
 * response and falls back to email — a genuine no-op if GMAIL_USER/
 * GMAIL_APP_PASSWORD/ALERT_EMAIL_TO aren't set, see src/email.ts.
 */
export async function notify(env: Env, text: string) {
  const res = await fetch(api(env, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  }).catch(() => null);

  if (!res || !res.ok) {
    await sendFallbackEmail(env, 'Telegram delivery failed', text).catch(() => {});
  }
}

/**
 * Announces a fresh publish, and for LinkedIn offers a one-tap way to feed
 * that image back into the visual identity — the only piece of state that
 * previously required editing Atlas directly instead of tapping a button.
 */
export async function notifyPublished(
  env: Env,
  d: { platform: string; remoteId: string; draftId: string; offerStyleRef: boolean }
) {
  await fetch(api(env, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: `✅ published to ${d.platform}\n${d.remoteId}`,
      reply_markup: d.offerStyleRef
        ? { inline_keyboard: [[{ text: '⭐ Save image as style ref', callback_data: `styleref:${d.draftId}` }]] }
        : undefined,
    }),
  });
}

/**
 * A network failure with no response is genuinely ambiguous (see
 * src/errors.ts) — the draft goes to 'failed' without auto-retrying, and
 * this message is how you get it moving again after checking the platform
 * yourself. Without this button, un-stuck-ing it meant editing Atlas by
 * hand, which is exactly the "Telegram is the entire interface" principle
 * this button restores.
 */
export async function notifyAmbiguousFailure(
  env: Env,
  d: { platform: string; draftId: string; message: string }
) {
  await fetch(api(env, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: `🔴 ${d.platform} publish hit an AMBIGUOUS network error — it may have already posted.\n` +
            `Check ${d.platform} manually first.\n\n${d.message}`,
      reply_markup: {
        inline_keyboard: [[
          { text: '🔁 Confirmed not posted — retry', callback_data: `retry:${d.draftId}` },
        ]],
      },
    }),
  });
}

/**
 * Shared by the single-image (LinkedIn) and carousel (Instagram) approval
 * flows. Sent as its own sendMessage rather than folded into a photo caption
 * — Telegram caps photo captions at 1024 chars, and a post near the docs'
 * own 120-200 word target plus a couple of editor flags can exceed that.
 * A silently truncated post shown for approval defeats the point of the
 * approval step: you can only vet what you can actually read.
 */
async function sendApprovalControls(
  env: Env,
  d: { id: string; label: string; body: string; flags: string[]; sourceCount: number }
) {
  const header = d.flags.length ? d.flags.map(f => `⚠️ ${f}`).join('\n') + '\n\n' : '';
  const provenance = d.sourceCount > 0
    ? `\n\n_grounded in ${d.sourceCount} source(s)_`
    : `\n\n_seed-only — no external claims_`;

  await fetch(api(env, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: `${header}*${d.label}*\n\n${d.body}${provenance}`.slice(0, 4096),
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Approve', callback_data: `ok:${d.id}` },
          { text: '🎲 Redraw',  callback_data: `redraw:${d.id}` },
          { text: '🗑 Reject',  callback_data: `no:${d.id}` },
        ]],
      },
    }),
  });
}

export async function sendDraftForApproval(
  env: Env,
  d: { id: string; platform: string; body: string; flags: string[]; sourceCount: number; imageUrl: string }
) {
  // Photo goes out unencumbered by a caption — the text and buttons live in
  // the message sendApprovalControls sends next, where nothing gets cut off.
  await fetch(api(env, 'sendPhoto'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, photo: d.imageUrl }),
  });

  await sendApprovalControls(env, { id: d.id, label: d.platform, body: d.body, flags: d.flags, sourceCount: d.sourceCount });
}

/**
 * Telegram's sendMediaGroup (the actual "album" UI) does not support inline
 * keyboards — a Bot API limitation, not an oversight here. So: the slides go
 * out as a plain album for a fast visual scan, immediately followed by the
 * shared approval-controls message. Two messages, one decision.
 */
export async function sendCarouselForApproval(
  env: Env,
  d: { id: string; body: string; flags: string[]; sourceCount: number; imageUrls: string[] }
) {
  await fetch(api(env, 'sendMediaGroup'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      media: d.imageUrls.slice(0, 10).map((url, i) => ({
        type: 'photo',
        media: url,
        ...(i === 0 ? { caption: `Slide 1 of ${d.imageUrls.length}` } : {}),
      })),
    }),
  });

  await sendApprovalControls(env, { id: d.id, label: 'instagram carousel', body: d.body, flags: d.flags, sourceCount: d.sourceCount });
}

/**
 * The webhook URL's secret path segment keeps random strangers from finding
 * it, but that alone doesn't verify WHO is talking to it once they do — a
 * leaked bot username, or the bot ever being added to a group, would let
 * anyone approve or reject drafts under your name. This is the actual
 * authorization check; the URL secret is only obscurity on top of it.
 *
 * Checks `callback_query.from.id` (who pressed the button) before falling
 * back to `callback_query.message.chat.id` — `message` is documented by
 * Telegram as optional on a callback_query (absent for old/inaccessible
 * messages), while `from` is always present. Checking `message.chat.id`
 * only would incorrectly reject a legitimate tap on a stale message.
 */
function isAuthorized(update: any, env: Env): boolean {
  const chatId = update.callback_query?.from?.id
    ?? update.callback_query?.message?.chat?.id
    ?? update.message?.chat?.id;
  return chatId != null && String(chatId) === String(env.TELEGRAM_CHAT_ID);
}

export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  const update = await request.json<any>();

  if (!isAuthorized(update, env)) {
    // Answer callback queries even when unauthorized so the sender's Telegram
    // client doesn't show a stuck "loading" state, but do nothing else.
    if (update.callback_query) {
      await fetch(api(env, 'answerCallbackQuery'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: update.callback_query.id }),
      }).catch(() => {});
    }
    return new Response('ok');
  }

  const { storeFor } = await import('./index');
  const store = storeFor(env);

  try {
    // ---- button taps
    if (update.callback_query) {
      const cb = update.callback_query;
      const [action, draftId] = String(cb.data).split(':');
      const draft = await store.getDraft(draftId);
      let responseText: string = action;

      // styleref and retry have their own validity rules (checked below);
      // everything else — ok/redraw/no — only makes sense while a draft is
      // still 'pending'. Without this guard, a stale button on an old
      // Telegram message (the operator taps Approve on a draft that a LATER
      // tap already published, rejected, or that a cron already failed)
      // would silently re-mutate a draft that's already been resolved — an
      // Approve on an already-published draft gets picked up as duplicate
      // work by the very next publish cron. This is the guard against that.
      if (action === 'styleref') {
        if (draft?.image_key) {
          await store.addStyleRef(draft.image_key);
          responseText = 'Saved as style ref';
        } else {
          responseText = 'Nothing to save — image missing';
        }
      } else if (action === 'retry') {
        if (draft?.status === 'failed') {
          await store.setStatus(draftId, 'approved');
          responseText = 'Requeued for the next publish run';
        } else {
          responseText = draft ? `Draft is ${draft.status}, not failed — nothing to retry` : 'Draft not found';
        }
      } else if (!draft) {
        responseText = 'Draft not found — may have been cleaned up';
      } else if (draft.status !== 'pending') {
        responseText = `Already ${draft.status} — ignoring stale button`;
      } else if (action === 'redraw') {
        // Regenerating is cheap: ~104 neurons of a 10,000/day allowance.
        // You can reject an image ninety times a day and pay nothing.
        // Regenerate and resend immediately rather than nulling image_key
        // and waiting for a future run to notice — nothing else ever would.
        if (draft.platform === 'instagram' && draft.image_keys) {
          const slides = JSON.parse(draft.image_prompt);
          const imageKeys = await renderAndUploadCarousel(env, slides);
          await store.setStatus(draftId, draft.status, { image_key: imageKeys[0] ?? null, image_keys: imageKeys });
          await sendCarouselForApproval(env, {
            id: draftId,
            body: draft.body,
            flags: draft.editor_flags,
            sourceCount: draft.facts.length,
            imageUrls: imageKeys, // already public URLs — see renderAndUploadCarousel
          });
        } else {
          const imageKey = await renderImage(env, store, draft.image_prompt);
          await store.setStatus(draftId, draft.status, { image_key: imageKey });
          await sendDraftForApproval(env, {
            id: draftId,
            platform: draft.platform,
            body: draft.body,
            flags: draft.editor_flags,
            sourceCount: draft.facts.length,
            imageUrl: imageKey, // already a public URL — see src/generate.ts's renderImage
          });
        }
        responseText = 'New image sent';
      } else if (action === 'no') {
        await store.setStatus(draftId, 'rejected');
        // A rejected ANGLE doesn't mean the underlying material was bad —
        // give the seed back rather than burning it permanently. See
        // src/store.ts's nextSeed/returnSeed for the other half of this.
        await store.returnSeed(draft.seed._id);
        responseText = 'Rejected — seed returned to the queue';
      } else if (action === 'ok') {
        await store.setStatus(draftId, 'approved');
        responseText = 'Queued for the next publish run';
      }

      await fetch(api(env, 'answerCallbackQuery'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cb.id, text: responseText }),
      });
      return new Response('ok');
    }

    const text: string = update.message?.text ?? '';

    // ---- /seed — the one input only you can provide
    // Optional angle: `/seed <note> | angle: <the takeaway>`
    if (text.startsWith('/seed')) {
      const rest = text.replace(/^\/seed\s*/, '').trim();
      const isClient = rest.startsWith('client ');
      const body = isClient ? rest.slice(7).trim() : rest;
      const [note, angle] = body.split(/\s*\|\s*angle:\s*/i);

      if (!note) {
        await notify(env, 'Usage:\n`/seed <what happened>`\n`/seed client <what happened>`\n`/seed <what happened> | angle: <the takeaway>`');
      } else {
        await store.addSeed(note.trim(), isClient ? 'client' : 'own', angle?.trim());
        const n = await store.seedCount();
        await notify(env, `🌱 Seed banked (${isClient ? 'client' : 'own'}). ${n} in the queue.`);
      }
      return new Response('ok');
    }

    // ---- /pending — what's waiting on you right now, without waiting for
    // the next scheduled message
    if (text.startsWith('/pending')) {
      const drafts = await store.listActive(10);
      if (!drafts.length) {
        await notify(env, '📭 Nothing pending or approved right now.');
      } else {
        const lines = drafts.map(d =>
          `\`${d._id.slice(0, 8)}\` ${d.status} · ${d.platform} · ${d.body.slice(0, 60).replace(/\n/g, ' ')}…`
        );
        await notify(env, `📋 ${drafts.length} active draft(s):\n\n${lines.join('\n')}`);
      }
      return new Response('ok');
    }

    if (text.startsWith('/status')) {
      const n = await store.seedCount();
      const last = await store.lastRun();
      const lastLine = last
        ? `\nLast run: \`${last.cron}\` ${last.ok ? '✅' : '🔴'} ${new Date(last.started_at).toISOString()}`
        : '\nNo runs logged yet.';
      await notify(env, `🌱 ${n} unused seed(s) in the queue.${lastLine}`);
      return new Response('ok');
    }

    // ---- /casestudy — writes a Company Page post from a delivered
    // project's description. Doesn't touch a seed, doesn't publish anywhere
    // (Company Page publishing needs Marketing Developer Platform approval
    // this project doesn't have) — the text comes back over Telegram for
    // you to paste yourself. See src/casestudy.ts.
    if (text.startsWith('/casestudy')) {
      const description = text.replace(/^\/casestudy\s*/, '').trim();
      if (!description) {
        await notify(env, 'Usage:\n`/casestudy <what you delivered, for who, what it cost/saved>`');
      } else {
        const post = await generateCaseStudy(env, description);
        await notify(env, `📄 *Company Page draft* — not auto-published, paste this yourself:\n\n${post}`);
      }
      return new Response('ok');
    }

    return new Response('ok');
  } finally {
    await store.close();
  }
}
