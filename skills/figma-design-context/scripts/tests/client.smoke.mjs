import assert from "node:assert/strict";
import { test } from "node:test";
import { retryDelayMs, formatDuration } from "../lib/client.mjs";

test("retryDelayMs: honours a short Retry-After exactly", () => {
  assert.equal(retryDelayMs(0, "30"), 30_000);
  assert.equal(retryDelayMs(3, "120"), 120_000);
});

test("retryDelayMs: refuses to retry when Retry-After exceeds any sane wait", () => {
  // Figma's file-endpoint budget really does return values like this (observed:
  // 395866 seconds, i.e. 4.6 days, after a few whole-file fetches). Retrying against
  // it can only produce identical failures while spending more requests.
  assert.equal(retryDelayMs(0, "395866"), null, "a multi-day wait must be terminal, not clamped");
  assert.equal(retryDelayMs(0, "3600"), null);
});

test("retryDelayMs: falls back to jittered exponential backoff without the header", () => {
  const first = retryDelayMs(0, null);
  const later = retryDelayMs(4, undefined);
  assert.ok(first >= 1000 && first < 1600, `expected ~1s, got ${first}`);
  assert.ok(later >= 16_000 && later <= 30_500, `expected a capped larger delay, got ${later}`);
  assert.equal(retryDelayMs(0, "not-a-number") >= 1000, true, "an unparseable header falls back to backoff");
});

test("formatDuration: scales the unit so a long lockout is unmistakable", () => {
  assert.equal(formatDuration(45), "45s");
  assert.equal(formatDuration(600), "10.0 minutes");
  assert.equal(formatDuration(7200), "2.0 hours");
  assert.equal(formatDuration(395_866), "4.6 days");
  assert.equal(formatDuration(0), "0s");
});
