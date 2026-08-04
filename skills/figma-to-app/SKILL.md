---
name: figma-to-app
description: Orchestrates building or updating a real, working app/page/component from a Figma design link, end to end, without the paid Figma MCP or Dev Mode seat. Use when the user pastes a figma.com URL and asks to build, implement, clone, recreate, or "pixel-perfect" match it in code, in whatever stack their repo already uses. Composes figma-design-context and visual-fidelity-loop: fetch design data, detect the stack, generate code, verify visually.
---

# Figma to App

The orchestrator for a three-phase pipeline: **extract** the design, **generate**
code that matches the target project's existing stack, **verify** the render
against the design and iterate until it actually matches — not just "looks close
enough by eye." Each phase is its own skill; this document is the workflow that
strings them together and the decisions that only make sense at the workflow
level (which stack, how much to build at once, when to stop iterating).

Read this skill's own two reference files as needed; read the sub-skills'
`SKILL.md` files (`figma-design-context`, `visual-fidelity-loop`) for the actual
script usage — this file intentionally doesn't repeat their command syntax.

## Why this exists instead of the official Figma MCP

The official Figma Dev Mode MCP server requires a paid Dev Mode seat per user —
real recurring cost for something a personal access token gets for free through
the REST API. This skill suite gets the same design data (and, with the visual
fidelity loop, better verification than Dev Mode's static annotations give you)
using only a token, some Node scripts, and — if available in your environment —
a real browser to check the result. Nothing here talks to an MCP server; it's
plain scripts an agent runs.

## Phase 1 — Extract

Use the **`figma-design-context`** skill. At minimum you need the Figma URL (with
a `node-id` if the user selected a specific frame — ask for one if they only
pasted a whole-file link and the file has multiple screens) and a personal access
token (`FIGMA_API_KEY` env var, or ask the user for one — see that skill's Setup
section). The output is a YAML description of layout/styling plus a manifest of
downloaded icon/image assets.

Before moving on, skim the extracted YAML yourself: check the root node's
`layout.designedWidth`/`designedHeight` for the design's reference viewport, and
note how many distinct entries land in `globalVars.styles` — a design with three
button styles and a design with fifteen call for different levels of
componentization, and you'll only notice by looking.

## Phase 2 — Detect the stack, then generate

**Before writing any code**, work out what stack you're actually writing it in.
Read `references/stack-detection.md` for the checklist — do not default to React
+ Tailwind out of habit if the repo you're in uses something else entirely; the
whole point of skipping a rigid framework-specific generator is to match the
codebase you were dropped into.

Then generate the components/markup, applying the extracted layout and style data
node by node. Two rules apply regardless of stack:

1. **Stamp `data-figma-id="<id>"` on every element generated from a Figma node.**
   This is the join key Phase 3 uses to localize a visual mismatch back to the
   exact node that caused it, instead of guessing. Skipping it on "unimportant"
   elements is the most common way this whole pipeline degrades back into manual
   pixel-chasing.
2. **Let `globalVars.styles` drive componentization.** When several nodes
   reference the same style key, that's Figma stating "these are the same thing"
   — express it as one shared component/class, not N copies of similar-looking
   CSS that will drift the moment someone edits one of them.
3. **Build the states, not just the default frame.** If the extraction contains
   `interactions` or `variantProperties`, the design specifies hover/pressed/focus
   behavior; the `interactive-states.md` reference bundled with the
   `figma-design-context` skill covers which of those become CSS pseudo-classes
   and which need real application state. Phase 3
   verifies the default state by screenshot — it will not tell you that a designed
   hover state was never built, so that omission is on you to not make.

Build incrementally rather than the whole screen in one shot when the frame is
large or has repeated sections (e.g. a card grid): get one instance of a repeated
element right and verified (Phase 3) before stamping it out N times, so a layout
bug doesn't get multiplied across the whole page before you notice it.

## Phase 3 — Verify and iterate

Use the **`visual-fidelity-loop`** skill against the running app (dev server) and
the Figma frame's own rendered image. Run it after every meaningfully-sized chunk
of generated UI, not only once at the very end — a mismatch caught after one
component is a two-minute fix; the same mismatch caught after twelve components
were built on the same wrong assumption is not.

The loop's structured `check-styles` output tells you exactly which CSS property
on which `data-figma-id` is wrong — treat that as your task list for the next
edit pass, rather than re-reading the whole page for what "looks off." Stop
iterating per that skill's convergence guidance (diminishing returns, or a
genuinely irreducible gap like a font Figma has that isn't licensed for the web —
name the gap to the user instead of chasing an asymptote).

## Optional: live browser inspection during generation

If your environment exposes interactive browser tools (a Playwright, Chrome
DevTools, or generic browser-control MCP), you can use them mid-generation for
exploratory work the scripted loop isn't meant for — e.g. clicking through an
existing app to understand current behavior before you change it, or eyeballing
a state that's awkward to script (a toast that appears for two seconds). Prefer
the bundled `visual-fidelity-loop` scripts for the actual pass/fail
verification loop, though: they're deterministic and reproducible (fixed
viewport, disabled animations, font-load waits), which an ad hoc interactive
screenshot generally isn't, and reproducibility is what makes "did my fix
actually help" a answerable question instead of a vibe.

## Definition of done

- Every element with a visual role in the design has a generated counterpart
  carrying its `data-figma-id`.
- The visual fidelity loop's structured checks pass (or documented gaps are
  called out explicitly to the user — text overflow behavior, a missing web
  font license, browser-only rendering quirks).
- The pixel diff ratio is low and, more importantly, **not concentrated** in one
  region — a uniformly low diff usually means antialiasing noise; a low average
  hiding one badly-wrong element means the check ran at too coarse a grain.
- The code matches the target repo's existing conventions (Phase 2), so a
  reviewer wouldn't be able to tell which components came from this pipeline.

## Reference files

- `references/stack-detection.md` — the checklist for identifying framework,
  styling approach, and conventions before generating code.
