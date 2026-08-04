---
name: figma-design-context
description: Fetches a Figma file or frame via the REST API using a personal access token and converts it into compact YAML (layout, colors, typography, components, hover/pressed states) plus real exported icon/image assets — no Figma MCP or Dev Mode seat needed. Use whenever given a figma.com link or file key to build, clone, or match a UI, or to audit/extract a design system (colors, spacing, type scale), even on a Free plan.
---

# Figma Design Context

Turns a Figma URL into the structured data a coding agent needs to build the UI it
describes — without the official Figma MCP server, which requires a Dev Mode seat.
Everything here runs on the free REST API against a personal access token, using
plain Node.js scripts with **zero npm dependencies** to install.

## Why not just fetch the raw Figma JSON?

You could call the REST API directly, but a raw Figma file is enormous and
adversarial to read: colors are 0-1 float channels, sizes are absolute canvas
coordinates instead of relative layout, and the same button style is repeated
verbatim on every instance instead of being named once. `get-context.mjs` does
that translation for you — the output is YAML (denser than JSON, no bracket/quote
noise) with repeated styles hoisted into a shared dictionary. Read
`references/output-schema.md` once before your first real task; it documents
exactly what each field means and the load-bearing distinction between `fixed`,
`fill`, and `hug` sizing, which is the single most common source of layouts that
look right in Figma and wrong in the browser.

## Setup (one-time)

You need a Figma **personal access token**: Figma → account settings → Security →
Personal access tokens → generate one, scoped at minimum to `file_content:read`
(add `file_dev_resources:read` only if you also need dev-resource links). This
works on every plan, including Free — it is not the same thing as a Dev Mode seat.

Set it as an environment variable so it never needs to be typed into a prompt:

```bash
export FIGMA_API_KEY="figd_..."     # macOS/Linux
$env:FIGMA_API_KEY = "figd_..."     # PowerShell
```

The scripts also accept `--token <pat>` directly if the environment variable isn't
set. If you only have a share link and no token, ask the user for one before
proceeding — there is no way to read file content without it.

## Workflow

### 1. Get the context for the frame you're building

```bash
node scripts/get-context.mjs "https://www.figma.com/design/<fileKey>/<name>?node-id=<id>" --out design.yaml
```

Passing a specific `node-id` (present whenever the user selected a frame before
copying the link) is much cheaper and faster than fetching the whole file, and
keeps the output focused on what you're actually building. If the user pasted a
bare file key or a link with no `node-id`, this fetches the whole file's page
tree at the top level — reasonable for a first look, but prefer asking which
frame to focus on before pulling every screen in the file into context.

Use `--depth <n>` on a large or deeply-nested frame if the first attempt returns
more than you need — it caps traversal depth rather than truncating arbitrarily,
so you still get complete siblings at whatever depth you chose.

Read the resulting YAML like a spec: the root node's `layout.designedWidth` /
`designedHeight` tell you what viewport the design was authored at (use it to pick
a breakpoint, not as a hard-coded pixel size — see `references/output-schema.md`
for why). Every node's `id` is the value you should stamp onto the matching
generated element as `data-figma-id="<id>"`. This is what lets the
`visual-fidelity-loop` skill (and you, later) point at the exact Figma node behind
any visual mismatch instead of guessing which `<div>` is wrong.

### 2. Export the assets it references

The YAML never inlines raster or vector artwork — `get-context.mjs` prints (to
stderr) a ready-to-run command once it detects any, and also lists them under the
top-level `assets` key. Run it:

```bash
node scripts/export-assets.mjs "<same url or fileKey>" \
  --svg-ids <comma-separated node ids from assets.svgNodeIds> \
  --image-refs <comma-separated refs from assets.imageRefs> \
  --out-dir ./assets
```

This writes real files plus `assets/manifest.json` mapping each Figma id/ref to
the filename you should import. Vectors render as SVG by default (crisp at any
size, small, and editable) — pass `--png-ids` instead only when you specifically
need a raster (e.g. a design element with plugin effects that don't survive SVG
export).

