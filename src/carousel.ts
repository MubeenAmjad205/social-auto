/**
 * src/carousel.ts — the Instagram carousel slide template generator.
 *
 * Per docs/08-roadmap.md: "Build the SVG template generator first and
 * validate it locally. The template is the hard part; where it runs is a
 * deployment detail." This is that template generator.
 *
 * Deliberately plain SVG, not satori/JSX — one dependency (resvg, for
 * rasterizing) is already a real CPU cost against the 10ms budget; a layout
 * engine on top of it is a second one for no real gain at this content
 * shape (a heading, a body, a slide counter — three text blocks, not a
 * general web page).
 *
 * Deliberately solid-color / gradient backgrounds, not FLUX-generated art.
 * A carousel needs 6-8 images per post instead of LinkedIn's one; spending
 * ~104 neurons x 8 on every Instagram post would burn the free daily
 * allowance in a couple of posts. Flat, consistent color blocks are also
 * the more legible backdrop for the text that IS the point of a teaching
 * carousel — see docs/03-agents-and-personas.md.
 */

export type SlideKind = 'cover' | 'point' | 'example' | 'takeaway' | 'cta';

export interface Slide {
  kind: SlideKind;
  heading: string;
  body?: string;
  imageUrl?: string;
}

const SIZE = 1080; // Instagram's preferred square dimension.

// Dark editorial gradients with vibrant accent colors
const PALETTES: Array<[string, string, string]> = [
  ['#0a0f1d', '#141e36', '#38bdf8'], // Deep Slate with Cyan accent
  ['#120c18', '#23152c', '#a855f7'], // Deep Plum with Purple accent
  ['#0a1410', '#12261c', '#34d399'], // Deep Pine with Emerald accent
  ['#16100c', '#2c1e15', '#fb923c'], // Deep Umber with Amber accent
];

const BADGES: Record<SlideKind, string> = {
  cover: '✦ TECHNICAL INSIGHT',
  point: '✦ SYSTEM ARCHITECTURE',
  example: '✦ REAL-WORLD IMPLEMENTATION',
  takeaway: '✦ KEY TAKEAWAY',
  cta: '✦ ACTION ITEM',
};

export function renderCarousel(slides: Slide[], paletteSeed = 0): string[] {
  return slides.map((slide, i) =>
    renderSlideSVG(slide, i, slides.length, PALETTES[paletteSeed % PALETTES.length])
  );
}

export function renderSlideSVG(
  slide: Slide,
  index: number,
  total: number,
  [bgFrom, bgTo, accent]: [string, string, string]
): string {
  const pad = 80;
  const contentWidth = SIZE - pad * 2;

  const badgeText = BADGES[slide.kind] ?? '✦ INSIGHT';
  const badgeSvg = `
    <g transform="translate(${pad}, 90)">
      <rect x="0" y="0" width="${badgeText.length * 14 + 32}" height="42" rx="21" fill="${accent}" fill-opacity="0.15" stroke="${accent}" stroke-opacity="0.4" stroke-width="1.5"/>
      <text x="16" y="27" font-family="Inter" font-size="20" font-weight="700" fill="${accent}" letter-spacing="1">${badgeText}</text>
    </g>
  `;

  const headingSize = slide.kind === 'cover' ? 68 : 54;
  const headingLines = wrap(slide.heading, contentWidth, headingSize, true);
  const bodyLines = slide.body ? wrap(slide.body, contentWidth, 36, false) : [];

  const headingY = 210;
  const headingBlock = textBlock(headingLines, pad + 32, headingY + 40, headingSize, 700, '#ffffff', 1.25);

  const bodyStartY = headingY + 40 + headingLines.length * headingSize * 1.25 + 32;
  const bodyBlock = textBlock(bodyLines, pad + 32, bodyStartY, 36, 400, '#d1d5db', 1.45);

  const cardHeight = Math.max(540, bodyStartY + bodyLines.length * 36 * 1.45 - 150);
  
  const glassCard = `
    <rect x="${pad}" y="170" width="${contentWidth}" height="${cardHeight}" rx="32" fill="#000000" fill-opacity="0.35" stroke="#ffffff" stroke-opacity="0.12" stroke-width="1.5"/>
    <line x1="${pad + 32}" y1="170" x2="${pad + 120}" y2="170" stroke="${accent}" stroke-width="4" stroke-linecap="round"/>
  `;

  const footer = slide.kind === 'cta'
    ? `<g transform="translate(${pad}, ${SIZE - 90})">
         <rect x="0" y="-36" width="220" height="52" rx="26" fill="${accent}"/>
         <text x="110" y="-2" font-family="Inter" font-size="24" font-weight="700" fill="#000000" text-anchor="middle">Save This ↓</text>
       </g>`
    : `<text x="${pad}" y="${SIZE - 75}" font-family="Inter" font-size="26" font-weight="600" fill="#9ca3af">${index + 1} / ${total}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${bgFrom}"/>
      <stop offset="100%" stop-color="${bgTo}"/>
    </linearGradient>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" fill="url(#bg)"/>
  <circle cx="${SIZE - 100}" cy="100" r="250" fill="${accent}" fill-opacity="0.08" filter="blur(60px)"/>
  ${badgeSvg}
  ${glassCard}
  ${headingBlock}
  ${bodyBlock}
  ${footer}
</svg>`;
}

function textBlock(
  lines: string[],
  x: number,
  y: number,
  fontSize: number,
  weight: number,
  fill: string,
  lineHeightEm: number
): string {
  if (!lines.length) return '';
  const tspans = lines
    .map((line, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : fontSize * lineHeightEm}">${escapeXml(line)}</tspan>`)
    .join('');
  return `<text x="${x}" y="${y}" font-family="Inter" font-size="${fontSize}" font-weight="${weight}" fill="${fill}">${tspans}</text>`;
}

/**
 * Greedy word wrap by an average-character-width heuristic — there's no
 * canvas/font-metrics API available at this layer (rasterize.ts is where the
 * real font lives). This will misjudge width on lines heavy with wide
 * capitals, same class of trade-off as the Editor's claim heuristic in
 * generate.ts: cheap, imperfect, and the failure mode is a slightly short
 * line, not broken output.
 */
function wrap(text: string, maxWidth: number, fontSize: number, bold: boolean): string[] {
  const avgCharWidth = fontSize * (bold ? 0.62 : 0.55);
  const maxChars = Math.max(8, Math.floor(maxWidth / avgCharWidth));

  // A single word longer than a full line (a URL, an unbroken identifier)
  // would otherwise sail past the 1080px slide edge with nothing to stop
  // it — greedy wrapping only breaks between words. Force-break it first.
  const words = text.trim().split(/\s+/).flatMap(w => hardBreak(w, maxChars));
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function hardBreak(word: string, maxChars: number): string[] {
  if (word.length <= maxChars) return [word];
  const chunks: string[] = [];
  for (let i = 0; i < word.length; i += maxChars) chunks.push(word.slice(i, i + maxChars));
  return chunks;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
