/**
 * Figma URL / identifier parsing.
 *
 * Figma writes node ids two ways: the API speaks `1:23` while share URLs carry
 * `node-id=1-23`. Every id that crosses into an API call has to be normalized or
 * the node silently comes back missing.
 */

const FILE_PATH_RE = /\/(?:file|design|board|proto|slides)\/([a-zA-Z0-9]{10,})/;

/** `1-23` (URL form) -> `1:23` (API form). Already-colon ids pass through. */
export function toApiNodeId(id) {
  return String(id).trim().replace(/-/g, ":");
}

/** `1:23` (API form) -> `1-23` (URL / filename-safe form). */
export function toUrlNodeId(id) {
  return String(id).trim().replace(/:/g, "-");
}

/**
 * Accepts a full Figma URL, a bare file key, or `fileKey/nodeId` and returns
 * `{ fileKey, nodeId }` with `nodeId` in API form (or null when the input points
 * at a whole file).
 */
export function parseFigmaTarget(input) {
  if (!input || typeof input !== "string") {
    throw new Error("Expected a Figma URL or file key.");
  }
  const raw = input.trim();

  if (!/^https?:\/\//i.test(raw)) {
    // Bare forms: "abc123", "abc123/1:23", "abc123#1-23"
    const [fileKey, nodeId] = raw.split(/[/#]/);
    if (!/^[a-zA-Z0-9]{10,}$/.test(fileKey)) {
      throw new Error(
        `"${raw}" is not a Figma URL or file key. Expected a figma.com link or a 10+ character alphanumeric file key.`,
      );
    }
    return { fileKey, nodeId: nodeId ? toApiNodeId(nodeId) : null };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a parseable URL.`);
  }

  const match = url.pathname.match(FILE_PATH_RE);
  if (!match) {
    throw new Error(
      `Could not find a file key in "${raw}". Figma links look like https://www.figma.com/design/<fileKey>/<name>?node-id=1-23`,
    );
  }

  const nodeParam = url.searchParams.get("node-id") ?? url.searchParams.get("node_id");
  return { fileKey: match[1], nodeId: nodeParam ? toApiNodeId(nodeParam) : null };
}

/** Rebuilds a shareable deep link, useful for putting node references in reports. */
export function figmaNodeUrl(fileKey, nodeId) {
  const base = `https://www.figma.com/design/${fileKey}`;
  return nodeId ? `${base}?node-id=${toUrlNodeId(nodeId)}` : base;
}
