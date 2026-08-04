#!/usr/bin/env node
/**
 * check-styles.mjs — structured (non-pixel) CSS-property verification against a
 * Figma-derived expectations manifest.
 *
 * A pixel diff can tell you 3% of the frame doesn't match; it can't tell you which
 * element or which property. This script asserts specific computed-style values on
 * specific elements, so a failure reads as "backgroundColor is rgb(17, 34, 51),
 * expected rgb(51, 102, 255) on [data-figma-id='12:34']" — something an agent (or a
 * human) can act on directly instead of squinting at a diff image.
 *
 * Usage:
 *   node check-styles.mjs --url <url> --expectations <manifest.json>
 *     [--tolerance-px 2] [--report <report.json>]
 *
 * Expectation manifest shape:
 *   {
 *     "viewport": { "width": 1440, "height": 900 },
 *     "checks": [
 *       {
 *         "selector": "[data-figma-id='12:34']",
 *         "label": "Primary CTA button",
 *         "expect": {
 *           "color": "#FFFFFF",
 *           "backgroundColor": "#3366FF",
 *           "fontSize": "16px",
 *           "fontWeight": "600",
 *           "borderRadius": "8px",
 *           "padding": "12px 24px",
 *           "width": 180,
 *           "height": 48
 *         }
 *       }
 *     ]
 *   }
 *
 * `selector` is expected to target a `data-figma-id` attribute on the rendered
 * element (see SKILL.md for why that convention is load-bearing across this skill
 * suite). Each key under `expect` is a camelCase CSSStyleDeclaration property name;
 * how it's compared depends on which of these three buckets it falls into:
 *   - COLOR_PROPS: parsed as color (hex or rgb()/rgba()) and compared channel-by-channel
 *   - BOX_PROPS: parsed as a 1-4 value CSS box shorthand and compared side-by-side
 *     with pixel tolerance (Chromium expands `padding`/`margin` to 2 or 4 longhand
 *     values depending on symmetry, so shorthand can't be exact-string-matched safely)
 *   - PX_PROPS: parsed as a single px number and compared with pixel tolerance
 *   - anything else falls back to an exact (trimmed) string match
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { injectDeterminism } from "./lib/determinism.mjs";
import { writeReport, printTable } from "./lib/report.mjs";
import { parseArgs, runCli } from "./lib/args.mjs";

const FLAGS = {
  url: "string",
  expectations: "string",
  "tolerance-px": "number",
  report: "string",
};

const DEFAULT_TOLERANCE_PX = 2;
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

// Explicit lookup tables rather than inferring the kind from the expected value's
// shape, so a manifest author writing `"width": 180` vs `"width": "180px"` behaves
// identically either way.
const COLOR_PROPS = new Set(["color", "backgroundColor", "borderColor", "outlineColor"]);
const BOX_PROPS = new Set(["padding", "margin"]);
const PX_PROPS = new Set([
  "fontSize",
  "borderRadius",
  "width",
  "height",
  "lineHeight",
  "letterSpacing",
  "borderWidth",
  "gap",
]);

function printHelp() {
  console.log(`Usage: node check-styles.mjs --url <url> --expectations <manifest.json> [options]

Required:
  --url <url>                Page to check (e.g. http://localhost:3000)
  --expectations <path.json> Expectation manifest (see this file's header comment for the shape)

Options:
  --tolerance-px <number>    Pixel tolerance for numeric properties (default ${DEFAULT_TOLERANCE_PX})
  --report <path.json>       Also write the JSON report to this file
  --help                     Show this help
`);
}

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const num = parseInt(full.slice(0, 6), 16);
  const alpha = full.length >= 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1;
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255, a: alpha };
}

function parseColor(value) {
  const str = String(value).trim();
  if (str.startsWith("#")) return hexToRgb(str);
  const match = str.match(/rgba?\(([^)]+)\)/i);
  if (match) {
    const parts = match[1].split(",").map((p) => parseFloat(p.trim()));
    return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts[3] ?? 1 };
  }
  return null; // named colors ("transparent", "currentcolor", ...) fall back to string compare
}

function formatRgb({ r, g, b, a }) {
  return a < 1 ? `rgba(${r}, ${g}, ${b}, ${a})` : `rgb(${r}, ${g}, ${b})`;
}

function compareColor(expected, actual) {
  const exp = parseColor(expected);
  const act = parseColor(actual);
  if (!exp || !act) {
    const pass = String(expected).trim().toLowerCase() === String(actual).trim().toLowerCase();
    return { pass, expected: String(expected), actual: String(actual) };
  }
  const pass = exp.r === act.r && exp.g === act.g && exp.b === act.b && Math.round(exp.a * 100) === Math.round(act.a * 100);
  return { pass, expected: formatRgb(exp), actual: formatRgb(act) };
}

/** Expands a 1-4 value CSS box shorthand into [top, right, bottom, left]. */
function parseBox(value) {
  const parts = String(value)
    .trim()
    .split(/\s+/)
    .map((p) => parseFloat(p));
  const [top, right = top, bottom = top, left = right] = parts;
  return [top, right, bottom, left];
}

