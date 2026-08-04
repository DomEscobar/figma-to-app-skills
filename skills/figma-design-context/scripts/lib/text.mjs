/**
 * Text extraction: TypeStyle -> CSS-shaped style, plus per-character overrides
 * folded into inline spans.
 *
 * Figma stores rich text as one `characters` string plus a parallel
 * `characterStyleOverrides` index array pointing into `styleOverrideTable`. Emitting
 * that structure raw (three parallel arrays) is unreadable and token-heavy. Instead,
 * consecutive characters sharing the same override are grouped into a run, and each
 * run's style is diffed against the node's base style so the emitted delta only
 * contains what actually changed (e.g. `{ fontWeight: 700 }` for one bolded word,
 * not a full style object). Deltas are deduplicated through the same registry the
 * node-level styles use, referenced inline as `{ts3}bolded word{/ts3}`.
 */

import { cssColor } from "./paint.mjs";

const round = (n, places = 2) => {
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
};

const TEXT_CASE = { UPPER: "uppercase", LOWER: "lowercase", TITLE: "capitalize" };
const TEXT_ALIGN_H = { LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "justify" };
const TEXT_ALIGN_V = { TOP: "top", CENTER: "middle", BOTTOM: "bottom" };
const TEXT_DECORATION = { UNDERLINE: "underline", STRIKETHROUGH: "line-through" };

/**
 * Converts one Figma TypeStyle to a flat CSS-ish style object. Shared between the
 * node's base style and each per-character override delta, so both use identical
 * field names and can be diffed against each other directly.
 */
function typeStyleToCss(style = {}) {
  const css = {};
  if (style.fontFamily) css.fontFamily = style.fontFamily;
  if (style.fontWeight !== undefined) css.fontWeight = style.fontWeight;
  if (style.fontSize !== undefined) css.fontSize = `${round(style.fontSize)}px`;

  if (style.lineHeightPercentFontSize !== undefined) {
    // Figma's most direct line-height representation for codegen: a unitless
    // multiplier of the font size, same as CSS's unitless `line-height`.
    css.lineHeight = round(style.lineHeightPercentFontSize / 100, 3);
  } else if (style.lineHeightPx !== undefined) {
    css.lineHeight = `${round(style.lineHeightPx)}px`;
  } else if (style.lineHeightPercent !== undefined && style.lineHeightPercent !== 100) {
    css.lineHeight = round(style.lineHeightPercent / 100, 3);
  }

  if (style.letterSpacing) css.letterSpacing = `${round(style.letterSpacing)}px`;
  if (style.textAlignHorizontal && TEXT_ALIGN_H[style.textAlignHorizontal] !== "left") {
    css.textAlign = TEXT_ALIGN_H[style.textAlignHorizontal];
  }
  if (style.textAlignVertical && TEXT_ALIGN_V[style.textAlignVertical] !== "top") {
    css.verticalAlign = TEXT_ALIGN_V[style.textAlignVertical];
  }
  if (style.textCase && TEXT_CASE[style.textCase]) css.textTransform = TEXT_CASE[style.textCase];
  if (style.textDecoration && TEXT_DECORATION[style.textDecoration]) {
    css.textDecoration = TEXT_DECORATION[style.textDecoration];
  }
  if (style.italic) css.fontStyle = "italic";
  if (Array.isArray(style.fills) && style.fills.length) {
    const solid = style.fills.find((f) => f.type === "SOLID" && f.visible !== false);
    if (solid) css.color = cssColor(solid.color, solid.opacity ?? 1);
  }
  return css;
}

export function hasTextStyle(node) {
  return node.type === "TEXT" && !!node.style;
}

export function extractTextStyle(node) {
  const css = typeStyleToCss(node.style);
  return Object.keys(css).length ? css : null;
}

/** Only the keys of `delta` that differ from `base`, so unaffected properties don't repeat. */
function diffStyle(base, delta) {
  const out = {};
  for (const [key, value] of Object.entries(delta)) {
    if (base[key] !== value) out[key] = value;
  }
  return out;
}

/** Escapes the two characters that would otherwise be mistaken for span markers. */
function escapeText(text) {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "\\{");
}

/**
 * Builds the display text for a TEXT node, wrapping character runs that carry a
 * style override in `{tsN}...{/tsN}` markers.
 *
 * @param node Raw Figma TEXT node.
 * @param registerDelta `(delta) => id` — caller supplies this so the id comes from
 *   the same dedup/finalize machinery as every other style reference.
 * @returns `{ text }` — plain string when there are no overrides worth preserving.
 */
export function buildFormattedText(node, registerDelta) {
  const characters = node.characters ?? "";
  if (!characters) return { text: "" };

  const overrides = node.characterStyleOverrides;
  const table = node.styleOverrideTable;
  if (!Array.isArray(overrides) || !overrides.length || !table) {
    return { text: escapeText(characters) };
  }

  const baseCss = typeStyleToCss(node.style);
  let result = "";
  let runStart = 0;
  let runOverrideId = overrides[0] ?? 0;

  const flushRun = (end) => {
    const chunk = escapeText(characters.slice(runStart, end));
    if (!runOverrideId || !table[runOverrideId]) {
      result += chunk;
      return;
    }
    const delta = diffStyle(baseCss, typeStyleToCss(table[runOverrideId]));
    if (!Object.keys(delta).length) {
      result += chunk;
      return;
    }
    const id = registerDelta(delta);
    result += `{${id}}${chunk}{/${id}}`;
  };

  for (let i = 1; i <= characters.length; i++) {
    const overrideId = overrides[i] ?? 0;
    if (i === characters.length || overrideId !== runOverrideId) {
      flushRun(i);
      runStart = i;
      runOverrideId = overrideId;
    }
  }

  return { text: result };
}
