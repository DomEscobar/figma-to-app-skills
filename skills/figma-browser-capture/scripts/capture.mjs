#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import pixelmatch from "pixelmatch";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const SECRET_QUERY = /(token|secret|password|passwd|auth|key)/i;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const PROPERTY_SOURCES = new Set(["visible-inspector", "dev-mode-code"]);
const ASSET_SOURCES = new Set(["visible-download"]);
const SOURCE_VIEWS = new Set(["presentation", "embed", "editor", "dev-mode"]);
const ACCESS_MODES = new Set(["public", "session"]);

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

export function parseArgs(argv) {
  const values = {};
  const booleans = new Set(["allow-localhost", "help"]);
  const allowed = new Set([
    "url", "out-dir", "width", "height", "dpr", "selector", "clip", "wait-selector",
    "samples", "sample-delay", "stability-threshold", "source-view", "access-mode",
    "cdp-url", "inspector", "allow-localhost", "help"
  ]);
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === "-h") { values.help = true; continue; }
    if (!raw.startsWith("--")) throw new UsageError(`Unexpected argument "${raw}"`);
    const name = raw.slice(2);
    if (!allowed.has(name)) throw new UsageError(`Unknown option "--${name}"`);
    if (booleans.has(name)) { values[name] = true; continue; }
    const next = argv[++i];
    if (next === undefined || next.startsWith("--")) throw new UsageError(`Option "--${name}" needs a value`);
    values[name] = next;
  }
  if (values.help) return values;
  for (const required of ["url", "out-dir", "width", "height"]) {
    if (values[required] === undefined) throw new UsageError(`Missing required option "--${required}"`);
  }
  return values;
}

export function sanitizeSourceUrl(value, { allowLocalhost = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new UsageError("--url must be a valid URL"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new UsageError("Only http(s) source URLs are allowed");
  if (url.username || url.password) throw new UsageError("Credentials are forbidden in source URLs");
  for (const name of url.searchParams.keys()) {
    if (SECRET_QUERY.test(name)) throw new UsageError(`Credential-like query parameter "${name}" is forbidden`);
  }
  const host = url.hostname.toLowerCase();
  const isFigma = host === "figma.com" || host.endsWith(".figma.com");
  const isLocal = LOOPBACK.has(host);
  if (!isFigma && !(allowLocalhost && isLocal)) {
    throw new UsageError("Source must be figma.com; localhost is permitted only for focused tests");
  }
  url.hash = "";
  return url.toString();
}

export function validateCdpUrl(value) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new UsageError("--cdp-url must be a valid URL"); }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) throw new UsageError("Unsupported CDP URL protocol");
  if (url.username || url.password) throw new UsageError("Credentials are forbidden in --cdp-url");
  if (!LOOPBACK.has(url.hostname.toLowerCase())) throw new UsageError("--cdp-url must target loopback");
  return url.toString();
}

export function parseClip(value) {
  if (!value) return null;
  const parts = value.split(",").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new UsageError("--clip must be x,y,width,height");
  }
  const [x, y, width, height] = parts;
  if (x < 0 || y < 0 || width <= 0 || height <= 0) throw new UsageError("--clip values must define a positive on-screen rectangle");
  return { x, y, width, height };
}

export function safeAssetPath(value) {
  const normalized = path.posix.normalize(String(value).replaceAll("\\", "/"));
  if (
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    !normalized.startsWith("assets/")
  ) {
    throw new UsageError("Inspector asset paths must stay under assets/");
  }
  return normalized;
}

export function normalizeInspector(input, sourceUrl) {
  if (!input || input.version !== 1 || !Array.isArray(input.properties)) {
    throw new UsageError("Inspector input must have version 1 and a properties array");
  }
  const properties = input.properties.map((property, index) => {
    if (!property || typeof property.name !== "string" || property.value === undefined) {
      throw new UsageError(`Inspector property ${index} needs name and value`);
    }
    if (!PROPERTY_SOURCES.has(property.source)) {
      throw new UsageError(`Inspector property "${property.name}" has untrusted source "${property.source}"`);
    }
    return {
      name: property.name,
      value: property.value,
      ...(property.unit ? { unit: String(property.unit) } : {}),
      source: property.source,
      evidence: String(property.evidence || "right-sidebar")
    };
  });
  const assets = (input.assets || []).map((asset, index) => {
    if (!asset || typeof asset.name !== "string" || typeof asset.path !== "string" || !ASSET_SOURCES.has(asset.source)) {
      throw new UsageError(`Inspector asset ${index} needs name, path, and source visible-download`);
    }
    return { name: asset.name, path: safeAssetPath(asset.path), source: asset.source };
  });
  return {
    version: 1,
    source: {
      url: sourceUrl,
      collectedAt: new Date().toISOString(),
      view: String(input.source?.view || "dev-mode")
    },
    selection: {
      ...(input.selection?.nodeId ? { nodeId: String(input.selection.nodeId) } : {}),
      ...(input.selection?.name ? { name: String(input.selection.name) } : {}),
      ...(input.selection?.layerType ? { layerType: String(input.selection.layerType) } : {})
    },
    properties,
    assets,
    unavailable: (input.unavailable || []).map(String),
    inferred: (input.inferred || []).map((entry, index) => {
      if (!entry || typeof entry.field !== "string" || entry.value === undefined || typeof entry.reason !== "string") {
        throw new UsageError(`Inferred entry ${index} needs field, value, and reason`);
      }
      return { field: entry.field, value: entry.value, reason: entry.reason };
    })
  };
}

