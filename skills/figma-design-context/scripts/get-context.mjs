#!/usr/bin/env node
/**
 * CLI: fetch a Figma file/frame and print a simplified, token-efficient YAML
 * representation designed to be read by a coding agent generating UI code.
 *
 * Usage:
 *   node get-context.mjs <figma-url-or-fileKey> [options]
 *
 * Options:
 *   --token <pat>      Figma personal access token (else FIGMA_API_KEY / FIGMA_TOKEN env var)
 *   --node-id <id>     Frame to fetch (accepts 1:2 or 1-2); overrides any node-id in the URL
 *   --depth <n>        Max traversal depth below the requested node (default: unlimited)
 *   --out <path>       Write YAML to a file instead of stdout
 *   --no-cache         Bypass the on-disk response cache
 *   --raw              Also write the untouched Figma JSON alongside (for debugging)
 *
 * Examples:
 *   node get-context.mjs "https://www.figma.com/design/abc123/App?node-id=12-34" --out frame.yaml
 *   node get-context.mjs abc123 --node-id 12-34 --out frame.yaml
 *   node get-context.mjs abc123 --depth 3
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { FigmaClient, FigmaError } from "./lib/client.mjs";
import { parseFigmaTarget, toApiNodeId } from "./lib/url.mjs";
import { extractDesign } from "./lib/extract.mjs";
import { toYaml } from "./lib/yaml.mjs";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--token") args.token = argv[++i];
    else if (a === "--node-id") args.nodeId = argv[++i];
    else if (a === "--depth") args.depth = Number(argv[++i]);
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--no-cache") args.noCache = true;
    else if (a === "--raw") args.raw = true;
    else if (a === "--help" || a === "-h") args.help = true;
    // Without this, a typo'd or unsupported flag would fall through to the
    // positional list and surface as a baffling "not a Figma URL" error.
    else if (a.startsWith("-")) throw new Error(`Unknown option "${a}". Run with --help for the supported ones.`);
    else args._.push(a);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node get-context.mjs <figma-url-or-fileKey> [options]

Options:
  --token <pat>   Figma personal access token (else FIGMA_API_KEY / FIGMA_TOKEN)
  --node-id <id>  Frame to fetch (1:2 or 1-2); overrides a node-id in the URL
  --depth <n>     Max traversal depth below the requested node
  --out <path>    Write YAML to a file instead of stdout
  --no-cache      Bypass the on-disk response cache
  --raw           Also dump the untouched Figma JSON next to --out, suffixed .raw.json
  -h, --help      Show this help
`);
}

/**
 * Figma exposes named styles and components at the file's top level, keyed by id;
 * index both to `{ name }` so the extractor can prefer names over opaque ids.
 */
function collectNameMeta(fileLevelMap) {
  const meta = {};
  for (const [id, entry] of Object.entries(fileLevelMap ?? {})) {
    meta[id] = { name: entry.name };
  }
  return meta;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args._.length) return printHelp();

  const target = parseFigmaTarget(args._[0]);
  const fileKey = target.fileKey;
  const nodeId = args.nodeId ? toApiNodeId(args.nodeId) : target.nodeId;
  const client = new FigmaClient({
    token: args.token,
    cacheDir: args.noCache ? null : ".figma-cache",
    log: (msg) => process.stderr.write(`[figma] ${msg}\n`),
  });

  let rawNodes;
  let namedStyleMeta;
  let componentMeta;

  if (nodeId) {
    const response = await client.nodes(fileKey, [nodeId], { depth: args.depth });
    const entry = response.nodes?.[nodeId];
    if (!entry) {
      throw new FigmaError(`Node ${nodeId} was not found in file ${fileKey}.`, {
        hint: "Double-check the node-id — it may belong to a different file, or the node may have been deleted since the link was shared.",
      });
    }
    rawNodes = [entry.document];
    namedStyleMeta = collectNameMeta(entry.styles ?? response.styles);
    componentMeta = collectNameMeta(entry.components ?? response.components);
  } else {
    // No specific frame was requested. Defaulting to unlimited depth on a whole
    // file risks the large-payload timeouts Figma's own docs attribute to
    // oversized requests — shallow-scan first unless the caller explicitly asked
    // for more, per the "safe defaults" guidance in references/figma-rest-api.md.
    const depth = args.depth ?? 2;
    if (args.depth === undefined) {
      console.error(
        `No node-id in the URL and no --depth given — defaulting to --depth 2 (pages + top-level frames) ` +
          `to avoid a slow/oversized whole-file fetch. Pass --depth for more, or re-run with a node-id for one frame.`,
      );
    }
    const file = await client.file(fileKey, { depth });
    rawNodes = file.document.children; // top-level canvases/pages
    namedStyleMeta = collectNameMeta(file.styles);
    componentMeta = collectNameMeta(file.components);
  }

  const { nodes, globalVars, assets } = extractDesign(rawNodes, {
    maxDepth: args.depth,
    namedStyleMeta,
    componentMeta,
  });
  const yaml = toYaml({
    fileKey,
    nodeId: nodeId ?? undefined,
    nodes,
    globalVars,
    assets: assets.svgNodeIds.length || assets.imageRefs.length ? assets : undefined,
  });

  if (args.out) {
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, yaml, "utf8");
    console.error(`Wrote ${args.out} (${yaml.length.toLocaleString()} bytes)`);
    if (args.raw) {
      const rawPath = args.out.replace(/\.ya?ml$/i, "") + ".raw.json";
      await writeFile(rawPath, JSON.stringify(rawNodes, null, 2), "utf8");
      console.error(`Wrote ${rawPath}`);
    }
  } else {
    process.stdout.write(yaml);
  }

  if (assets.svgNodeIds.length || assets.imageRefs.length) {
    console.error(
      `\n${assets.svgNodeIds.length} vector node(s) and ${assets.imageRefs.length} image fill(s) referenced. ` +
        `Run export-assets.mjs against the same target to download them:\n` +
        `  node export-assets.mjs "${args._[0]}" --svg-ids ${assets.svgNodeIds.join(",") || "-"} --image-refs ${assets.imageRefs.join(",") || "-"} --out-dir ./assets`,
    );
  }
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
