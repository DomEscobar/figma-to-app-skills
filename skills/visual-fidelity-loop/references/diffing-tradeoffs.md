# Diffing tradeoffs: why this skill uses two different checks

## Why pixel diffing alone is insufficient

A raw pixel diff (pixelmatch, odiff, ImageMagick `compare`, etc.) treats the screenshot
as an undifferentiated grid of pixels. That makes it cheap and universal, but it is
blind to *why* pixels differ:

- **Antialiasing noise.** The exact same edge, rendered by the same browser on the
  same OS, can differ by a pixel or two of antialiasing between two runs, or between
  the renderer that produced the Figma export and the renderer taking the screenshot.
  Naive diffing counts every one of those pixels as a "failure," so a pixel-perfect
  implementation can still show a nonzero diff. This skill mitigates it with
  pixelmatch's `includeAA: false`, which detects and ignores antialiasing-only edges,
  but it doesn't eliminate the next two problems.
- **Font hinting / subpixel rendering differences across OSes.** Figma's export
  renderer and a local Chromium (or a CI Linux container vs. a developer's macOS
  machine) can hint and anti-alias the same font at slightly different subpixel
  positions. This shows up as a thin halo of low-magnitude diff around every line of
  text, even when the text is semantically identical, correctly sized, and correctly
  positioned.
- **Scale mismatches.** A capture taken at the wrong CSS width or deviceScaleFactor
  diffs badly against the reference for reasons that have nothing to do with visual
  fidelity — the images are being compared at different effective resolutions. This is
  exactly why `capture.mjs` requires `--width` and why `diff.mjs` flags
  `widthMismatch` loudly instead of silently resizing past it.
- **A single scalar hides *where* the problem is.** "3.2% of pixels differ" doesn't
  say whether that's one badly-colored button or a systemic 4px layout shift across
  the whole page. An agent iterating on a fix needs a location and a property, not a
  percentage.

## Why structured CSS-property checks catch more actionable bugs

`check-styles.mjs` asks a narrower, more useful question per element: "is this
specific property within tolerance of this specific expected value?" The payoff:

- Failures name the exact selector and property (`backgroundColor` on
  `[data-figma-id='12:34']`), which maps directly onto a line of code to change.
- Color and layout comparisons are normalized (rgb channels, px-with-tolerance) so
  the antialiasing/hinting noise that plagues pixel diffing never enters the
  comparison at all — `getComputedStyle` returns the resolved value the browser is
  actually using, not a rasterized approximation of it.
- It composes well with `data-figma-id`-driven manifest generation: once one exists,
  checking a new component is "add an entry," not "eyeball a new screenshot."

The tradeoff is coverage: structured checks only catch what's in the manifest.
A gradient, a box-shadow's exact blur radius, an SVG icon's path, or a subtle
z-index/overlap bug won't trip a CSS-property check — which is why this skill runs
both checks rather than treating either as sufficient on its own.

## When to use which

| Situation | Use |
|---|---|
| First-pass "are we in the right neighborhood?" | Pixel diff |
| "Which element/property is wrong?" | Structured checks |
| Verifying a specific component after a targeted fix | Structured checks |
| Catching regressions in areas with no manifest coverage (icons, gradients, shadows, illustrations) | Pixel diff |
| Final sign-off before calling an implementation "done" | Both — diffRatio below threshold *and* no failed high-priority structured checks |

## Tool comparison

| Tool | Speed | Good at | Bad at |
|---|---|---|---|
| **pixelmatch** (used here) | Fast (pure JS, no native deps) | Exact-pixel regression detection, CI-friendly, zero build toolchain | No semantic understanding; antialiasing/hinting noise unless AA-aware; one scalar for the whole image |
| **SSIM** (structural similarity) | Moderate | Perceptual "does this look structurally similar" score; more tolerant of minor rendering noise than raw pixel diff | Still a single scalar; can rate a shifted-but-similar layout as "similar" when it shouldn't be; needs a windowed/gaussian implementation to be meaningful, adding complexity |
| **Perceptual diff** (e.g. color-difference-in-LAB-space tools) | Moderate–slow | Weights differences by human color perception, so a barely-visible color shift scores low and a jarring one scores high | Still pixel-grid-based — same blindness to *where*/*why*; more setup/tuning than pixelmatch for marginal benefit in this use case |
| **Structured CSS checks** (this skill's `check-styles.mjs`) | Fast (one `getComputedStyle` call per element) | Actionable, element-and-property-scoped failures; zero antialiasing noise; scriptable pass/fail per design token | Only checks what's declared in the manifest; misses anything not modeled as a CSS property (icons, gradients, complex shadows, images) |

This skill defaults to **pixelmatch + structured checks together** rather than SSIM or
a perceptual-diff library: pixelmatch is fast, dependency-light, and "good enough" for
the coarse pass/fail signal once AA is excluded, and the structured checks are what
actually make failures fixable. SSIM/perceptual tooling is a reasonable substitute for
the pixel-diff half if you find pixelmatch too noisy for a particular UI, but it
doesn't change the case for keeping the structured half.
