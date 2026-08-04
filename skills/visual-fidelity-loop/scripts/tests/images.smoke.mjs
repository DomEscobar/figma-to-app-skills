/**
 * These two functions set the width and the pixel count that every diff ratio is
 * measured against. A mistake here doesn't throw — it reports a plausible-looking
 * fidelity number that happens to be wrong, and the agent iterates against it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PNG } from "pngjs";
import { padHeight, resizeWidthBilinear, SENTINEL_RGBA } from "../lib/images.mjs";

/** Builds a PNG from a row-major array of [r,g,b,a] pixels. */
function pngFrom(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) << 2;
      for (let c = 0; c < 4; c++) png.data[offset + c] = rows[y][x][c];
    }
  }
  return png;
}

function pixelAt(png, x, y) {
  const offset = (y * png.width + x) << 2;
  return [...png.data.slice(offset, offset + 4)];
}

const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];
const WHITE = [255, 255, 255, 255];

test("resizeWidthBilinear: a solid color survives any rescale exactly", () => {
  // The invariant that matters most: resizing must not introduce diff pixels of its
  // own on flat regions, or every diff would carry a synthetic noise floor.
  const source = pngFrom([
    [RED, RED, RED, RED],
    [RED, RED, RED, RED],
  ]);
  for (const targetWidth of [1, 2, 3, 7, 8]) {
    const out = resizeWidthBilinear(source, targetWidth);
    assert.equal(out.width, targetWidth);
    assert.equal(out.height, 2, "height must never change");
    for (let x = 0; x < targetWidth; x++) {
      assert.deepEqual(pixelAt(out, x, 0), RED, `pixel ${x} drifted at width ${targetWidth}`);
    }
  }
});

test("resizeWidthBilinear: a 2:1 downscale averages neighbouring pixels", () => {
  const source = pngFrom([[RED, BLUE, RED, BLUE]]);
  const out = resizeWidthBilinear(source, 2);
  // Each output pixel sits exactly between one red and one blue source pixel.
  assert.deepEqual(pixelAt(out, 0, 0), [128, 0, 128, 255]);
  assert.deepEqual(pixelAt(out, 1, 0), [128, 0, 128, 255]);
});

test("resizeWidthBilinear: upscaling keeps the endpoints anchored", () => {
  const out = resizeWidthBilinear(pngFrom([[RED, BLUE]]), 4);
  assert.deepEqual(pixelAt(out, 0, 0), RED, "left edge must not bleed");
  assert.deepEqual(pixelAt(out, 3, 0), BLUE, "right edge must not bleed");
});

test("resizeWidthBilinear: rows stay independent", () => {
  const out = resizeWidthBilinear(pngFrom([[RED, RED], [BLUE, BLUE]]), 4);
  for (let x = 0; x < 4; x++) {
    assert.deepEqual(pixelAt(out, x, 0), RED);
    assert.deepEqual(pixelAt(out, x, 1), BLUE);
  }
});

test("padHeight: original content is preserved and the surplus is the sentinel", () => {
  const out = padHeight(pngFrom([[RED, WHITE]]), 3);
  assert.equal(out.height, 3);
  assert.equal(out.width, 2);
  assert.deepEqual(pixelAt(out, 0, 0), RED, "source row must survive verbatim");
  assert.deepEqual(pixelAt(out, 1, 0), WHITE);
  for (const y of [1, 2]) {
    for (const x of [0, 1]) {
      assert.deepEqual(pixelAt(out, x, y), SENTINEL_RGBA, `padding at ${x},${y} is not the sentinel`);
    }
  }
});

test("padHeight: an exact-height image is returned untouched", () => {
  const source = pngFrom([[RED]]);
  assert.equal(padHeight(source, 1), source);
});

test("padHeight: never crops, so a taller source is left alone", () => {
  // Cropping would hide exactly the extra content the diff is supposed to surface.
  const source = pngFrom([[RED], [BLUE]]);
  const out = padHeight(source, 1);
  assert.equal(out.height, 2);
});
