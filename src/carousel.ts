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
}

const SIZE = 1080; // Instagram's preferred square dimension.

// A small rotating set of dark editorial gradients — consistency across
// slides (and across posts) is what makes a feed read as deliberate. See the
// FLUX.2 multi-reference rationale in docs/09-resources.md; this is the same
// idea applied to a medium that doesn't need a model at all.
const PALETTES: Array<[string, string]> = [
  ['#0f1420', '#1c2740'], // slate
  ['#151018', '#2a1b2e'], // plum
  ['#0e1512', '#16281f'], // pine
  ['#171310', '#2e2016'], // umber
];

export function renderCarousel(slides: Slide[], paletteSeed = 0): string[] {
  return slides.map((slide, i) =>
    renderSlideSVG(slide, i, slides.length, PALETTES[paletteSeed % PALETTES.length])
  );
}

export function renderSlideSVG(
  slide: Slide,
  index: number,
  total: number,
  [bgFrom, bgTo]: [string, string]
): string {
  const pad = 96;
  const contentWidth = SIZE - pad * 2;

  const headingSize = slide.kind === 'cover' ? 76 : 60;
  const headingLines = wrap(slide.heading, contentWidth, headingSize, true);
  const bodyLines = slide.body ? wrap(slide.body, contentWidth, 40, false) : [];

  const headingY = slide.body ? 420 : 480;
  const headingBlock = textBlock(headingLines, pad, headingY, headingSize, 700, '#f5f3ef', 1.25);

  const bodyStartY = headingY + headingLines.length * headingSize * 1.25 + 56;
  const bodyBlock = textBlock(bodyLines, pad, bodyStartY, 40, 400, '#c9c4ba', 1.5);

  const footer = slide.kind === 'cta'
    ? `<text x="${pad}" y="${SIZE - 80}" font-family="Inter" font-size="32" font-weight="700" fill="#f5f3ef">Save this ↓</text>`
    : `<text x="${pad}" y="${SIZE - 80}" font-family="Inter" font-size="28" font-weight="400" fill="#8a8577">${index + 1} / ${total}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${bgFrom}"/>
      <stop offset="100%" stop-color="${bgTo}"/>
    </linearGradient>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" fill="url(#bg)"/>
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

  const words = text.trim().split(/\s+/);
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

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
