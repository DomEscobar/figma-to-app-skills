---
name: figma-to-app
description: Orchestrates building or updating a real app/page/component from a Figma link, including browser capture when REST access is missing or rate-limited. Use when the user asks to build, clone, recreate, or pixel-match a Figma design in an existing codebase.
---

# Figma to App

The orchestrator for a three-phase pipeline: **extract** the design, **generate**
code that matches the target project's existing stack, **verify** the render
against the design and iterate until it actually matches — not just "looks close
enough by eye." Each phase is its own skill; this document is the workflow that
strings them together and the decisions that only make sense at the workflow
level (which stack, how much to build at once, when to stop iterating).

Read this skill's own references as needed; read the selected sub-skills'
`SKILL.md` files (`figma-design-context` or `figma-browser-capture`, then
`figma-responsive-implementation` and `visual-fidelity-loop`) for actual
script usage. This file intentionally does not repeat their command syntax.

## Why this exists instead of the official Figma MCP

The official Figma Dev Mode MCP server requires a paid Dev Mode seat per user —
real recurring cost for something a personal access token gets for free through
the REST API. This skill suite gets the same design data (and, with the visual
fidelity loop, better verification than Dev Mode's static annotations give you)
using only a token, some Node scripts, and — if available in your environment —
a real browser to check the result. Nothing here talks to an MCP server; it's
plain scripts an agent runs.

## Phase 1 — Extract

Start with the Figma URL and prefer a selected frame carrying `node-id`.

- When protected REST credentials are already configured and the request is
  within budget, use **`figma-design-context`**. Its output is structured YAML
  plus exported asset provenance.
- When credentials are unavailable or a file/content/image endpoint returns
  `429`, use **`figma-browser-capture`**. Capture only a public link or an
  already-authorized local browser session. Its output is a sealed `frame.png`,
  capture manifest, integrity file, and optional visible-inspector evidence.
- Never collect credentials in chat or retry a long `Retry-After` loop. Browser
  capture is an authorized fallback, not an access-control or rate-limit bypass.

Before moving on, inspect the selected evidence. For structured YAML, check
`layout.designedWidth`/`designedHeight` and `globalVars.styles`. For browser
capture, verify hashes, viewport, measured DPR, stability results, crop, and every
visible-inspector provenance entry. Treat missing node structure and states as
inferred.

## Phase 2 — Detect the stack, then generate

**Before writing any code**, work out what stack you're actually writing it in.
Read `references/stack-detection.md` for the checklist — do not default to React
+ Tailwind out of habit if the repo you're in uses something else entirely; the
whole point of skipping a rigid framework-specific generator is to match the
codebase you were dropped into.

Then generate the components/markup, applying only confirmed layout and style
evidence. These rules apply regardless of stack:

1. **Stamp `data-figma-id="<id>"` on every element generated from a confirmed Figma node.**
   This is the join key Phase 3 uses to localize a visual mismatch back to the
   exact node that caused it, instead of guessing. Skipping it on "unimportant"
   elements is the most common way structured mode degrades back into manual
   pixel-chasing. In browser-only mode, never invent ids; use stable application
   test ids and mark the mapping inferred.
2. **Let confirmed design-system evidence drive componentization.** In structured
   mode, shared `globalVars.styles` keys identify common components/classes. In
   browser mode, combine visible-inspector evidence with the target repository's
   design memory; do not promote repeated-looking pixels into a Figma token claim.
3. **Build authored states, not just the default frame.** If structured extraction contains
   `interactions` or `variantProperties`, the design specifies hover/pressed/focus
   behavior; the `interactive-states.md` reference bundled with the
   `figma-design-context` skill covers which of those become CSS pseudo-classes
   and which need real application state. Phase 3
   verifies the default state by screenshot — it will not tell you that a designed
   hover state was never built. In browser-only mode, implement only observed
   states and mark every other state inferred.

Build incrementally rather than the whole screen in one shot when the frame is
large or has repeated sections (e.g. a card grid): get one instance of a repeated
element right and verified (Phase 3) before stamping it out N times, so a layout
bug doesn't get multiplied across the whole page before you notice it.

## Phase 3 — Verify and iterate

Use the **`visual-fidelity-loop`** skill against the running app and the protected
REST export or browser-captured `frame.png`. Run it after every meaningfully-sized chunk
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

- Every element with a visual role has a generated counterpart. Confirmed
  structured nodes carry `data-figma-id`; browser-only elements use stable test
  ids without fabricated Figma ids.
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
