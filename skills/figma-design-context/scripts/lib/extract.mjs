/**
 * Tree walk: raw Figma nodes -> simplified nodes + shared style dictionary.
 *
 * Every generated element carries `data-figma-id` equal to its Figma node id. This
 * is the join key the sibling `visual-fidelity-loop` skill relies on: its
 * expectation manifests select elements by `[data-figma-id='...']` so an automated
 * check can point back at the exact Figma node a mismatch came from. Emit the
 * attribute on every element you generate from this data, not just a few — the
 * loop can't localize a failure to a node it can't select.
 */

import { StyleRegistry, finalizeStyles } from "./styles.mjs";
import { buildFills, buildStrokes, buildEffects, buildBorderRadius } from "./paint.mjs";
import { buildLayout } from "./layout.mjs";
import { hasTextStyle, extractTextStyle, buildFormattedText } from "./text.mjs";
import { buildInteractions, buildVariantProperties } from "./interactions.mjs";

const isVisible = (node) => node.visible !== false;

/** VECTOR nodes render as opaque black boxes without their path data; treat as an image. */
function baseType(node) {
  return node.type === "VECTOR" ? "IMAGE-SVG" : node.type;
}

const SVG_LEAF_TYPES = new Set([
  "IMAGE-SVG",
  "BOOLEAN_OPERATION",
  "STAR",
  "LINE",
  "ELLIPSE",
  "REGULAR_POLYGON",
  "RECTANGLE",
]);
const COLLAPSIBLE_CONTAINERS = new Set(["FRAME", "GROUP", "INSTANCE", "BOOLEAN_OPERATION"]);
// Above this many SVG-eligible children, an auto-layout container is assumed
// decorative (dot grids, noise patterns) rather than authored structure, and gets
// collapsed anyway. Real toolbars/charts rarely exceed this.
const SVG_COLLAPSE_THRESHOLD = 10;

/**
 * Looks up a node's named-style id for one style category, trying a couple of key
 * aliases defensively (observed Figma API responses use lowercase singular keys
 * like `styles.text`/`styles.fill`, but this hedges against variant casing rather
 * than hard-failing named-style detection if that ever turns out to be wrong).
 */
function namedStyleFor(node, keys, namedStyleMeta) {
  if (!node.styles || !namedStyleMeta) return undefined;
  for (const key of keys) {
    const styleId = node.styles[key];
    const meta = styleId && namedStyleMeta[styleId];
    if (meta?.name) return { name: meta.name, id: styleId };
  }
  return undefined;
}

function hasImageFill(node) {
  return Array.isArray(node.fills) && node.fills.some((f) => f.type === "IMAGE" && f.visible !== false);
}

/**
 * Decides whether a container whose children are all vector primitives should
 * collapse into a single IMAGE-SVG leaf (destined for asset export) instead of
 * being reproduced as a nested DOM structure nobody asked for.
 */
function shouldCollapseToSvg(node, children) {
  if (!COLLAPSIBLE_CONTAINERS.has(node.type)) return false;
  if (!children.length || !children.every((c) => SVG_LEAF_TYPES.has(c.type))) return false;
  if (hasImageFill(node) || node.children?.some(hasImageFill)) return false;
  const isAutoLayout = node.layoutMode && node.layoutMode !== "NONE";
  return !isAutoLayout || children.length >= SVG_COLLAPSE_THRESHOLD;
}

/**
 * Figma stores grid children in z-order (paint order), but CSS grid reasons about
 * DOM/reading order. Reordering by cell anchor before emitting keeps generated
 * markup in visual reading order instead of an arbitrary paint-order shuffle.
 * Every child still gets an explicit `gridRow`/`gridColumn` (see buildLayout), so
 * this doesn't affect placement correctness — only how the output reads.
 */
function orderByGridAnchor(children) {
  return [...children].sort((a, b) => {
    const rowDiff = (a.gridRowAnchorIndex ?? 0) - (b.gridRowAnchorIndex ?? 0);
    return rowDiff !== 0 ? rowDiff : (a.gridColumnAnchorIndex ?? 0) - (b.gridColumnAnchorIndex ?? 0);
  });
}

class ExtractionContext {
  constructor() {
    this.styles = new StyleRegistry();
    this.tsCounter = 0;
    // Image fills are safe to record during the walk (collapse never changes
    // whether a fill exists). svgNodeIds is deliberately NOT collected here: a
    // vector leaf's own id would get recorded before its parent has decided
    // whether to collapse and discard it, leaving stale ids for nodes that never
    // make it into the final tree. See collectSvgAssetIds, run post-walk instead.
    this.assets = { imageRefs: new Set() };
  }

  /**
   * Component/variant name for a node id (e.g. `State=hover`), from the file's
   * top-level `components` map. Used to make a `changeTo` action say which state it
   * changes to instead of just quoting an opaque node id.
   */
  resolveComponentName(nodeId) {
    return this.componentMeta?.[nodeId]?.name;
  }

  registerInlineTextDelta(delta) {
    // Own counter/namespace so a base style that happens to serialize identically
    // to an inline delta never returns a style_xxx id: the {tsN} markers are parsed
    // out of `text` strings positionally, not looked up like other style refs.
    this.tsCounter += 1;
    const id = `ts${this.tsCounter}`;
    this.styles.styles[id] = delta;
    return id;
  }
}

