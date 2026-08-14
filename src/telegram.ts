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

const api = (env: Env, method: string) =>
  `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;

export async function notify(env: Env, text: string) {
  await fetch(api(env, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });
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
 */
function isAuthorized(update: any, env: Env): boolean {
  const chatId = update.callback_query?.message?.chat?.id ?? update.message?.chat?.id;
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

      if (action === 'redraw') {
        // Regenerating is cheap: ~104 neurons of a 10,000/day allowance.
        // You can reject an image ninety times a day and pay nothing.
        // Regenerate and resend immediately rather than nulling image_key
        // and waiting for a future run to notice — nothing else ever would.
        const draft = await store.getDraft(draftId);
        if (draft?.platform === 'instagram' && draft.image_keys) {
          const slides = JSON.parse(draft.image_prompt);
          const imageKeys = await renderAndUploadCarousel(env, slides);
          await store.setStatus(draftId, draft.status, { image_key: imageKeys[0] ?? null, image_keys: imageKeys });
          await sendCarouselForApproval(env, {
            id: draftId,
            body: draft.body,
            flags: draft.editor_flags,
            sourceCount: draft.facts.length,
            imageUrls: imageKeys.map(k => `${env.PUBLIC_R2_BASE}/${k}`),
          });
        } else if (draft) {
          const imageKey = await renderImage(env, store, draft.image_prompt);
          await store.setStatus(draftId, draft.status, { image_key: imageKey });
          await sendDraftForApproval(env, {
            id: draftId,
            platform: draft.platform,
            body: draft.body,
            flags: draft.editor_flags,
            sourceCount: draft.facts.length,
            imageUrl: `${env.PUBLIC_R2_BASE}/${imageKey}`,
          });
        }
      } else if (action === 'styleref') {
        const draft = await store.getDraft(draftId);
        if (draft?.image_key) await store.addStyleRef(draft.image_key);
      } else if (action === 'no') {
        const draft = await store.getDraft(draftId);
        await store.setStatus(draftId, 'rejected');
        // A rejected ANGLE doesn't mean the underlying material was bad —
        // give the seed back rather than burning it permanently. See
        // src/store.ts's nextSeed/returnSeed for the other half of this.
        if (draft) await store.returnSeed(draft.seed._id);
      } else {
        await store.setStatus(draftId, 'approved');
      }

      await fetch(api(env, 'answerCallbackQuery'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: cb.id,
          text: action === 'ok' ? 'Queued for the next publish run'
              : action === 'redraw' ? 'New image sent'
              : action === 'styleref' ? 'Saved as style ref'
              : action === 'no' ? 'Rejected — seed returned to the queue'
              : action,
        }),
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
    }

    return new Response('ok');
  } finally {
    await store.close();
  }
}
