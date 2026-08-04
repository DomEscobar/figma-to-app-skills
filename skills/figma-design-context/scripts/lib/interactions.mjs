/**
 * Interactive state -> a shape a codegen agent can turn into real behavior. Covers the
 * two independent places a Figma file expresses it: prototype `interactions` (what
 * triggers a change) and a component set's variant axes (which states exist at all).
 *
 * Figma's `interactions` array is `{ trigger, actions[] }` per node. Two things make
 * the raw form awkward to generate code from, and both are resolved here:
 *
 * 1. The trigger enum hides the single most important distinction. Per Figma's REST
 *    docs, `ON_HOVER`/`ON_PRESS` are *temporary* — the state reverts when the trigger
 *    ends, which is exactly CSS `:hover`/`:active`. `MOUSE_ENTER`/`MOUSE_LEAVE`/
 *    `MOUSE_DOWN`/`MOUSE_UP` are *permanent* one-way navigation, which needs real
 *    application state. Same-looking triggers, categorically different code. That
 *    distinction is surfaced as an explicit `reverts: true` rather than left for the
 *    reader to recall from the API docs.
 * 2. A node-targeting action buries what it does in a separate `navigation` field
 *    (`NAVIGATE` vs `CHANGE_TO` vs `OVERLAY`...), so every action reads as
 *    `type: NODE`. Navigation is flattened into the action's own `type` instead, so
 *    `changeTo` (swap this instance to another variant — i.e. a state change) is
 *    distinguishable from `navigate` (go to another screen) at a glance.
 *
 * Durations/timeouts are normalized to milliseconds. Note that Figma's REST docs
 * claim `timeout`, `delay` and transition `duration` are already in milliseconds,
 * but real responses return seconds (an observed `AFTER_TIMEOUT` timeout of
 * `0.800000011920929` is 800ms, not 0.8ms). Seconds is what's assumed here; see
 * references/interactive-states.md.
 */

const round = (value, digits = 0) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** `reverts` marks the triggers whose effect is undone when the trigger ends. */
const TRIGGERS = {
  ON_CLICK: { on: "click" },
  ON_HOVER: { on: "hover", reverts: true },
  ON_PRESS: { on: "press", reverts: true },
  ON_DRAG: { on: "drag" },
  MOUSE_ENTER: { on: "mouseEnter" },
  MOUSE_LEAVE: { on: "mouseLeave" },
  MOUSE_DOWN: { on: "mouseDown" },
  MOUSE_UP: { on: "mouseUp" },
  AFTER_TIMEOUT: { on: "timeout" },
  ON_KEY_DOWN: { on: "keyDown" },
  ON_KEY_UP: { on: "keyUp" },
  ON_MEDIA_HIT: { on: "mediaTime" },
  ON_MEDIA_END: { on: "mediaEnd" },
};

const NAVIGATION_AS_TYPE = {
  NAVIGATE: "navigate",
  OVERLAY: "openOverlay",
  SWAP: "swapOverlay",
  SCROLL_TO: "scrollTo",
  CHANGE_TO: "changeTo",
};

const CSS_EASING = {
  LINEAR: "linear",
  EASE_IN: "ease-in",
  EASE_OUT: "ease-out",
  EASE_IN_AND_OUT: "ease-in-out",
};

const DIRECTION_TRANSITIONS = new Set(["MOVE_IN", "MOVE_OUT", "PUSH", "SLIDE_IN", "SLIDE_OUT"]);

const TRANSITION_NAMES = {
  DISSOLVE: "dissolve",
  SMART_ANIMATE: "smartAnimate",
  SCROLL_ANIMATE: "scrollAnimate",
  MOVE_IN: "moveIn",
  MOVE_OUT: "moveOut",
  PUSH: "push",
  SLIDE_IN: "slideIn",
  SLIDE_OUT: "slideOut",
};

/** Figma returns seconds despite documenting milliseconds — see the module header. */
function toMs(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return undefined;
  return `${round(seconds * 1000)}ms`;
}

