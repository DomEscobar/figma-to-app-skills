/**
 * Shared-style registry and the finalize pass that decides what stays shared.
 *
 * A design file repeats the same fill, text style, and layout hundreds of times.
 * Emitting each one inline makes the context balloon and, worse, hides the fact
 * that they are the *same* value — which is exactly the signal needed to generate
 * a component or a design token instead of copy-pasted CSS. So styles are hoisted
 * into a dictionary and referenced by id.
 *
 * Hoisting only pays off when a value is reused, though. A one-off fill costs more
 * as `fills: fill_1a2b3c` plus a dictionary entry than it does inline, and it adds
 * a lookup the reader has to perform. The finalize pass therefore inlines anything
 * used once, keeping the dictionary to values that genuinely represent the system.
 */

import { createHash } from "node:crypto";

/** Deterministic key for a value, so equal values always collide in the cache. */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** Node fields that hold a style reference and may be replaced by an inline value. */
const STYLE_REF_FIELDS = ["layout", "fills", "strokes", "effects", "textStyle"];

// Inline text-style deltas (`ts1`, `ts2`, ...) are referenced from inside `text`
// strings (`{ts1}...{/ts1}`), never from a node field, so the reference counter
// below always sees them as zero-use and would otherwise inline-then-delete them
// out from under the text that points at them. Leave this namespace alone entirely.
const INLINE_TEXT_STYLE_KEY = /^ts\d+$/;

export class StyleRegistry {
  constructor() {
    /** @type {Record<string, unknown>} id -> style value */
    this.styles = {};
    /** Named Figma styles stay hoisted even at a single use: they are stated intent. */
    this.namedKeys = new Set();
    this.byValue = new Map();
  }

  /**
   * Registers `value` and returns its reference id. Ids are content-addressed so the
   * same design produces byte-identical output across runs, which makes diffing two
   * extractions (before/after a design change) meaningful.
   */
  add(value, prefix) {
    const key = stableStringify(value);
    const cached = this.byValue.get(key);
    if (cached) return cached;

    const hash = createHash("sha1").update(key).digest("hex");
    // 8 hex chars keeps references short. On the rare genuine collision, lengthen
    // rather than overwrite — silently aliasing two styles would repaint half the UI.
    let id = `${prefix}_${hash.slice(0, 8)}`;
    for (let length = 12; this.styles[id] !== undefined && length <= hash.length; length += 4) {
      id = `${prefix}_${hash.slice(0, length)}`;
    }

    this.styles[id] = value;
    this.byValue.set(key, id);
    return id;
  }

  /**
   * Registers under the Figma style's own name when the node uses one, so the output
   * says `textStyle: Heading/Large` instead of an opaque hash. Names are not unique
   * across libraries, so a same-name/different-value clash is disambiguated by id.
   */
  addNamed(name, styleId, value, fallbackPrefix) {
    if (!name) return this.add(value, fallbackPrefix);
    let key = name;
    const existing = this.styles[key];
    if (existing !== undefined && stableStringify(existing) !== stableStringify(value)) {
      key = `${name} (${styleId})`;
    }
    this.styles[key] = value;
    this.namedKeys.add(key);
    return key;
  }
}

function countReferences(nodes) {
  const counts = new Map();
  const walk = (list) => {
    for (const node of list) {
      for (const field of STYLE_REF_FIELDS) {
        const ref = node[field];
        if (typeof ref === "string") counts.set(ref, (counts.get(ref) ?? 0) + 1);
      }
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return counts;
}

/**
 * Inlines single-use styles back onto their node and drops entries nothing points
 * at. Mutates `nodes` in place and returns the surviving dictionary.
 */
export function finalizeStyles(nodes, registry) {
  const counts = countReferences(nodes);
  const inline = new Set();
  const drop = new Set();

  for (const key of Object.keys(registry.styles)) {
    if (INLINE_TEXT_STYLE_KEY.test(key)) continue;
    const count = counts.get(key) ?? 0;
    if (registry.namedKeys.has(key)) {
      // A named style with no remaining references is an orphan: its only node was
      // folded away (e.g. a vector collapsed into an SVG placeholder).
      if (count === 0) drop.add(key);
      continue;
    }
    if (count < 2) inline.add(key);
  }

  const walk = (list) => {
    for (const node of list) {
      for (const field of STYLE_REF_FIELDS) {
        const ref = node[field];
        if (typeof ref === "string" && inline.has(ref)) node[field] = registry.styles[ref];
      }
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);

  const surviving = {};
  for (const [key, value] of Object.entries(registry.styles)) {
    if (!inline.has(key) && !drop.has(key)) surviving[key] = value;
  }
  return surviving;
}