### 3. Generate the UI

With the YAML and downloaded assets in hand, write the actual components in
whatever stack the target project already uses — this skill deliberately doesn't
prescribe React vs Vue vs plain HTML, since the point is to match the codebase you
were dropped into, not to impose a new one. Two things matter more than framework
choice:

- Stamp `data-figma-id="<id>"` on every element you generate from a node, not just
  a sample of them. It costs nothing and is what makes the visual QA loop able to
  localize a mismatch.
- Reuse the `globalVars.styles` dictionary as your first signal for what should be
  a shared component/CSS class vs. one-off styling. If five buttons all resolve to
  `fill_658ab2fa`, that is Figma telling you it's one button style, authored once —
  don't rebuild that decision from scratch by eyeballing five inline color values.
- If any node carries `interactions` or `variantProperties`, the design specifies
  behavior and states (hover, pressed, focus), not just a static picture — read
  `references/interactive-states.md` and generate those states too. A component
  whose hover state was designed and then dropped on the floor is a half-built
  component, even if it pixel-matches the default state perfectly.

Then hand off to the `visual-fidelity-loop` skill to verify the render actually
matches before calling the task done — a design system reference alone doesn't
catch flexbox mistakes, off-by-a-few-pixels padding, or a wrong font weight.

## Design tokens without a paid plan

The Variables REST API (Figma's formal design-token store) requires an Enterprise
plan — see `references/figma-rest-api.md` for exactly what that does and doesn't
gate. On Free/Professional, `get-context.mjs` still recovers real design-system
intent for you: named Figma styles (colors, text styles, effects) are kept under
their Figma name in `globalVars.styles` instead of an opaque hash whenever a node
uses one, so a color literally named `Brand/Primary` in Figma shows up as
`Brand/Primary` in the output, not `fill_a1b2c3`. If you need this signal
specifically (e.g. the task is "extract our color palette," not "build this
screen"), fetch a frame that uses the styles you care about and read
`globalVars.styles` directly rather than trying to enumerate the whole file.

## When things fail

The scripts translate raw HTTP failures into an actionable message and a `Hint:`
line — read the hint before re-trying blindly. Common cases: a 403 almost always
means the token is missing a scope or the endpoint is plan-gated (not a bug in
your call); a 404 on a node id usually means the id has a `-` where the API wants
a `:` (the scripts normalize this automatically for any id *you* pass on the
command line, but double check if you're constructing ids yourself downstream); a
429 is the one to take seriously: on a Free/Starter file the file-reading endpoints are
budgeted at only a handful of requests **per month**, per token and across every file
that token can reach, and a measured lockout came back asking for a **4.6-day** wait.
The client reports the real reset time and fails fast rather than sleeping through it —
there is no retry that gets you out of it. What the budget counts is the *number* of
file reads, not their size, so plan for one deliberate fetch of exactly the frame you
need (`--node-id`) instead of exploring a file across several calls, and leave the
on-disk `.figma-cache/` alone (don't pass `--no-cache` while iterating) since after a
lockout it is the only thing still able to answer. Asset and metadata endpoints sit in
separate, far more generous buckets and keep working through a Tier 1 lockout. Full endpoint/scope/rate-limit detail lives
in `references/figma-rest-api.md` — consult it before assuming a limitation that
isn't real.

## Reference files

- `references/output-schema.md` — the exact YAML shape, read before your first
  real extraction; explains `sizing` vs `dimensions`, the `{tsN}` inline text
  markers, and every other field.
- `references/interactive-states.md` — hover/pressed/focus states: how variant axes
  and prototype interactions map to CSS pseudo-classes vs. real application state,
  and which of the two a given trigger calls for. Read before generating anything
  interactive.
- `references/figma-rest-api.md` — the underlying REST API: auth scopes, every
  endpoint used, rate limits, and precisely what is plan-gated vs universally
  available.
