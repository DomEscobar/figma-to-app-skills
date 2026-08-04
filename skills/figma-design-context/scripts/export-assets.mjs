#!/usr/bin/env node
/**
 * CLI: download rendered vectors and image fills referenced by a Figma frame.
 *
 * Two independent asset sources, because Figma exposes them through different
 * endpoints:
 *   - Vector/shape nodes (icons, illustrations collapsed to IMAGE-SVG by
 *     get-context.mjs) are rendered on demand via `GET /v1/images/:key`.
 *   - Image fills (photos placed via a paint) are looked up by `imageRef` via
 *     `GET /v1/files/:key/images`, which returns a stable-for-the-file CDN URL.
 * Both kinds of returned URLs are short-lived or CDN-cached, not meant for the app
 * to load at runtime — download the bytes once, ship them as local assets.
 *
 * Usage:
 *   node export-assets.mjs <figma-url-or-fileKey> --svg-ids 1:2,1:3 --image-refs abcdef... --out-dir ./assets
 *
 * Options:
 *   --token <pat>       Figma personal access token (else FIGMA_API_KEY / FIGMA_TOKEN)
 *   --svg-ids <ids>     Comma-separated node ids to render as SVG (accepts 1:2 or 1-2)
 *   --png-ids <ids>     Comma-separated node ids to render as PNG instead of SVG
 *   --scale <n>         PNG export scale, 1-4 (default 2; ignored for SVG)
 *   --image-refs <refs> Comma-separated imageRef values to resolve as image fills
 *   --out-dir <dir>     Destination directory (default ./assets)
 *   --concurrency <n>   Parallel downloads (default 6 — Figma rate-limits aggressively above this)
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FigmaClient, FigmaError } from "./lib/client.mjs";
import { parseFigmaTarget, toApiNodeId, toUrlNodeId } from "./lib/url.mjs";

function parseArgs(argv) {
  const args = { _: [], concurrency: 6, scale: 2, outDir: "./assets" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--token") args.token = argv[++i];
    else if (a === "--svg-ids") args.svgIds = splitList(argv[++i]);
    else if (a === "--png-ids") args.pngIds = splitList(argv[++i]);
    else if (a === "--image-refs") args.imageRefs = splitList(argv[++i]);
    else if (a === "--scale") args.scale = Number(argv[++i]);
    else if (a === "--out-dir") args.outDir = argv[++i];
    else if (a === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (a === "--help" || a === "-h") args.help = true;
    // Without this, a typo'd or unsupported flag would fall through to the
    // positional list and surface as a baffling "not a Figma URL" error.
    else if (a.startsWith("-")) throw new Error(`Unknown option "${a}". Run with --help for the supported ones.`);
    else args._.push(a);
  }
  return args;
}

function splitList(value) {
  if (!value || value === "-") return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function printHelp() {
  console.log(`Usage: node export-assets.mjs <figma-url-or-fileKey> [options]

Options:
  --token <pat>        Figma personal access token
  --svg-ids <ids>       Comma-separated node ids to render as SVG
  --png-ids <ids>       Comma-separated node ids to render as PNG
  --scale <n>           PNG export scale 1-4 (default 2)
  --image-refs <refs>   Comma-separated imageRef values (from fills of type "image")
  --out-dir <dir>       Destination directory (default ./assets)
  --concurrency <n>     Parallel downloads (default 6)
`);
}

/** Runs `worker` over `items` with at most `limit` in flight at once. */
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runOne() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
  return results;
}

async function downloadTo(url, filePath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(filePath, buffer);
  return buffer.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args._.length) return printHelp();

  const svgIds = (args.svgIds ?? []).map(toApiNodeId);
  const pngIds = (args.pngIds ?? []).map(toApiNodeId);
  const imageRefs = args.imageRefs ?? [];
  if (!svgIds.length && !pngIds.length && !imageRefs.length) {
    console.error("Nothing to export: pass --svg-ids, --png-ids, and/or --image-refs.");
    process.exitCode = 1;
    return;
  }

  const { fileKey } = parseFigmaTarget(args._[0]);
  const client = new FigmaClient({
    token: args.token,
    log: (msg) => process.stderr.write(`[figma] ${msg}\n`),
  });

  await mkdir(args.outDir, { recursive: true });
  const manifest = { svg: {}, png: {}, images: {} };

  if (svgIds.length) {
    console.error(`Rendering ${svgIds.length} node(s) as SVG...`);
    // One /v1/images call renders every requested node in a single batch — far
    // cheaper against the rate limit than one call per icon.
    const { images, err } = await client.images(fileKey, svgIds, { format: "svg" });
    if (err) throw new FigmaError(`Figma image render failed: ${err}`, { endpoint: "/v1/images" });
    await runPool(svgIds, args.concurrency, async (id) => {
      const url = images[id];
      if (!url) {
        console.error(`  no render returned for ${id} (node may be empty or invisible)`);
        return;
      }
      const filename = `${toUrlNodeId(id)}.svg`;
      const bytes = await downloadTo(url, join(args.outDir, filename));
      manifest.svg[id] = filename;
      console.error(`  ${id} -> ${filename} (${bytes.toLocaleString()} bytes)`);
    });
  }

  if (pngIds.length) {
    console.error(`Rendering ${pngIds.length} node(s) as PNG at ${args.scale}x...`);
    const { images, err } = await client.images(fileKey, pngIds, { format: "png", scale: args.scale });
    if (err) throw new FigmaError(`Figma image render failed: ${err}`, { endpoint: "/v1/images" });
    await runPool(pngIds, args.concurrency, async (id) => {
      const url = images[id];
      if (!url) {
        console.error(`  no render returned for ${id}`);
        return;
      }
      const filename = `${toUrlNodeId(id)}@${args.scale}x.png`;
      const bytes = await downloadTo(url, join(args.outDir, filename));
      manifest.png[id] = filename;
      console.error(`  ${id} -> ${filename} (${bytes.toLocaleString()} bytes)`);
    });
  }

  if (imageRefs.length) {
    console.error(`Resolving ${imageRefs.length} image fill(s)...`);
    // Unlike /v1/images (render), this endpoint nests its map under `meta` and
    // reports failure via `error`/`status`, not a top-level `err` string.
    const { error, status, meta } = await client.imageFills(fileKey);
    if (error) {
      throw new FigmaError(`Figma image-fill lookup failed (status ${status}).`, {
        endpoint: "/v1/files/:key/images",
      });
    }
    const images = meta?.images ?? {};
    await runPool(imageRefs, args.concurrency, async (ref) => {
      const url = images[ref];
      if (!url) {
        console.error(`  no URL for imageRef ${ref} (fill may have been deleted from the file)`);
        return;
      }
      const filename = `${ref}.png`;
      const bytes = await downloadTo(url, join(args.outDir, filename));
      manifest.images[ref] = filename;
      console.error(`  ${ref} -> ${filename} (${bytes.toLocaleString()} bytes)`);
    });
  }

  const manifestPath = join(args.outDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  console.error(`\nWrote ${manifestPath} — maps Figma node ids / imageRefs to local filenames.`);
}

main().catch((error) => {
  if (error instanceof FigmaError) {
    console.error(`Error: ${error.message}`);
    if (error.hint) console.error(`Hint: ${error.hint}`);
    process.exitCode = 1;
    return;
  }
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
