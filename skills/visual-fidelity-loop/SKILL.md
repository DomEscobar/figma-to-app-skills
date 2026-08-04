---
name: visual-fidelity-loop
description: Compares a running browser implementation against a Figma design, mockup, or reference screenshot and drives it to a pixel-perfect match via an automatable capture-diff-check loop, without a human eyeballing screenshots. Use when asked if something matches the design/mockup/Figma file, for pixel-perfect fidelity, visual regression checks, visual QA, or "does this look right" / "compare to the design" / "match the screenshot" — even without naming this skill.
---

# Visual Fidelity Loop

## When and why to use this

Use this skill any time an implementation needs to visually match a reference —
most commonly a Figma frame exported by the sibling `figma-design-context` skill, but
also a plain screenshot or mockup. The core problem it solves: "looks close enough"
is not a stopping condition an agent can evaluate on its own, and staring at two
screenshots side-by-side doesn't scale across iterations. This skill turns that
judgment call into two things a script can check — a pixel-diff ratio and a set of
per-element CSS-property assertions — so an agent can loop capture → diff → check →
fix without waiting on a human to say "yeah, close enough" or "no, the padding's off."

## Prerequisites (once per install location)

From the `scripts/` directory next to this file — not the source repo, if this skill
was copied into an agent's skills directory, since dependencies are deliberately not
copied along:

```bash
npm install
npx playwright install chromium
```

`npm install` pulls in `playwright`, `pixelmatch`, and `pngjs` — all pure JS or
self-contained binary downloads, no native build toolchain required. `playwright
install chromium` is a separate step because it downloads a browser binary, not an
npm package; skipping it is the most common failure mode, and every script here
detects that case and prints this exact command instead of a raw stack trace.

## The core loop

Run these from this skill's `scripts/` directory. Paths below assume a Figma
frame exported at `references/frame.png` with `absoluteBoundingBox.width = 1440` and
an app running at `http://localhost:3000`.

