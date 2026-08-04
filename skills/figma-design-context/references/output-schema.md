# Output schema: simplified Figma YAML

`get-context.mjs` prints one YAML document shaped like this:

```yaml
fileKey: AbCdEf12345
nodeId: "12:34"            # omitted when the whole file was requested
nodes:
  - id: "12:34"
    name: Card
    type: FRAME
    layout: layout_11e8fb19        # string = shared reference into globalVars.styles
    fills: fill_658ab2fa
    effects: effect_a55b1851
    borderRadius: 12px
    children: [ ... ]
globalVars:
  styles:
    layout_11e8fb19: { mode: column, gap: 8px, padding: 16px }
    fill_658ab2fa: ["#FFFFFF"]
assets:
  svgNodeIds: ["12:40", "12:41"]   # pass to export-assets.mjs --svg-ids
  imageRefs: ["a1b2c3..."]          # pass to export-assets.mjs --image-refs
```

Read this file when you need to know exactly what a field means or how a value is
shaped — the extraction scripts assume this document, not intuition about Figma's
raw API, so check here before guessing at a field's meaning.

## Table of contents

- [Why fields are references, not inline values](#why-fields-are-references-not-inline-values)
- [`layout`](#layout)
- [`fills` / `strokes`](#fills--strokes)
- [`effects`](#effects)
- [`textStyle` and rich text](#textstyle-and-rich-text)
- [Component instances](#component-instances)
- [`interactions`](#interactions)
- [`type: IMAGE-SVG`](#type-image-svg)
- [Node types you will see](#node-types-you-will-see)

## Why fields are references, not inline values

A style field (`layout`, `fills`, `strokes`, `effects`, `textStyle`) is either:

- a **string** — a key into `globalVars.styles`, meaning 2+ nodes share this exact
  value (or it is a named Figma style, kept hoisted as design-system intent even at
  one use), or
- an **inline value** of the same shape — meaning only one node uses it, so hoisting
  it into the dictionary would cost more (a reference plus a dictionary entry) than
  it saves.

Either way the *shape* of the value is identical; only whether it is wrapped in a
lookup differs. When two sibling elements resolve to the same dictionary key, that
is a strong, reliable signal to generate one component/class instead of two copies
of hand-rolled CSS — don't discard that signal by treating each node in isolation.

## `layout`

```yaml
layout:
  mode: row | column | grid | none
  justifyContent: flex-start | flex-end | center | space-between | baseline
  alignItems: flex-start | flex-end | center | space-between | baseline
  alignSelf: flex-end | center | stretch        # how THIS node sits in its parent
  wrap: true
  gap: "16px" | "8px 16px"                       # row-gap / "row-gap column-gap"
  gridTemplateColumns: "120px 1fr 1fr"
  gridTemplateRows: "auto auto"
  gridRow: "2 / span 1"
  gridColumn: "1"
  padding: "16px" | "8px 16px" | "8px 16px 12px 4px"   # shortest valid CSS shorthand
  sizing:
    horizontal: fixed | fill | hug | contextual
    vertical: fixed | fill | hug | contextual
  dimensions: { width: 240, height: 120 }        # px numbers; ONLY present for FIXED axes
  designedWidth: "1440px"                        # root node only — see below
  designedHeight: "900px"
  position: absolute
  offsetFromParent: { x: 24, y: 12 }              # only when position is absolute
  overflow: hidden
  rotation: "15deg"
```

**`sizing` vs `dimensions` — read this before generating any width/height CSS.**
Figma auto-layout children are one of `fixed` (author picked an exact size — emit
it), `fill` (grow to fill the parent — emit `flex: 1` / `width: 100%`, not a pixel
value), or `hug` (shrink to content — emit nothing, let the browser do its job).
`dimensions` is populated **only** for axes marked `fixed`; if you see `sizing:
{horizontal: fill}` with no `dimensions.width`, that is correct and intentional —
do not fall back to guessing a width.

**`designedWidth`/`designedHeight` (root node only).** The frame you asked for has a
size in the design, but that size is an artifact of the frame being top-level, not
a constraint the app should enforce (a browser window isn't 1440px wide by
contract). Use these as a reference for breakpoint/content decisions, never as a
hard-coded `width` on the root element. Non-root nodes never get this field — they
get `dimensions` (a real constraint) or nothing (fluid) instead.

**`position: absolute` nodes (free-positioned, not inside auto-layout) always get a
fixed `offsetFromParent` — they do not model Figma's `constraints` field** (e.g.
`LEFT_RIGHT` "stretch with the frame," or `SCALE`). A node with a responsive
pinning behavior configured via constraints will still extract as if it were
pinned at a fixed offset. This is uncommon in modern Figma files (auto-layout
covers the vast majority of real designs) but worth knowing before assuming a
free-floating element should behave responsively — check the design intent
manually for those nodes rather than trusting the extraction to have inferred it.

**`rotation` on a node with `fills`/`strokes` (i.e. a plain shape, not one collapsed
to `IMAGE-SVG`) is an approximation, not a precise CSS transform.** `dimensions`
always comes from Figma's `absoluteBoundingBox`, which for a rotated node is the
axis-aligned box that *contains* the rotated shape — not the shape's pre-rotation
width/height. Emitting `width`/`height` from that box and then also applying
`transform: rotate(<rotation>)` in CSS over-rotates the element (the box itself is
already "wider" to accommodate the tilt). For a decorative rotated rectangle this is
usually close enough to be invisible at a glance, but for anything where the exact
silhouette matters, render that node with `export-assets.mjs --svg-ids` instead —
the raster/vector export bakes the correct rotated silhouette into the file, so you
place it as an `<img>` at `offsetFromParent`/`dimensions` with **no** CSS rotation at
all. Nodes already collapsed to `type: IMAGE-SVG` do not have this problem for the
same reason: the exported SVG's path already reflects the true rotated silhouette.

**Everything not listed above is a CSS default and is omitted on purpose** —
e.g. `justifyContent: flex-start` never appears because that's what an unstyled
flex container already does. Absence means default, not "unknown."

## `fills` / `strokes`

A resolved fill is one of:

- a hex/rgba string — one or more fully-opaque-or-translucent solid colors already
  composited in visual order (`fills: ["#3366FF"]`, topmost/only layer first, no
  hidden layer-order ambiguity for you to get wrong)
- `{ type: gradient, css: "linear-gradient(180deg, #FFF 0%, #000 100%)" }` — a
  ready-to-use CSS value
- `{ type: image, imageRef: "...", objectFit: cover|contain|repeat|fill }` — resolve
  `imageRef` to a local file via `export-assets.mjs --image-refs`, then use it as a
  background-image or `<img>` src with the given `objectFit`. Note `objectFit` is
  named for the `<img>` case; if the node has children (so you're generating a div
  with a background image rather than a bare `<img>`), translate it to the
  `background-size` equivalent instead (`cover`→`cover`, `contain`→`contain`,
  `repeat`→`repeat` + `background-repeat: repeat`, `fill`→`100% 100%`)

`strokes` additionally carries plain (never deduplicated) sibling fields:
`strokeWeight` ("2px") or `strokeWeights` (per-side "top right bottom left"),
`strokeAlign` (inside/outside/center), `strokeDashes` ("4 2").

## `effects`

Pre-split by CSS destination so you never have to map a Figma effect type yourself:

```yaml
effects:
  boxShadow: "0px 2px 8px 0px rgba(0, 0, 0, 0.12)"
  textShadow: "0px 2px 8px rgba(0, 0, 0, 0.12)"   # only on TEXT nodes with a drop shadow
  filter: "blur(4px)"                              # LAYER_BLUR
  backdropFilter: "blur(12px)"                      # BACKGROUND_BLUR
```

## `textStyle` and rich text

```yaml
textStyle:
  fontFamily: Inter
  fontWeight: 600
  fontSize: 18px
  lineHeight: 1.4          # unitless multiplier when Figma expressed it as %, else "24px"
  letterSpacing: 0.2px
  textAlign: center
  verticalAlign: bottom     # how text sits within its OWN box height — see note below
  textTransform: uppercase
  color: "#111111"
```

**`verticalAlign` is not the CSS `vertical-align` property** — that CSS property only
affects inline/table-cell layout and is a no-op on a block-level element with a fixed
height, which is what most extracted text nodes become. `verticalAlign` here mirrors
Figma's `textAlignVertical` (how the text sits inside its own bounding box, independent
of any parent auto-layout `alignItems`) and should be translated to
`display: flex; align-items: <flex-start|center|flex-end>` (mapped from
`top|center|bottom`) on the text element itself, not passed through as a literal CSS
property.

`text` is the literal string to render, **except** that a substring may be wrapped
in `{tsN}...{/tsN}` markers, e.g. `text: "Save {ts1}20%{/ts1} today"`. This means
those characters carry a per-character style override in Figma (a partially bolded
word, a differently-colored span). Look up `ts1` in `globalVars.styles` — it is a
small delta object (only the properties that differ from the node's base
`textStyle`, e.g. `{ fontWeight: 700 }`), and should become an inline `<span
style="...">` (or equivalent) wrapping exactly that substring. `ts*` keys are
never shared across nodes (they're always inlined at the point of use), so don't
expect to find the same `ts3` on two different nodes.

## Component instances

```yaml
componentId: "12:99"
componentName: "Button/State=hover"     # when file-level component metadata was available
componentProperties:
  State: hover
  Show icon: true
```

An `INSTANCE` node reproduces a component defined elsewhere in the file.
`componentProperties` are that instance's variant/boolean/text property values —
useful for naming component variants and states in generated code, but the visual
result you need is already fully baked into this node's own `layout`/`fills`/etc.,
so you do not need to fetch the component definition to render this instance
correctly.

A `COMPONENT_SET` node additionally reports its variant axes:

```yaml
variantProperties:
  State: [default, hover, pressed]
  Size: [sm, md]
```

These are the states the design defines. Note that they exist independently of
whether a prototype interaction was ever wired up to them — see `interactions`
below and `interactive-states.md`.

## `interactions`

Prototype behavior, present only on nodes that have some:

```yaml
interactions:
  - on: hover              # click | hover | press | drag | mouseEnter | mouseLeave |
                           # mouseDown | mouseUp | keyDown | keyUp | timeout | mediaTime | mediaEnd
    reverts: true          # the change is undone when the trigger ends -> a CSS pseudo-class
    delay: "300ms"         # trigger hold time / AFTER_TIMEOUT timeout
    keyCodes: [13]         # keyDown/keyUp only
    actions:
      - type: changeTo     # changeTo | navigate | openOverlay | swapOverlay | scrollTo |
                           # openUrl | goBack | closeOverlay | setVariable | setVariableMode |
                           # conditional | media
        to: "12:34"                    # destination node id
        toVariant: "State=hover"       # its variant name, when resolvable
        transition: { type: smartAnimate, duration: "150ms", easing: ease-out }
```

**`reverts` is the field that decides how you implement the interaction**, and
`changeTo` (swap an instance to a different variant — a state change) is a very
different thing from `navigate` (go to another screen), even though Figma models both
as `type: NODE` internally. Read `interactive-states.md` before generating from this;
it covers the variant→CSS-pseudo-class mapping, why you should emit only the style
delta between two variants, transition caveats, and a documented unit discrepancy in
Figma's own duration fields.

Interactions whose actions are all null are dropped rather than emitted as empty
triggers, so an absent `interactions` key means "nothing actionable here," not
necessarily "the designer wired up nothing."

## `type: IMAGE-SVG`

A `VECTOR` node, or a container whose entire subtree was flattened because every
child was a vector primitive (icons, small illustrations — see the extractor's
`shouldCollapseToSvg` for the exact rule). These nodes have no usable `fills`/path
data in this YAML; they exist in `assets.svgNodeIds` and must be rendered to real
SVG files via `export-assets.mjs --svg-ids`, then referenced as an `<img>`,
`background-image`, or inlined SVG in the generated markup.

## Node types you will see

`FRAME`, `GROUP`, `TEXT`, `INSTANCE`, `COMPONENT`, `COMPONENT_SET`, `IMAGE-SVG`
(see above), `BOOLEAN_OPERATION`, `RECTANGLE`, `ELLIPSE`, `LINE`, `STAR`,
`REGULAR_POLYGON`, `SECTION`. Treat `SECTION` as a plain grouping frame with no
visual output of its own — Figma uses it for organizing the canvas, not for
rendering.