function comparePx(expected, actual, tolerancePx) {
  const exp = parseFloat(expected);
  const act = parseFloat(actual);
  const pass = Number.isFinite(exp) && Number.isFinite(act) && Math.abs(exp - act) <= tolerancePx;
  return { pass, expected: `${exp}px`, actual: `${act}px` };
}

function compareBox(expected, actual, tolerancePx) {
  const exp = parseBox(expected);
  const act = parseBox(actual);
  const pass = exp.every((v, i) => Number.isFinite(v) && Number.isFinite(act[i]) && Math.abs(v - act[i]) <= tolerancePx);
  return { pass, expected: exp.map((v) => `${v}px`).join(" "), actual: act.map((v) => `${v}px`).join(" ") };
}

function compareString(expected, actual) {
  const pass = String(expected).trim() === String(actual).trim();
  return { pass, expected: String(expected), actual: String(actual) };
}

function compareProperty(property, expected, actual, tolerancePx) {
  if (COLOR_PROPS.has(property)) return compareColor(expected, actual);
  if (BOX_PROPS.has(property)) return compareBox(expected, actual, tolerancePx);
  if (PX_PROPS.has(property)) return comparePx(expected, actual, tolerancePx);
  return compareString(expected, actual);
}

async function readComputedStyle(locator, properties) {
  return locator.evaluate((el, props) => {
    const computed = getComputedStyle(el);
    const out = {};
    for (const prop of props) out[prop] = computed[prop];
    return out;
  }, properties);
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
  const args = parseArgs(process.argv.slice(2), { flags: FLAGS, required: ["url", "expectations"] });
  if (args.help) {
    printHelp();
    return;
  }

  const tolerancePx = args["tolerance-px"] ?? DEFAULT_TOLERANCE_PX;
  const manifest = JSON.parse(fs.readFileSync(path.resolve(args.expectations), "utf8"));
  const checks = manifest.checks ?? [];

  const browser = await launchChromium();
  const rows = [];

  try {
    const page = await browser.newPage({ viewport: manifest.viewport ?? DEFAULT_VIEWPORT });
    await page.goto(args.url, { waitUntil: "load" });
    await injectDeterminism(page);

    for (const check of checks) {
      const baseLocator = page.locator(check.selector);
      const count = await baseLocator.count();

      if (count === 0) {
        rows.push({
          selector: check.selector,
          label: check.label ?? "",
          property: "(element)",
          expected: "found in DOM",
          actual: "not found",
          pass: false,
        });
        continue;
      }

      const properties = Object.keys(check.expect ?? {});
      if (!properties.length) continue;

      const computed = await readComputedStyle(baseLocator.first(), properties);
      for (const property of properties) {
        const result = compareProperty(property, check.expect[property], computed[property], tolerancePx);
        rows.push({
          selector: check.selector,
          label: check.label ?? "",
          property,
          expected: result.expected,
          actual: result.actual,
          pass: result.pass,
        });
      }
    }
  } finally {
    await browser.close();
  }

  printTable(
    [
      { key: "label", label: "Element" },
      { key: "property", label: "Property" },
      { key: "expected", label: "Expected" },
      { key: "actual", label: "Actual" },
      { key: "pass", label: "Pass" },
    ],
    rows.map((row) => ({ ...row, pass: row.pass ? "PASS" : "FAIL" }))
  );

  const summary = {
    total: rows.length,
    passed: rows.filter((row) => row.pass).length,
    failed: rows.filter((row) => !row.pass).length,
  };
  console.log(`\n${summary.passed}/${summary.total} checks passed`);

  const report = {
    url: args.url,
    tolerancePx,
    generatedAt: new Date().toISOString(),
    summary,
    results: rows,
  };
  if (args.report) writeReport(args.report, report);

  process.exitCode = summary.failed === 0 ? 0 : 1;
}

runCli(main, printHelp);
