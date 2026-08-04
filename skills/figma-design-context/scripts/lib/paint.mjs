/**
 * Paint, stroke, and effect conversion: Figma's paint model -> CSS-shaped values.
 *
 * Figma stores colour channels as 0..1 floats and stacks paints bottom-first, which
 * is the opposite of every CSS convention. Emitting that raw makes a model guess,
 * and it usually guesses the bottom layer. So colours become hex/rgba strings and
 * fully-solid stacks are composited down to the one colour a viewer actually sees.
 */

const round = (n, places = 2) => {
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
};

const channel = (value) => Math.round(value * 255);

/** Figma RGBA (0..1) -> `#RRGGBB`, or `rgba(...)` when not fully opaque. */
export function cssColor({ r, g, b, a = 1 }, opacity = 1) {
  const alpha = round(a * opacity);
  const [R, G, B] = [channel(r), channel(g), channel(b)];
  if (alpha >= 1) {
    return `#${[R, G, B].map((c) => c.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
  }
  return `rgba(${R}, ${G}, ${B}, ${alpha})`;
}

const isVisible = (item) => item?.visible !== false;

/** Only normally-blended solids can be composited without knowing the backdrop. */
const isFlattenableSolid = (paint) =>
  paint.type === "SOLID" &&
  (paint.blendMode === undefined || paint.blendMode === "NORMAL" || paint.blendMode === "PASS_THROUGH");

/** Source-over composite, straight alpha, channels 0..1. */
function compositeOver(top, bottom) {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t, b) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

/**
 * Collapses an all-solid stack to a single colour, or returns null when the stack
 * contains a gradient, image, or exotic blend mode that cannot be folded.
 * `paints` must be in Figma order (index 0 = bottom).
 */
export function flattenSolids(paints) {
  if (!paints.length || !paints.every(isFlattenableSolid)) return null;
  const straight = (p) => ({ r: p.color.r, g: p.color.g, b: p.color.b, a: p.color.a * (p.opacity ?? 1) });
  let acc = straight(paints[0]);
  for (let i = 1; i < paints.length; i++) acc = compositeOver(straight(paints[i]), acc);
  return cssColor(acc);
}

/**
 * Gradient handles are three points in normalized node space: origin, end of the
 * primary axis, and end of the perpendicular axis. CSS only takes an angle, so the
 * primary axis is converted to degrees; anything relying on the third handle
 * (skewed or elliptical gradients) is approximated and flagged.
 *
 * The +90 term converts Figma's handle-vector angle (measured from +x) into CSS
 * gradient-angle convention (measured from +y / "up", clockwise).
 */
function gradientAngleDeg([origin, end] = []) {
  if (!origin || !end) return 180;
  const dx = end.x - origin.x;
  const dy = end.y - origin.y;
  return round((Math.atan2(dy, dx) * 180) / Math.PI + 90, 1);
}

function gradientStops(paint) {
  return (paint.gradientStops ?? [])
    .map((stop) => `${cssColor(stop.color, paint.opacity ?? 1)} ${round(stop.position * 100, 1)}%`)
    .join(", ");
}

function parseGradient(paint) {
  const stops = gradientStops(paint);
  switch (paint.type) {
    case "GRADIENT_LINEAR":
      return { type: "gradient", css: `linear-gradient(${gradientAngleDeg(paint.gradientHandlePositions)}deg, ${stops})` };
    case "GRADIENT_RADIAL":
      return { type: "gradient", css: `radial-gradient(circle at ${radialCenter(paint)}, ${stops})` };
    case "GRADIENT_ANGULAR":
      return {
        type: "gradient",
        css: `conic-gradient(from ${gradientAngleDeg(paint.gradientHandlePositions)}deg at ${radialCenter(paint)}, ${stops})`,
      };
    case "GRADIENT_DIAMOND":
      // No CSS equivalent; an elliptical gradient is the closest approximation.
      return {
        type: "gradient",
        css: `radial-gradient(ellipse at ${radialCenter(paint)}, ${stops})`,
        note: "Figma diamond gradient approximated as an ellipse",
      };
    default:
      return { type: paint.type };
  }
}

function radialCenter(paint) {
  const origin = paint.gradientHandlePositions?.[0];
  if (!origin) return "50% 50%";
  return `${round(origin.x * 100, 1)}% ${round(origin.y * 100, 1)}%`;
}

const SCALE_MODE_TO_OBJECT_FIT = { FILL: "cover", FIT: "contain", TILE: "repeat", STRETCH: "fill" };

/**
 * Converts one paint. `imageRef` is preserved rather than resolved, because turning
 * refs into URLs takes a separate API call — the asset exporter does that in one
 * batch instead of once per node.
 */
export function parsePaint(paint) {
  if (paint.type === "SOLID") {
    return cssColor(paint.color, paint.opacity ?? 1);
  }
  if (paint.type === "IMAGE") {
    return {
      type: "image",
      imageRef: paint.imageRef,
      objectFit: SCALE_MODE_TO_OBJECT_FIT[paint.scaleMode] ?? "cover",
      ...(paint.scalingFactor ? { scalingFactor: round(paint.scalingFactor, 3) } : {}),
      ...(paint.opacity !== undefined && paint.opacity !== 1 ? { opacity: round(paint.opacity) } : {}),
    };
  }
  if (paint.type?.startsWith("GRADIENT_")) return parseGradient(paint);
  if (paint.type === "PATTERN") return { type: "pattern", note: "Figma pattern fill; export the node as an image" };
  return { type: paint.type };
}

/** Fills for one node, folded to a single colour when possible. */
export function buildFills(node) {
  const fills = Array.isArray(node.fills) ? node.fills.filter(isVisible) : [];
  if (!fills.length) return null;
  const flattened = flattenSolids(fills);
  if (flattened) return [flattened];
  // Reverse so index 0 is the topmost paint, matching how CSS backgrounds read.
  return fills.map(parsePaint).reverse();
}

/**
 * Strokes, kept as a colour array plus plain sibling fields. Figma named styles only
 * cover the paint, so width/align/dashes must not be folded into a shared style id.
 */
export function buildStrokes(node) {
  const strokes = Array.isArray(node.strokes) ? node.strokes.filter(isVisible) : [];
  if (!strokes.length) return null;

  const result = { colors: strokes.map(parsePaint).reverse() };
  const { individualStrokeWeights: sides } = node;
  if (sides) {
    result.strokeWeights = `${sides.top}px ${sides.right}px ${sides.bottom}px ${sides.left}px`;
  } else if (typeof node.strokeWeight === "number") {
    result.strokeWeight = `${node.strokeWeight}px`;
  }
  if (node.strokeAlign) result.strokeAlign = node.strokeAlign.toLowerCase();
  if (node.strokeDashes?.length) result.strokeDashes = node.strokeDashes.join(" ");
  return result;
}

/**
 * Effects, split by CSS destination: drop/inner shadows become `box-shadow`, blurs
 * become `filter` or `backdrop-filter`. Grouping them this way saves the consumer
 * from having to know which Figma effect maps to which CSS property.
 */
export function buildEffects(node) {
  const effects = Array.isArray(node.effects) ? node.effects.filter(isVisible) : [];
  if (!effects.length) return null;

  const boxShadow = [];
  const filter = [];
  const backdropFilter = [];
  const textShadow = [];

  for (const effect of effects) {
    const offsetX = round(effect.offset?.x ?? 0);
    const offsetY = round(effect.offset?.y ?? 0);
    const blur = round(effect.radius ?? 0);
    const spread = round(effect.spread ?? 0);
    const color = effect.color ? cssColor(effect.color) : "rgba(0, 0, 0, 0.25)";

    switch (effect.type) {
      case "DROP_SHADOW":
        boxShadow.push(`${offsetX}px ${offsetY}px ${blur}px ${spread}px ${color}`);
        textShadow.push(`${offsetX}px ${offsetY}px ${blur}px ${color}`);
        break;
      case "INNER_SHADOW":
        boxShadow.push(`inset ${offsetX}px ${offsetY}px ${blur}px ${spread}px ${color}`);
        break;
      case "LAYER_BLUR":
        filter.push(`blur(${blur}px)`);
        break;
      case "BACKGROUND_BLUR":
        backdropFilter.push(`blur(${blur}px)`);
        break;
      default:
        break;
    }
  }

  const result = {};
  if (boxShadow.length) {
    result.boxShadow = boxShadow.join(", ");
    // Text nodes cannot take box-shadow; carry the equivalent so the consumer can pick.
    if (node.type === "TEXT" && textShadow.length) result.textShadow = textShadow.join(", ");
  }
  if (filter.length) result.filter = filter.join(" ");
  if (backdropFilter.length) result.backdropFilter = backdropFilter.join(" ");
  return Object.keys(result).length ? result : null;
}

/** Corner radius as a CSS shorthand, collapsing uniform corners to one value. */
export function buildBorderRadius(node) {
  const corners = node.rectangleCornerRadii;
  if (Array.isArray(corners) && corners.length === 4) {
    const [tl, tr, br, bl] = corners;
    if (tl === tr && tr === br && br === bl) return tl ? `${tl}px` : undefined;
    return `${tl}px ${tr}px ${br}px ${bl}px`;
  }
  if (typeof node.cornerRadius === "number" && node.cornerRadius > 0) return `${node.cornerRadius}px`;
  return undefined;
}
