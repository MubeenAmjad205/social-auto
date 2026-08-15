/**
 * src/casestudy.ts — on-demand client case-study generator.
 *
 * Triggered by /casestudy in Telegram, not a cron. Doesn't need a seed or
 * the Researcher — it's written from a description of an already-delivered
 * project, which needs no external grounding at all.
 *
 * Doesn't publish anywhere. Publishing to the Company Page needs Marketing
 * Developer Platform approval — "genuinely partner-gated" per docs/06 —
 * which this project doesn't have. Output is delivered as plain text over
 * Telegram for you to paste onto the Company Page yourself. Still a real
 * time save: the writing is the actual work, not the pasting.
 *
 * Unlike the regular LinkedIn Writer, this one MAY end with a soft
 * call-to-action — docs/01 draws the "availability never goes in a post"
 * line at the personal profile, not the Company Page, which IS the
 * freelance storefront.
 */

import type { Env } from './index';

export async function generateCaseStudy(env: Env, description: string): Promise<string> {
  const system = [
    "You write a client case-study post for a full-stack Gen AI / ML engineer's",
    'Company Page — the freelance storefront, not their personal profile. Same',
    'grounded, concrete voice as their personal posts: first person, no hype,',
    'name the actual tool, number, or constraint.',
    '',
    'STRUCTURE: constraint -> the naive approach and what it would have cost',
    '-> what was actually built -> the outcome, with a real number if one was given.',
    '',
    'HARD RULES',
    '- Only state what appears in the description below. Do not invent a',
    '  client name, a number, or an outcome that was not given.',
    '- If the client cannot be named, describe the shape of the engagement',
    '  instead ("a small e-commerce team", "a Series A startup").',
    '- 150-250 words.',
    '- End with ONE soft line inviting similar work — this is the one place',
    '  in the whole system where that is appropriate, because it is the',
    '  Company Page, not the personal profile.',
    '- No hook formulas, no engagement bait, no more than one emoji.',
    '',
    'Output the post text only.',
  ].join('\n');

  const res: any = await env.AI.run(env.TEXT_MODEL as any, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `PROJECT DESCRIPTION: ${description}` },
    ],
    max_tokens: 500,
  });

  return (res.response ?? res.result?.response ?? '').trim();
}