function extractNode(node, parent, ctx, { isRoot = false, maxDepth, depth = 0 } = {}) {
  if (!isVisible(node)) return null;

  const out = { id: node.id, name: node.name, type: baseType(node) };

  const layout = buildLayout(node, parent, { isRoot });
  if (Object.keys(layout).length > 1) out.layout = ctx.styles.add(layout, "layout");

  if (hasTextStyle(node)) {
    const { text } = buildFormattedText(node, (delta) => ctx.registerInlineTextDelta(delta));
    if (text) out.text = text;
    const style = extractTextStyle(node);
    if (style) {
      const named = namedStyleFor(node, ["text", "typography"], ctx.namedStyleMeta);
      out.textStyle = named
        ? ctx.styles.addNamed(named.name, named.id, style, "style")
        : ctx.styles.add(style, "style");
    }
  }

  const fills = buildFills(node);
  if (fills) {
    for (const fill of fills) {
      if (fill && typeof fill === "object" && fill.type === "image" && fill.imageRef) {
        ctx.assets.imageRefs.add(fill.imageRef);
      }
    }
    const named = namedStyleFor(node, ["fill", "fills"], ctx.namedStyleMeta);
    out.fills = named
      ? ctx.styles.addNamed(named.name, named.id, fills, "fill")
      : ctx.styles.add(fills, "fill");
  }

  const strokes = buildStrokes(node);
  if (strokes) {
    const named = namedStyleFor(node, ["stroke", "strokes"], ctx.namedStyleMeta);
    out.strokes = named
      ? ctx.styles.addNamed(named.name, named.id, strokes.colors, "fill")
      : ctx.styles.add(strokes.colors, "fill");
    if (strokes.strokeWeight) out.strokeWeight = strokes.strokeWeight;
    if (strokes.strokeWeights) out.strokeWeights = strokes.strokeWeights;
    if (strokes.strokeAlign) out.strokeAlign = strokes.strokeAlign;
    if (strokes.strokeDashes) out.strokeDashes = strokes.strokeDashes;
  }

  const effects = buildEffects(node);
  if (effects) {
    const named = namedStyleFor(node, ["effect", "effects"], ctx.namedStyleMeta);
    out.effects = named
      ? ctx.styles.addNamed(named.name, named.id, effects, "effect")
      : ctx.styles.add(effects, "effect");
  }

  const borderRadius = buildBorderRadius(node);
  if (borderRadius) out.borderRadius = borderRadius;

  if (typeof node.opacity === "number" && node.opacity !== 1) out.opacity = node.opacity;

  if (node.type === "INSTANCE" && node.componentId) {
    out.componentId = node.componentId;
    const componentName = ctx.resolveComponentName(node.componentId);
    if (componentName) out.componentName = componentName;
    if (node.componentProperties) {
      const props = {};
      for (const [key, prop] of Object.entries(node.componentProperties)) {
        props[key.split("#")[0]] = prop.value;
      }
      if (Object.keys(props).length) out.componentProperties = props;
    }
  }

  const variantProperties = buildVariantProperties(node);
  if (variantProperties) out.variantProperties = variantProperties;

  const interactions = buildInteractions(node, (id) => ctx.resolveComponentName(id));
  if (interactions) out.interactions = interactions;

  const atDepthLimit = maxDepth !== undefined && depth >= maxDepth;
  if (!atDepthLimit && Array.isArray(node.children) && node.children.length) {
    const rawChildren = node.layoutMode === "GRID" ? orderByGridAnchor(node.children) : node.children;
    const children = rawChildren
      .map((child) => extractNode(child, node, ctx, { maxDepth, depth: depth + 1 }))
      .filter(Boolean);

    if (children.length) {
      if (shouldCollapseToSvg(node, children)) {
        out.type = "IMAGE-SVG";
      } else {
        out.children = children;
      }
    }
  }

  return out;
}

/** Walks the final (post-collapse) tree, so only nodes actually kept get an export entry. */
function collectSvgAssetIds(nodes, ids = []) {
  for (const node of nodes) {
    if (node.type === "IMAGE-SVG") ids.push(node.id);
    else if (node.children) collectSvgAssetIds(node.children, ids);
  }
  return ids;
}

/**
 * Extracts a Figma node tree into `{ nodes, globalVars }`.
 *
 * @param {object[]} rawNodes Top-level Figma nodes to extract (usually one requested frame).
 * @param {object} [options]
 * @param {number} [options.maxDepth] Stop descending past this depth (root = 0).
 * @param {Record<string, {name: string}>} [options.namedStyleMeta] Figma `styles` metadata
 *   (style id -> name), from the file's top-level `styles` map, used to prefer named
 *   style keys over content-hash ids.
 * @param {Record<string, {name: string}>} [options.componentMeta] Figma `components`
 *   metadata (node id -> name), from the file's top-level `components` map, used to
 *   label component instances and variant-switching interactions by name.
 */
export function extractDesign(rawNodes, { maxDepth, namedStyleMeta, componentMeta } = {}) {
  const ctx = new ExtractionContext();
  ctx.namedStyleMeta = namedStyleMeta;
  ctx.componentMeta = componentMeta;

  const nodes = rawNodes
    .map((node) => extractNode(node, undefined, ctx, { isRoot: true, maxDepth }))
    .filter(Boolean);

  const globalVars = { styles: finalizeStyles(nodes, ctx.styles) };
  const assets = {
    svgNodeIds: collectSvgAssetIds(nodes),
    imageRefs: Array.from(ctx.assets.imageRefs),
  };
  return { nodes, globalVars, assets };
}
