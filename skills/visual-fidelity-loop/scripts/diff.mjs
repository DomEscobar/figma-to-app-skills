#!/usr/bin/env node
/**
 * diff.mjs — pixel diff between a Figma-exported reference PNG and a captured
 * screenshot, with dimension normalization so a size mismatch shows up loudly
 * instead of crashing pixelmatch or getting silently cropped away.
 *
 * Usage:
 *   node diff.mjs --reference <ref.png> --actual <actual.png> --out <diff.png>
 *     [--threshold 0.1] [--max-diff-ratio 0.02] [--report <result.json>]
 *
 * Width expectation: capture.mjs is meant to be invoked with `--width` set to the
 * Figma frame's absoluteBoundingBox.width, so `reference` and `actual` should already
 * be the same pixel width by construction. If they aren't, this script still resizes
 * `actual` (to the reference's width, using sharp if available or a bundled bilinear
 * fallback otherwise) so a diff image can be produced — but it also reports
 * `widthMismatch: true`, because a width mismatch here almost always means capture.mjs
 * was called with the wrong `--width`, not a real visual bug. Treat that flag as a
 * setup error to fix, not something the resize should quietly launder away.
 *
 * Height mismatch is handled differently: implementations routinely render taller or
 * shorter than the reference, and that itself is often the bug worth surfacing. The
 * shorter image is padded (never cropped) up to the taller image's height with a
 * magenta (#FF00FF) sentinel block, so missing/extra content shows up as an obvious
 * solid-color region in diff.png and inflates diffRatio instead of being hidden.
 *
 * Exit code: 0 if diffRatio <= max-diff-ratio, 1 otherwise (composes in a shell
 * pipeline / CI-style loop).
 */
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { writeReport } from "./lib/report.mjs";
import { parseArgs, runCli } from "./lib/args.mjs";
import { loadPng, padHeight, resizeToWidth } from "./lib/images.mjs";

const FLAGS = {
  reference: "string",
  actual: "string",
  out: "string",
  threshold: "number",
  "max-diff-ratio": "number",
  report: "string",
};

const DEFAULT_THRESHOLD = 0.1;
const DEFAULT_MAX_DIFF_RATIO = 0.02;

function printHelp() {
  console.log(`Usage: node diff.mjs --reference <ref.png> --actual <actual.png> --out <diff.png> [options]

Required:
  --reference <path.png>   Figma-exported reference image
  --actual <path.png>      Captured screenshot to compare against the reference
  --out <path.png>         Where to write the diff visualization

Options:
  --threshold <0-1>         pixelmatch per-pixel matching threshold (default ${DEFAULT_THRESHOLD})
  --max-diff-ratio <0-1>    Diff pixels / total pixels ratio that still counts as passing (default ${DEFAULT_MAX_DIFF_RATIO})
  --report <path.json>      Also write the JSON result to this file
  --help                    Show this help

Prints a JSON result to stdout:
  { widthMismatch, heightMismatch: { ref, actual }, diffPixels, totalPixels, diffRatio, passed }
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: FLAGS,
    required: ["reference", "actual", "out"],
  });
  if (args.help) {
    printHelp();
    return;
  }

  const threshold = args.threshold ?? DEFAULT_THRESHOLD;
  const maxDiffRatio = args["max-diff-ratio"] ?? DEFAULT_MAX_DIFF_RATIO;

  let reference = loadPng(args.reference);
  let actual = loadPng(args.actual);

  const widthMismatch = reference.width !== actual.width;
  if (widthMismatch) {
    actual = await resizeToWidth(actual, reference.width);
  }

  const heightMismatch = { ref: reference.height, actual: actual.height };
  const targetHeight = Math.max(reference.height, actual.height);
  reference = padHeight(reference, targetHeight);
  actual = padHeight(actual, targetHeight);

  const diff = new PNG({ width: reference.width, height: targetHeight });
  const diffPixels = pixelmatch(reference.data, actual.data, diff.data, reference.width, targetHeight, {
    threshold,
    includeAA: false,
  });

  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, PNG.sync.write(diff));

  const totalPixels = reference.width * targetHeight;
  const diffRatio = diffPixels / totalPixels;
  const passed = diffRatio <= maxDiffRatio;

  const result = { widthMismatch, heightMismatch, diffPixels, totalPixels, diffRatio, passed };
  console.log(JSON.stringify(result, null, 2));
  if (args.report) writeReport(args.report, result);

  process.exitCode = passed ? 0 : 1;
}

runCli(main, printHelp);