1. **Capture** the current implementation at the frame's exact width:

   ```bash
   node capture.mjs --url http://localhost:3000 --out shots/actual.png --width 1440
   ```

   Matching `--width` to the Figma frame's `absoluteBoundingBox.width` is what makes
   step 2's width comparison meaningful instead of noise — see `capture.mjs`'s header
   comment for the full flag list (`--selector` to clip to one element, `--wait` for
   SPAs that mount asynchronously, `--scale` to match the reference's export multiplier).

2. **Pixel-diff** against the reference for a coarse "are we close" signal:

   ```bash
   node diff.mjs --reference references/frame.png --actual shots/actual.png \
     --out shots/diff.png --max-diff-ratio 0.02
   ```

   This prints a JSON result (`diffRatio`, `widthMismatch`, `heightMismatch`, `passed`)
   and writes `diff.png` with mismatches highlighted. A nonzero exit code means "not
   passing yet" — useful as a loop condition. Don't stop here: a passing ratio only
   says the frame is broadly right, not which element to fix if it isn't.

3. **Structured-check** specific elements against exact expected values:

   ```bash
   node check-styles.mjs --url http://localhost:3000 \
     --expectations expectations/hero.json --report shots/styles-report.json
   ```

   This is the more actionable half of the loop (see step 4 for the manifest format).
   Each failure names a selector and a CSS property, e.g. "`fontSize` on
   `[data-figma-id='12:34']`: expected 16px, got 14px" — read the printed table or the
   JSON report to know exactly what to patch.

4. **Localize the worst offender.** Open `shots/diff.png` (magenta = missing/extra
   content from a height mismatch; red = a real pixel mismatch) and cross-reference it
   with the failed rows in the structured-check report. Prioritize failures on
   high-visibility elements (headers, primary CTAs, hero sections) over low-priority
   ones (a 1px shadow blur difference).

5. **Patch the code**, then repeat from step 1. Re-capture rather than reusing the old
   screenshot — the whole point of the loop is that each iteration reflects the actual
   current state of the app.

## Building the expectations manifest

`check-styles.mjs --expectations` takes a JSON file shaped like this:

```json
{
  "viewport": { "width": 1440, "height": 900 },
  "checks": [
    {
      "selector": "[data-figma-id='12:34']",
      "label": "Primary CTA button",
      "expect": {
        "color": "#FFFFFF",
        "backgroundColor": "#3366FF",
        "fontSize": "16px",
        "fontWeight": "600",
        "borderRadius": "8px",
        "padding": "12px 24px",
        "width": 180,
        "height": 48
      }
    }
  ]
}
```

**Design decision, stated explicitly because it's load-bearing:** every `selector` in
this manifest is expected to be a `data-figma-id` attribute selector, and the
implementation is expected to render that attribute on the corresponding element
(e.g. `<button data-figma-id="12:34">`). This is the one convention the sibling
`figma-design-context` skill and this skill must agree on — if the app doesn't emit
`data-figma-id` attributes, either add them as you build (they're cheap: one
attribute per element, and they double as a stable hook for the pixel-diff
`--selector` clip too), or write plain CSS selectors instead and accept that the
manifest becomes fragile to markup refactors.

You can hand-write a small manifest for the elements you're actively iterating on, or
generate one from Figma node data (fills → `color`/`backgroundColor`, `textStyle` →
`fontSize`/`fontWeight`, layout → `width`/`height`/`padding`) if you've already run
`figma-design-context` against the same frame. Start small — a handful of
high-priority elements — rather than trying to encode the whole page at once; the
manifest is meant to grow alongside the parts of the UI you're actively fixing.

## Stopping criteria and convergence

Treat the loop as converged, not perfect, once:

- `diff.mjs`'s `diffRatio` is at or below a couple percent (start with the default
  `0.02` and loosen it deliberately for pages with lots of legitimately-dynamic
  content, e.g. live data or user avatars, rather than loosening it to make a real bug
  disappear), **and**
- `check-styles.mjs` reports zero failures on the elements you've marked as
  high-priority (a missing icon glyph matters less than a wrong CTA color).

Cap iterations (5-8 is a reasonable default) rather than looping indefinitely. If
`diffRatio` stops improving — or worse, oscillates between two values — across two or
three consecutive iterations, that's a signal to stop tweaking pixels and look at the
structured-check report instead: oscillation usually means two properties are being
traded off against each other (e.g. alternating between two paddings that each fix one
element while breaking a sibling), which pixel diffing alone won't diagnose but a
structured check will.

## Responsive and state variants

Both `capture.mjs` and `check-styles.mjs` take `--url` as an opaque string, so
breakpoints and states are just different invocations, not different code:

- **Breakpoints**: capture the same page at multiple widths by pointing `--width` (and
  the Figma frame you diff against) at each one — e.g. `--width 1440` for desktop,
  `--width 768` for tablet, using the corresponding Figma frame export for each.
- **Query-param-driven states**: if the app supports it, append state to the URL
  (`--url "http://localhost:3000?state=error"`) rather than scripting interaction.
- **Hover/focus/interaction states**: capture.mjs doesn't script interactions itself;
  drive them with Playwright directly (e.g. a short script that does
  `page.hover(selector)` before calling the same screenshot logic), or extend
  `--wait` usage to land on a state reached by the app's own logic (e.g. after a
  fetch resolves). Diff and check each state against its own reference image/manifest
  — a hover-state screenshot should never be diffed against a resting-state reference.

## Further reading

See [references/diffing-tradeoffs.md](references/diffing-tradeoffs.md) for *why*
pixel diffing and structured checks each fall short alone (antialiasing noise, font
hinting differences across OSes, scale mismatches) and a comparison against SSIM and
perceptual-diff alternatives. Not needed to run the loop — read it when you need to
explain or tune *why* a particular check is or isn't catching what you expect.