function buildEasing(easing) {
  if (!easing) return undefined;
  const bezier = easing.easingFunctionCubicBezier;
  if (bezier) {
    const { x1, y1, x2, y2 } = bezier;
    if ([x1, y1, x2, y2].every((n) => typeof n === "number")) {
      return `cubic-bezier(${round(x1, 3)}, ${round(y1, 3)}, ${round(x2, 3)}, ${round(y2, 3)})`;
    }
  }
  const css = CSS_EASING[easing.type];
  if (css) return css;
  // Spring curves (GENTLE_SPRING, custom springs) have no CSS timing-function
  // equivalent. Passing the raw name through beats silently emitting a linear lie.
  return easing.type ? { figmaEasing: easing.type } : undefined;
}

function buildTransition(transition) {
  if (!transition?.type) return undefined;
  const out = { type: TRANSITION_NAMES[transition.type] ?? transition.type };
  if (DIRECTION_TRANSITIONS.has(transition.type) && transition.direction) {
    out.direction = transition.direction.toLowerCase();
  }
  const duration = toMs(transition.duration);
  if (duration) out.duration = duration;
  const easing = buildEasing(transition.easing);
  if (easing) out.easing = easing;
  if (transition.matchLayers === true) out.matchLayers = true;
  return out;
}

/**
 * @param {object} action Raw Figma Action.
 * @param {(nodeId: string) => string|undefined} resolveVariantName Maps a destination
 *   node id to a component/variant name (e.g. `State=hover`) when file-level
 *   component metadata is available, so a `changeTo` says which state it changes to.
 */
function buildAction(action, resolveVariantName) {
  if (!action?.type) return undefined;

  switch (action.type) {
    case "NODE": {
      const type = NAVIGATION_AS_TYPE[action.navigation?.type ?? "NAVIGATE"];
      if (!type) return undefined;
      const out = { type };
      if (action.destinationId) {
        out.to = action.destinationId;
        const name = resolveVariantName?.(action.destinationId);
        if (name) out.toVariant = name;
      }
      const transition = buildTransition(action.transition);
      if (transition) out.transition = transition;
      if (action.preserveScrollPosition === true) out.preserveScrollPosition = true;
      return out;
    }
    case "URL":
      return action.url ? { type: "openUrl", url: action.url } : undefined;
    case "BACK":
      return { type: "goBack" };
    case "CLOSE":
      return { type: "closeOverlay" };
    case "SET_VARIABLE": {
      const out = { type: "setVariable" };
      if (action.variableId) out.variableId = action.variableId;
      // `value` may be a plain literal or a nested alias/expression; only the simple
      // literal case is unwrapped, since anything else needs the Variables API
      // (Enterprise-only) to mean anything.
      const value = action.variableValue?.value;
      if (["boolean", "number", "string"].includes(typeof value)) out.value = value;
      return out;
    }
    case "SET_VARIABLE_MODE": {
      const out = { type: "setVariableMode" };
      if (action.variableCollectionId) out.variableCollectionId = action.variableCollectionId;
      if (action.variableModeId) out.variableModeId = action.variableModeId;
      return out;
    }
    case "CONDITIONAL": {
      const branches = (action.conditionalBlocks ?? [])
        .map((block) => {
          const actions = buildActions(block?.actions, resolveVariantName);
          return actions.length ? { actions } : undefined;
        })
        .filter(Boolean);
      return branches.length ? { type: "conditional", branches } : undefined;
    }
    case "UPDATE_MEDIA_RUNTIME": {
      const out = { type: "media" };
      if (action.mediaAction) out.mediaAction = action.mediaAction.toLowerCase();
      if (action.destinationId) out.to = action.destinationId;
      return out;
    }
    default:
      // An action type newer than this extractor: name it rather than drop it, so a
      // reader can go look it up instead of wondering why a button does nothing.
      return { type: action.type };
  }
}

function buildActions(actions, resolveVariantName) {
  if (!Array.isArray(actions)) return [];
  // Real payloads contain null entries (observed: a trigger whose action was
  // deleted leaves `actions: [null]`), so this cannot assume objects.
  return actions.map((action) => buildAction(action, resolveVariantName)).filter(Boolean);
}

