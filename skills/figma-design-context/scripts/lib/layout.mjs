/**
 * Layout conversion: Figma auto-layout -> CSS flex/grid vocabulary.
 *
 * This is where design-to-code usually goes wrong. Figma describes a child's size
 * with properties keyed to the *parent's* axes (`layoutGrow` means "grow along the
 * parent's main axis"), while CSS describes it with axis-named properties. Reading
 * `layoutGrow` as "width" is correct in a row and wrong in a column, and the bug is
 * invisible until the page is rendered. Resolving the parent's axis once, up front,
 * is what keeps the rest of the mapping honest.
 *
 * A second trap: emitting `width` from `absoluteBoundingBox` for every node. Those
 * numbers are the size the frame happened to be at export time. Pinning them turns
 * a responsive auto-layout into a rigid pixel canvas. Dimensions are therefore
 * emitted only for axes Figma marks `FIXED`.
 */

const FRAME_TYPES = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE"]);

const isFrame = (node) => !!node && FRAME_TYPES.has(node.type);

const hasAutoLayout = (node) =>
  isFrame(node) && !!node.layoutMode && node.layoutMode !== "NONE";

/**
 * True when the node participates in its parent's auto-layout flow. Children marked
 * `ABSOLUTE` sit outside the flow even inside an auto-layout frame, and their
 * `layoutGrow`/`layoutAlign` values are stale leftovers that must be ignored.
 */
const isInFlow = (node, parent) =>
  hasAutoLayout(parent) && node.layoutPositioning !== "ABSOLUTE";

function layoutModeToCss(layoutMode) {
  switch (layoutMode) {
    case "HORIZONTAL":
      return "row";
    case "VERTICAL":
      return "column";
    case "GRID":
      return "grid";
    default:
      return "none";
  }
}

const PRIMARY_ALIGN = {
  MIN: "flex-start",
  CENTER: "center",
  MAX: "flex-end",
  SPACE_BETWEEN: "space-between",
};

const COUNTER_ALIGN = {
  MIN: "flex-start",
  CENTER: "center",
  MAX: "flex-end",
  BASELINE: "baseline",
};

const SELF_ALIGN = {
  MIN: undefined, // flex-start is the default; emitting it is noise
  INHERIT: undefined, // newer Figma API: "no override" — same as MIN for our purposes
  CENTER: "center",
  MAX: "flex-end",
  STRETCH: "stretch",
};

const SIZING = { FIXED: "fixed", FILL: "fill", HUG: "hug" };

/** Collapses the four padding values into the tightest CSS shorthand. */
function paddingShorthand(node) {
  const top = node.paddingTop ?? 0;
  const right = node.paddingRight ?? 0;
  const bottom = node.paddingBottom ?? 0;
  const left = node.paddingLeft ?? 0;
  if (!(top || right || bottom || left)) return undefined;
  if (top === right && right === bottom && bottom === left) return `${top}px`;
  if (top === bottom && left === right) return `${top}px ${right}px`;
  return `${top}px ${right}px ${bottom}px ${left}px`;
}

/**
 * Gap shorthand. A lone zero is CSS's default and gets omitted; a zero paired with a
 * non-zero value has to stay, because `gap: 0 16px` means something different from
 * `gap: 16px`.
 */
function gapShorthand(rowGap, columnGap) {
  if (rowGap === undefined && columnGap === undefined) return undefined;
  if (rowGap !== undefined && columnGap !== undefined) {
    if (rowGap === 0 && columnGap === 0) return undefined;
    return rowGap === columnGap ? `${rowGap}px` : `${rowGap}px ${columnGap}px`;
  }
  const single = rowGap ?? columnGap;
  return single ? `${single}px` : undefined;
}

/** The axis a child's stretch flags should be read against. */
function resolveChildAxis(node, parent, ownMode) {
  if (parent?.layoutMode === "GRID") return "grid";
  if (isInFlow(node, parent)) return layoutModeToCss(parent.layoutMode);
  return ownMode === "row" || ownMode === "column" ? ownMode : "none";
}

/** Per-axis "does this child stretch?", normalizing Figma's flex and grid dialects. */
function childStretch(node, axis) {
  switch (axis) {
    case "grid":
      return {
        horizontal: node.layoutSizingHorizontal === "FILL",
        vertical: node.layoutSizingVertical === "FILL",
      };
    case "row":
      return { horizontal: !!node.layoutGrow, vertical: node.layoutAlign === "STRETCH" };
    case "column":
      return { horizontal: node.layoutAlign === "STRETCH", vertical: !!node.layoutGrow };
    default:
      return { horizontal: false, vertical: false };
  }
}

/**
 * Grid children carry explicit row/column anchors, which are far more reliable than
 * inferring cells from coordinates. CSS grid lines are 1-based.
 */
function gridPlacement(node) {
  const placement = {};
  const { gridRowAnchorIndex: row, gridColumnAnchorIndex: column, gridRowSpan, gridColumnSpan } = node;
  if (typeof row === "number") {
    placement.gridRow = gridRowSpan > 1 ? `${row + 1} / span ${gridRowSpan}` : String(row + 1);
  }
  if (typeof column === "number") {
    placement.gridColumn =
      gridColumnSpan > 1 ? `${column + 1} / span ${gridColumnSpan}` : String(column + 1);
  }
  return placement;
}

