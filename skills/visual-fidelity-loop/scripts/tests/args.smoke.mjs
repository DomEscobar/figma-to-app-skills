import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs, UsageError } from "../lib/args.mjs";

const SPEC = {
  flags: { url: "string", out: "string", width: "number", scale: "number", verbose: "boolean" },
  required: ["url", "out"],
};

test("parseArgs: reads strings, numbers and booleans", () => {
  const args = parseArgs(["--url", "http://x", "--out", "a.png", "--width", "375", "--verbose"], SPEC);
  assert.deepEqual(args, { url: "http://x", out: "a.png", width: 375, verbose: true });
});

test("parseArgs: numeric flags arrive as numbers, not strings", () => {
  const args = parseArgs(["--url", "u", "--out", "o", "--scale", "2.5"], SPEC);
  assert.equal(args.scale, 2.5);
  assert.equal(typeof args.scale, "number");
});

test("parseArgs: a mistyped flag fails loudly instead of falling back to a default", () => {
  // The whole point: a silently-ignored `--max-diff-ration` would let the default
  // threshold decide pass/fail, which is the worst outcome for a verification tool.
  assert.throws(() => parseArgs(["--url", "u", "--out", "o", "--widht", "375"], SPEC), {
    name: "UsageError",
    message: /Unknown option "--widht"/,
  });
});

test("parseArgs: a numeric flag rejects a non-numeric value", () => {
  assert.throws(() => parseArgs(["--url", "u", "--out", "o", "--width", "wide"], SPEC), {
    name: "UsageError",
    message: /needs a number, but got "wide"/,
  });
});

test("parseArgs: a value-taking flag left empty is an error, not `true`", () => {
  // `Number(true)` is 1, so this used to silently become width 1.
  assert.throws(() => parseArgs(["--url", "u", "--out", "o", "--width", "--verbose"], SPEC), {
    name: "UsageError",
    message: /Option "--width" needs a value/,
  });
  assert.throws(() => parseArgs(["--url", "u", "--out", "o", "--width"], SPEC), {
    name: "UsageError",
    message: /Option "--width" needs a value/,
  });
});

test("parseArgs: negative numbers are values, not flags", () => {
  const args = parseArgs(["--url", "u", "--out", "o", "--width", "-5"], SPEC);
  assert.equal(args.width, -5);
});

test("parseArgs: missing required flags are named", () => {
  assert.throws(() => parseArgs(["--url", "u"], SPEC), {
    name: "UsageError",
    message: /Missing required option\(s\): --out/,
  });
});

test("parseArgs: --help short-circuits the required check", () => {
  assert.deepEqual(parseArgs(["--help"], SPEC), { help: true });
  assert.deepEqual(parseArgs(["-h"], SPEC), { help: true });
});

test("parseArgs: a stray positional argument is rejected", () => {
  assert.throws(() => parseArgs(["--url", "u", "--out", "o", "leftover"], SPEC), {
    name: "UsageError",
    message: /Unexpected argument "leftover"/,
  });
});

test("parseArgs: errors are UsageErrors so the CLI can print help instead of a stack", () => {
  assert.throws(() => parseArgs(["--nope"], SPEC), (error) => error instanceof UsageError);
});