function numberOption(value, fallback, name, { integer = false, min = 0 } = {}) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < min || (integer && !Number.isInteger(parsed))) {
    throw new UsageError(`--${name} must be ${integer ? "an integer" : "a number"} >= ${min}`);
  }
  return parsed;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function imageDiffRatio(left, right) {
  const a = PNG.sync.read(left);
  const b = PNG.sync.read(right);
  if (a.width !== b.width || a.height !== b.height) throw new Error("Stability samples have different dimensions");
  const changed = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1, includeAA: false });
  return changed / (a.width * a.height);
}

async function waitForPage(page, waitSelector) {
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
    await Promise.all([...document.images].filter((image) => !image.complete).map((image) =>
      new Promise((resolve) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", resolve, { once: true });
      })
    ));
  });
  if (waitSelector) await page.locator(waitSelector).first().waitFor({ state: "visible" });
}

async function screenshotTarget(page, { selector, clip }) {
  if (selector && clip) throw new UsageError("Use either --selector or --clip, not both");
  if (selector) {
    const target = page.locator(selector).first();
    await target.waitFor({ state: "visible" });
    await target.scrollIntoViewIfNeeded();
    return target.screenshot({ animations: "disabled", caret: "hide", scale: "device" });
  }
  return page.screenshot({ animations: "disabled", caret: "hide", scale: "device", ...(clip ? { clip } : {}) });
}

