#!/usr/bin/env node
/**
 * capture.mjs — deterministic screenshot capture via Playwright Chromium.
 *
 * Usage:
 *   node capture.mjs --url <url> --out <path.png> --width <css px> [options]
 *
 * Required:
 *   --url <url>        Page to capture, e.g. http://localhost:3000
 *   --out <path.png>   Where to write the screenshot
 *   --width <number>   Viewport width in CSS px. Use the Figma frame's
 *                       absoluteBoundingBox.width so this lines up with the exported
 *                       reference PNG before diff.mjs ever runs.
 *
 * Options:
 *   --height <number>     Viewport height in CSS px. Omit to capture the full
 *                          scrollable page instead of one viewport-sized slice.
 *   --scale <number>      deviceScaleFactor, i.e. the @Nx export multiplier (default 2)
 *   --selector <css>      Clip to one element's bounding box instead of the page/viewport
 *   --wait <selector|ms>  Extra wait before capture: a CSS selector to wait for
 *                          visibility, or a plain millisecond count. Useful for SPAs
 *                          that still need to mount/fetch data after `load` fires.
 *   --help                Show this help
 *
 * Examples:
 *   node capture.mjs --url http://localhost:3000 --out shots/actual.png --width 1440
 *   node capture.mjs --url http://localhost:3000 --out shots/hero.png --width 1440 \
 *     --selector "[data-figma-id='12:34']"
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { injectDeterminism } from "./lib/determinism.mjs";
import { parseArgs, runCli, UsageError } from "./lib/args.mjs";

const FLAGS = {
  url: "string",
  out: "string",
  width: "number",
  height: "number",
  scale: "number",
  selector: "string",
  // A selector or a millisecond count, so it stays a string and is classified later.
  wait: "string",
};

const DEFAULT_SCALE = 2;
// Only a scroll starting point when no --height is given; fullPage capture scrolls
// through the real content height regardless of this value.
const DEFAULT_VIEWPORT_HEIGHT = 1200;

function printHelp() {
  console.log(`Usage: node capture.mjs --url <url> --out <path.png> --width <css px> [options]

Required:
  --url <url>            Page to capture (e.g. http://localhost:3000)
  --out <path.png>       Where to write the screenshot
  --width <number>       Viewport width in CSS px — use the Figma frame's absoluteBoundingBox.width

Options:
  --height <number>      Viewport height in CSS px. Omit to capture the full scrollable page.
  --scale <number>       deviceScaleFactor, i.e. the export @Nx multiplier (default ${DEFAULT_SCALE})
  --selector <css>       Clip to one element's bounding box instead of the page/viewport
  --wait <selector|ms>   Extra wait before capture: a CSS selector, or a millisecond count
  --help                 Show this help

Examples:
  node capture.mjs --url http://localhost:3000 --out shots/actual.png --width 1440
  node capture.mjs --url http://localhost:3000 --out shots/hero.png --width 1440 --selector "[data-figma-id='12:34']"
`);
}

async function waitExtra(page, wait) {
  if (!wait) return;
  if (/^\d+$/.test(String(wait))) {
    await page.waitForTimeout(Number(wait));
  } else {
    await page.waitForSelector(String(wait), { state: "visible" });
  }
}

async function launchChromium() {
  try {
    return await chromium.launch();
  } catch (err) {
    const message = String(err?.message || err);
    if (message.includes("Executable doesn't exist")) {
      throw new Error(
        "Playwright's Chromium build is not installed. Run this once from scripts/:\n\n  npx playwright install chromium\n"
      );
    }
    throw new Error(`Failed to launch Chromium: ${message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: FLAGS, required: ["url", "out", "width"] });
  if (args.help) {
    printHelp();
    return;
  }

  const width = Math.round(args.width);
  const height = args.height !== undefined ? Math.round(args.height) : undefined;
  const scale = args.scale ?? DEFAULT_SCALE;

  if (width <= 0) throw new UsageError(`--width must be a positive number, got ${args.width}.`);
  if (scale <= 0) throw new UsageError(`--scale must be a positive number, got ${args.scale}.`);

  const browser = await launchChromium();

  try {
    const page = await browser.newPage({
      viewport: { width, height: height ?? DEFAULT_VIEWPORT_HEIGHT },
      deviceScaleFactor: scale,
    });
    await page.goto(args.url, { waitUntil: "load" });

    // App-specific wait runs before determinism injection so the freeze/settle logic
    // operates on the DOM the app actually ends up rendering, not a loading skeleton.
    await waitExtra(page, args.wait);
    await injectDeterminism(page);

    const outPath = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    if (args.selector) {
      const locator = page.locator(String(args.selector)).first();
      await locator.waitFor({ state: "visible" });
      // Elements below the initial viewport otherwise report a bounding box the
      // clip can't actually reach.
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      if (!box) {
        throw new Error(`Selector "${args.selector}" matched no visible element`);
      }
      await page.screenshot({ path: outPath, clip: box });
    } else {
      await page.screenshot({ path: outPath, fullPage: !height });
    }

    console.log(`Saved screenshot: ${outPath}`);
  } finally {
    await browser.close();
  }
}

runCli(main, printHelp);
