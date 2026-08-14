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

export async function sendDraftForApproval(
  env: Env,
  d: { id: string; platform: string; body: string; flags: string[]; sourceCount: number; imageUrl: string }
) {
  // Editor flags are surfaced, never auto-applied. You decide.
  const header = d.flags.length
    ? d.flags.map(f => `⚠️ ${f}`).join('\n') + '\n\n'
    : '';

  const provenance = d.sourceCount > 0
    ? `\n\n_grounded in ${d.sourceCount} source(s)_`
    : `\n\n_seed-only — no external claims_`;

  await fetch(api(env, 'sendPhoto'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      photo: d.imageUrl,
      caption: `${header}*${d.platform}*\n\n${d.body}${provenance}`.slice(0, 1024),
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

/**
 * Telegram's sendMediaGroup (the actual "album" UI) does not support inline
 * keyboards — a Bot API limitation, not an oversight here. So: the slides go
 * out as a plain album for a fast visual scan, immediately followed by a
 * text message carrying the caption and the same three buttons as a single
 * post. Two messages, one decision.
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

  const header = d.flags.length ? d.flags.map(f => `⚠️ ${f}`).join('\n') + '\n\n' : '';
  const provenance = d.sourceCount > 0
    ? `\n\n_grounded in ${d.sourceCount} source(s)_`
    : `\n\n_seed-only — no external claims_`;

  await fetch(api(env, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: `${header}*instagram carousel*\n\n${d.body}${provenance}`.slice(0, 4096),
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

export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  const update = await request.json<any>();
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
      } else {
        await store.setStatus(draftId, action === 'ok' ? 'approved' : 'rejected');
      }

      await fetch(api(env, 'answerCallbackQuery'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: cb.id,
          text: action === 'ok' ? 'Queued for the next publish run'
              : action === 'redraw' ? 'New image sent'
              : action,
        }),
      });
      return new Response('ok');
    }

    // ---- /seed — the one input only you can provide
    const text: string = update.message?.text ?? '';
    if (text.startsWith('/seed')) {
      const rest = text.replace(/^\/seed\s*/, '').trim();
      const isClient = rest.startsWith('client ');
      const note = isClient ? rest.slice(7).trim() : rest;

      if (!note) {
        await notify(env, 'Usage:\n`/seed <what happened>`\n`/seed client <what happened>`');
      } else {
        await store.addSeed(note, isClient ? 'client' : 'own');
        const n = await store.seedCount();
        await notify(env, `🌱 Seed banked (${isClient ? 'client' : 'own'}). ${n} in the queue.`);
      }
      return new Response('ok');
    }

    if (text.startsWith('/status')) {
      const n = await store.seedCount();
      await notify(env, `🌱 ${n} unused seed(s) in the queue.`);
    }

    return new Response('ok');
  } finally {
    await store.close();
  }
}
