/**
 * src/rasterize.ts — SVG -> PNG via resvg-wasm.
 *
 * This is the piece docs/08-roadmap.md left as an open trade-off for v1.1:
 * "satori + resvg-wasm in the Worker | Free | CPU-heavy against 10ms.
 * Likely one Worker per slide, or a paid plan." We took the free option.
 *
 * There is no OS font store inside a Workers isolate, so resvg cannot
 * rasterize text at all without font data handed to it directly — that's
 * why the two Inter weights are bundled as assets and passed in as raw
 * buffers on every render() call, not loaded from "the system".
 *
 * WHAT THIS DOES NOT RESOLVE: whether the WASM init + render actually fits
 * the 10ms CPU budget once Atlas's TLS handshake and the LinkedIn pipeline's
 * own image decode are also in play on a shared budget. That's exactly the
 * open question docs/08 lists for the LinkedIn image path, extended to a
 * second, heavier rasterizer. Six-to-eight renders per Instagram post make
 * this considerably more likely to trip than the single decode LinkedIn
 * does. If "Exceeded CPU limit" shows up on the 14:00 PKT publish cron once
 * this is live: shrink SIZE in carousel.ts to 720, then move rendering into
 * its own Worker behind a service binding for a fresh budget per slide —
 * same ladder already documented for FLUX in generate.ts and docs/07.
 */

import { Resvg, initWasm } from '@resvg/resvg-wasm';
// Bundled as a CompiledWasm module / raw Data via the wrangler.jsonc "rules"
// — see src/assets.d.ts for the ambient types that make these imports valid.
import RESVG_WASM from '@resvg/resvg-wasm/index_bg.wasm';
import INTER_REGULAR from '../assets/Inter-Regular.ttf';
import INTER_BOLD from '../assets/Inter-Bold.ttf';

let ready: Promise<void> | null = null;

function ensureInit(): Promise<void> {
  // initWasm throws if called twice in the same isolate (module re-import on
  // a warm isolate) — guard with a cached promise rather than a boolean so
  // concurrent callers within one request await the same init.
  if (!ready) ready = initWasm(RESVG_WASM);
  return ready;
}

let fontBuffers: Uint8Array[] | null = null;

function getFontBuffers(): Uint8Array[] {
  if (!fontBuffers) {
    fontBuffers = [new Uint8Array(INTER_REGULAR), new Uint8Array(INTER_BOLD)];
  }
  return fontBuffers;
}

export async function svgToPng(svg: string): Promise<Uint8Array> {
  await ensureInit();

  const resvg = new Resvg(svg, {
    font: {
      fontBuffers: getFontBuffers(),
      loadSystemFonts: false,
      defaultFontFamily: 'Inter',
    },
    fitTo: { mode: 'width', value: 1080 },
  });

  return resvg.render().asPng();
}