/** Figma grid track sizes ("FIXED" with a value, "FLEX" with a weight) -> CSS tracks. */
function gridTracks(sizes) {
  if (!Array.isArray(sizes) || !sizes.length) return undefined;
  return sizes
    .map((track) => {
      if (track?.type === "FIXED" && typeof track.value === "number") return `${track.value}px`;
      if (track?.type === "FLEX") return track.value > 1 ? `${track.value}fr` : "1fr";
      return "auto";
    })
    .join(" ");
}

/**
 * Builds the layout description for one node.
 *
 * @param {object} node Raw Figma node.
 * @param {object} [parent] Raw Figma parent, needed to interpret the child's flags.
 * @param {{ isRoot?: boolean }} [options] The requested root's own size is contextual —
 *   it fills whatever it is placed into — so it is reported separately from a hard size.
 */
export function buildLayout(node, parent, { isRoot = false } = {}) {
  const mode = layoutModeToCss(node.layoutMode);
  const layout = { mode };

  if (mode === "row" || mode === "column") {
    const justify = PRIMARY_ALIGN[node.primaryAxisAlignItems];
    const align = COUNTER_ALIGN[node.counterAxisAlignItems];
    if (justify && justify !== "flex-start") layout.justifyContent = justify;
    if (align && align !== "flex-start") layout.alignItems = align;
    const wrapping = node.layoutWrap === "WRAP";
    if (wrapping) layout.wrap = true;

    // `itemSpacing` is the gap along the main axis, so which CSS axis it lands on
    // depends on the direction. `counterAxisSpacing` is the between-lines gap and
    // only applies while wrapping. Figma's "auto" spacing is encoded as
    // SPACE_BETWEEN and leaves a stale `itemSpacing` behind, which would fight
    // space-between as an enforced minimum — so it is dropped in that case.
    const mainGap = node.primaryAxisAlignItems === "SPACE_BETWEEN" ? undefined : node.itemSpacing;
    const lineGap = wrapping ? (node.counterAxisSpacing ?? undefined) : undefined;
    const gap = mode === "row" ? gapShorthand(lineGap, mainGap) : gapShorthand(mainGap, lineGap);
    if (gap) layout.gap = gap;
  }

  if (mode === "grid") {
    const columns = gridTracks(node.gridColumnSizes);
    const rows = gridTracks(node.gridRowSizes);
    if (columns) layout.gridTemplateColumns = columns;
    if (rows) layout.gridTemplateRows = rows;
    const gap = gapShorthand(node.gridRowGap, node.gridColumnGap);
    if (gap) layout.gap = gap;
  }

  const padding = paddingShorthand(node);
  if (padding) layout.padding = padding;

  // --- The node as a child of its parent -------------------------------------
  const axis = resolveChildAxis(node, parent, mode);
  const stretch = childStretch(node, axis);

  if (isInFlow(node, parent)) {
    const selfAlign = SELF_ALIGN[node.layoutAlign];
    if (selfAlign && selfAlign !== "stretch") layout.alignSelf = selfAlign;
  }

  if (parent?.layoutMode === "GRID") Object.assign(layout, gridPlacement(node));

  const horizontal = SIZING[node.layoutSizingHorizontal] ?? (stretch.horizontal ? "fill" : undefined);
  const vertical = SIZING[node.layoutSizingVertical] ?? (stretch.vertical ? "fill" : undefined);
  if (horizontal || vertical) {
    layout.sizing = {
      ...(horizontal ? { horizontal: isRoot ? "contextual" : horizontal } : {}),
      ...(vertical ? { vertical: isRoot ? "contextual" : vertical } : {}),
    };
  }

  // --- Geometry ---------------------------------------------------------------
  const box = node.absoluteBoundingBox;
  if (box) {
    const width = Math.round(box.width);
    const height = Math.round(box.height);

    if (isRoot) {
      // Reported, but named so it cannot be mistaken for a pinned size.
      layout.designedWidth = `${width}px`;
      layout.designedHeight = `${height}px`;
    } else {
      const dimensions = {};
      if (emitsFixedDimension(node.layoutSizingHorizontal, axis) && !stretch.horizontal) {
        dimensions.width = width;
      }
      if (emitsFixedDimension(node.layoutSizingVertical, axis) && !stretch.vertical) {
        dimensions.height = height;
      }
      if (Object.keys(dimensions).length) layout.dimensions = dimensions;
    }

    // Absolutely-positioned children need an offset relative to their parent, since
    // Figma only gives absolute canvas coordinates.
    const outOfFlow = node.layoutPositioning === "ABSOLUTE" || (parent && !hasAutoLayout(parent));
    if (outOfFlow && parent?.absoluteBoundingBox) {
      layout.position = "absolute";
      layout.offsetFromParent = {
        x: Math.round(box.x - parent.absoluteBoundingBox.x),
        y: Math.round(box.y - parent.absoluteBoundingBox.y),
      };
    }
  }

  // clipsContent clips regardless of layout mode — a free-positioned FRAME with
  // an oversized/rotated child (a common decorative pattern) still needs it.
  if (node.clipsContent === true) layout.overflow = "hidden";
  if (typeof node.rotation === "number" && Math.abs(node.rotation) > 0.001) {
    layout.rotation = `${Math.round((node.rotation * 180) / Math.PI)}deg`;
  }

  return layout;
}

/**
 * Whether an axis should report its measured size. Auto-layout children are strict:
 * Figma reliably populates `layoutSizing*`, so only `FIXED` emits. Elsewhere the
 * property may be absent entirely, and the measured box is the only size available.
 */
function emitsFixedDimension(sizing, axis) {
  if (axis === "row" || axis === "column") return sizing === "FIXED";
  return !sizing || sizing === "FIXED";
}

export { hasAutoLayout, isFrame };