/**
 * @param {object} node Raw Figma node.
 * @param {(nodeId: string) => string|undefined} [resolveVariantName]
 * @returns {object[]|undefined} Simplified interactions, or undefined when the node
 *   has none worth emitting. Triggers whose actions are all null/unknown are dropped
 *   entirely: they describe an intent with no effect, so there is nothing to generate.
 */
export function buildInteractions(node, resolveVariantName) {
  if (!Array.isArray(node?.interactions) || !node.interactions.length) return undefined;

  const out = [];
  for (const interaction of node.interactions) {
    const trigger = TRIGGERS[interaction?.trigger?.type];
    if (!trigger) continue;

    const actions = buildActions(interaction.actions, resolveVariantName);
    if (!actions.length) continue;

    const simplified = { ...trigger };
    const held = toMs(interaction.trigger.timeout ?? interaction.trigger.delay);
    if (held) simplified.delay = held;
    if (Array.isArray(interaction.trigger.keyCodes) && interaction.trigger.keyCodes.length) {
      simplified.keyCodes = interaction.trigger.keyCodes;
    }
    simplified.actions = actions;
    out.push(simplified);
  }

  return out.length ? out : undefined;
}

/**
 * Splits a Figma variant component's name into its axis/value pairs.
 *
 * Figma serializes a variant's name as `Axis=Value` pairs joined by `", "` (e.g.
 * `"Size=L, Type=Primary, State=Hover"`). This parses that documented encoding, not a
 * guess at intent: any segment that isn't exactly one `Axis=Value` disqualifies the
 * whole name, so an ordinary component called `Button/Primary` returns undefined
 * rather than being coerced into a bogus axis.
 */
export function parseVariantName(name) {
  if (typeof name !== "string" || !name.includes("=")) return undefined;

  const out = {};
  for (const segment of name.split(",")) {
    const pair = segment.trim();
    const separator = pair.indexOf("=");
    if (separator <= 0) return undefined;

    const axis = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!axis || !value || value.includes("=")) return undefined;
    out[axis] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Declared axes, when the payload carries `componentPropertyDefinitions` at all. */
function declaredVariantAxes(node) {
  const definitions = node?.componentPropertyDefinitions;
  if (!definitions) return undefined;

  const out = {};
  for (const [key, definition] of Object.entries(definitions)) {
    if (definition?.type !== "VARIANT" || !Array.isArray(definition.variantOptions)) continue;
    out[key.split("#")[0]] = definition.variantOptions;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Axes reconstructed from the variant children's names, in first-seen order.
 *
 * Necessary because `componentPropertyDefinitions` is documented as a node field but
 * is absent from real `GET /files` and `GET /files/.../nodes` responses (verified
 * against a 388-variant component set: the COMPONENT_SET node has no such key, while
 * every child is named `Size=L, Type=Primary, State=Hover, ...`). Restricted to
 * COMPONENT_SET so a plain frame whose children happen to contain `=` can't produce
 * phantom axes.
 */
function derivedVariantAxes(node) {
  if (node?.type !== "COMPONENT_SET" || !Array.isArray(node.children)) return undefined;

  const axes = new Map();
  for (const child of node.children) {
    const parsed = parseVariantName(child?.name);
    if (!parsed) continue;
    for (const [axis, value] of Object.entries(parsed)) {
      if (!axes.has(axis)) axes.set(axis, new Set());
      axes.get(axis).add(value);
    }
  }

  if (!axes.size) return undefined;
  return Object.fromEntries([...axes].map(([axis, values]) => [axis, [...values]]));
}

/**
 * Variant axes of a COMPONENT_SET, e.g. `{ State: ["Default", "Hover", "Pressed"] }`.
 *
 * This is the "which states exist" half of state extraction, and it is worth having
 * even when no interaction is wired up: a design can define a hover variant that the
 * designer never connected with a prototype trigger (the common case in published UI
 * kits), and generated code still wants the `:hover` rule.
 */
export function buildVariantProperties(node) {
  return declaredVariantAxes(node) ?? derivedVariantAxes(node);
}