export async function runCapture(rawArgs) {
  const width = numberOption(rawArgs.width, undefined, "width", { integer: true, min: 1 });
  const height = numberOption(rawArgs.height, undefined, "height", { integer: true, min: 1 });
  const dpr = numberOption(rawArgs.dpr, 1, "dpr", { min: 0.25 });
  const sampleCount = numberOption(rawArgs.samples, 3, "samples", { integer: true, min: 3 });
  const sampleDelay = numberOption(rawArgs["sample-delay"], 400, "sample-delay", { integer: true, min: 0 });
  const stabilityThreshold = numberOption(rawArgs["stability-threshold"], 0.0001, "stability-threshold", { min: 0 });
  const allowLocalhost = Boolean(rawArgs["allow-localhost"]);
  const sourceUrl = sanitizeSourceUrl(rawArgs.url, { allowLocalhost });
  const cdpUrl = validateCdpUrl(rawArgs["cdp-url"]);
  const sourceView = String(rawArgs["source-view"] || "presentation");
  const accessMode = String(rawArgs["access-mode"] || (cdpUrl ? "session" : "public"));
  if (!SOURCE_VIEWS.has(sourceView)) throw new UsageError("--source-view must be presentation, embed, editor, or dev-mode");
  if (!ACCESS_MODES.has(accessMode)) throw new UsageError("--access-mode must be public or session");
  if (cdpUrl && accessMode !== "session") throw new UsageError("CDP capture must use --access-mode session");
  if (!cdpUrl && accessMode !== "public") throw new UsageError("Session capture requires --cdp-url");
  const clip = parseClip(rawArgs.clip);
  const outDir = path.resolve(rawArgs["out-dir"]);
  await fs.mkdir(outDir, { recursive: true });

  let browser;
  let context;
  let page;
  let managed = false;
  try {
    if (cdpUrl) {
      browser = await chromium.connectOverCDP(cdpUrl);
      context = browser.contexts()[0];
      if (!context) throw new Error("The CDP browser exposes no context");
      page = await context.newPage();
      await page.setViewportSize({ width, height });
    } else {
      browser = await chromium.launch({ headless: true });
      managed = true;
      context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: dpr,
        locale: "en-US",
        timezoneId: "UTC",
        colorScheme: "light",
        reducedMotion: "reduce"
      });
      page = await context.newPage();
    }
    await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    sanitizeSourceUrl(page.url(), { allowLocalhost });
    await waitForPage(page, rawArgs["wait-selector"]);

    const samples = [];
    for (let index = 0; index < sampleCount; index++) {
      if (index) await page.waitForTimeout(sampleDelay);
      samples.push(await screenshotTarget(page, { selector: rawArgs.selector, clip }));
    }
    const pairwiseDiffRatios = [];
    for (let index = 1; index < samples.length; index++) {
      pairwiseDiffRatios.push(imageDiffRatio(samples[index - 1], samples[index]));
    }
    const stable = pairwiseDiffRatios.every((ratio) => ratio <= stabilityThreshold);
    if (!stable) {
      for (let index = 0; index < samples.length; index++) {
        await fs.writeFile(path.join(outDir, `unstable-${index + 1}.png`), samples[index]);
      }
      await fs.writeFile(path.join(outDir, "stability-report.json"), JSON.stringify({
        stable, sampleCount, stabilityThreshold, pairwiseDiffRatios
      }, null, 2) + "\n");
      throw new Error(`Capture did not stabilize; maximum diff ratio was ${Math.max(...pairwiseDiffRatios)}`);
    }

    const frame = samples.at(-1);
    const framePng = PNG.sync.read(frame);
    const framePath = path.join(outDir, "frame.png");
    await fs.writeFile(framePath, frame);

    let inspector;
    let inspectorBytes;
    const assetHashes = {};
    if (rawArgs.inspector) {
      const inspectorInputPath = path.resolve(rawArgs.inspector);
      const inspectorRoot = await fs.realpath(path.dirname(inspectorInputPath));
      const input = JSON.parse(await fs.readFile(inspectorInputPath, "utf8"));
      inspector = normalizeInspector(input, sourceUrl);
      for (const asset of inspector.assets) {
        const sourceAsset = await fs.realpath(path.resolve(inspectorRoot, asset.path));
        if (!sourceAsset.startsWith(inspectorRoot + path.sep)) {
          throw new UsageError(`Inspector asset "${asset.path}" resolves outside the evidence directory`);
        }
        const bytes = await fs.readFile(sourceAsset);
        const destination = path.join(outDir, asset.path);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, bytes);
        asset.sha256 = sha256(bytes);
        assetHashes[asset.path] = asset.sha256;
      }
      inspectorBytes = Buffer.from(JSON.stringify(inspector, null, 2) + "\n");
      await fs.writeFile(path.join(outDir, "inspector.json"), inspectorBytes);
    }

    const actualDpr = await page.evaluate(() => window.devicePixelRatio);
    const manifest = {
      version: 1,
      inputMode: "figma-browser",
      source: {
        url: sourceUrl,
        nodeId: new URL(sourceUrl).searchParams.get("node-id"),
        view: sourceView,
        accessMode
      },
      capture: {
        capturedAt: new Date().toISOString(),
        method: cdpUrl ? "playwright-cdp" : "playwright-managed",
        browserVersion: browser.version(),
        environmentControl: managed ? "pinned" : "partial",
        viewport: { width, height },
        deviceScaleFactor: actualDpr,
        image: { width: framePng.width, height: framePng.height }
      },
      stability: { sampleCount, sampleDelayMs: sampleDelay, threshold: stabilityThreshold, pairwiseDiffRatios },
      artifacts: {
        frame: { path: "frame.png", sha256: sha256(frame) },
        ...(inspector ? { inspector: { path: "inspector.json", sha256: sha256(inspectorBytes) } } : {}),
        ...(Object.keys(assetHashes).length ? {
          assets: Object.entries(assetHashes).map(([assetPath, hash]) => ({ path: assetPath, sha256: hash }))
        } : {})
      },
      limitations: [
        "Browser capture does not prove a complete Figma node tree.",
        ...(inspector ? [] : ["No confirmed inspector properties were collected."]),
        ...(managed ? [] : ["Existing-session capture has partial environmental control."])
      ]
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    await fs.writeFile(path.join(outDir, "capture-manifest.json"), manifestBytes);
    const integrity = {
      version: 1,
      files: {
        "frame.png": sha256(frame),
        "capture-manifest.json": sha256(manifestBytes),
        ...(inspector ? { "inspector.json": sha256(inspectorBytes) } : {}),
        ...assetHashes
      }
    };
    await fs.writeFile(path.join(outDir, "integrity.json"), JSON.stringify(integrity, null, 2) + "\n");
    return { outDir, manifest, integrity };
  } finally {
    if (page) await page.close().catch(() => {});
    if (managed && browser) await browser.close().catch(() => {});
  }
}

function help() {
  console.log(`Usage: node capture.mjs --url <figma-url> --out-dir <dir> --width <px> --height <px> [options]

Options:
  --dpr <number>                   Managed-browser device scale factor (default 1)
  --source-view <presentation|embed|editor|dev-mode>
  --access-mode <public|session>
  --selector <css>                 Capture one visible DOM element
  --clip <x,y,width,height>        Capture a verified on-screen rectangle
  --wait-selector <css>            Wait for a visible readiness element
  --samples <n>                    Stability samples, at least 3 (default 3)
  --sample-delay <ms>              Delay between samples (default 400)
  --stability-threshold <ratio>    Maximum changed-pixel ratio (default 0.0001)
  --inspector <json>               Validate and seal visible inspector evidence
  --cdp-url <loopback-url>         Attach to an already-authorized local Chromium session
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return help();
  const result = await runCapture(args);
  process.stdout.write(JSON.stringify({ passed: true, outDir: result.outDir, manifest: result.manifest }, null, 2) + "\n");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    const prefix = error instanceof UsageError ? "Usage error" : "Capture failed";
    process.stderr.write(`${prefix}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
