/**
 * Image normalization for the pixel diff.
 *
 * Separate from `diff.mjs` so the geometry can be tested directly: these two functions
 * decide the denominator of every diff ratio the agent iterates against, so an
 * off-by-one here doesn't crash, it just quietly reports the wrong fidelity.
 */

import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

/** Magenta: "no source content here". Chosen to be loud and improbable in a design. */
export const SENTINEL_RGBA = [0xff, 0x00, 0xff, 0xff];

export function loadPng(filePath) {
  return PNG.sync.read(fs.readFileSync(path.resolve(filePath)));
}

/** Minimal, correct horizontal-only bilinear resize (height never changes here). */
export function resizeWidthBilinear(png, targetWidth) {
  const { width: sourceWidth, height, data } = png;
  const out = new PNG({ width: targetWidth, height });
  const scale = sourceWidth / targetWidth;

  for (let x = 0; x < targetWidth; x++) {
    const sourceX = (x + 0.5) * scale - 0.5;
    const x0 = Math.min(sourceWidth - 1, Math.max(0, Math.floor(sourceX)));
    const x1 = Math.min(sourceWidth - 1, x0 + 1);
    const t = Math.min(1, Math.max(0, sourceX - x0));

    for (let y = 0; y < height; y++) {
      const i0 = (y * sourceWidth + x0) << 2;
      const i1 = (y * sourceWidth + x1) << 2;
      const o = (y * targetWidth + x) << 2;
      for (let c = 0; c < 4; c++) {
        out.data[o + c] = Math.round(data[i0 + c] * (1 - t) + data[i1 + c] * t);
      }
    }
  }
  return out;
}

/**
 * Resizes `png` to `targetWidth`, preferring sharp's higher-quality resampling when
 * it happens to be installed and falling back to the bundled bilinear resize
 * otherwise. Sharp is intentionally not a declared dependency (native bindings
 * complicate portability), so this import is expected to fail on most machines.
 */
export async function resizeToWidth(png, targetWidth) {
  if (png.width === targetWidth) return png;
  try {
    const { default: sharp } = await import("sharp");
    const buffer = await sharp(PNG.sync.write(png))
      .resize({ width: targetWidth, kernel: "lanczos3" })
      .png()
      .toBuffer();
    return PNG.sync.read(buffer);
  } catch {
    return resizeWidthBilinear(png, targetWidth);
  }
}

/** Pads `png` down-to-up to `targetHeight` with the magenta sentinel; never crops. */
export function padHeight(png, targetHeight) {
  // `>=` rather than `===`: cropping would hide exactly the surplus content the diff
  // exists to surface, and blitting more rows than fit would read out of bounds.
  if (png.height >= targetHeight) return png;
  const out = new PNG({ width: png.width, height: targetHeight });
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = SENTINEL_RGBA[0];
    out.data[i + 1] = SENTINEL_RGBA[1];
    out.data[i + 2] = SENTINEL_RGBA[2];
    out.data[i + 3] = SENTINEL_RGBA[3];
  }
  // `PNG.sync.read` returns a plain data object, not a full PNG instance, so the
  // static form of bitblt is used here rather than the (unavailable) instance method.
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0);
  return out;
}
