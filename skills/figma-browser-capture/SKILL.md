---
name: "figma-browser-capture"
description: "Use when Figma REST access is unavailable or rate-limited; capture an authorized frame and seal visible inspector evidence."
---

# Figma browser capture

Capture an authorized Figma frame without the REST API, then hand the sealed raster reference and provenance-marked inspector evidence to `figma-responsive-implementation`. Use the visible Figma browser UI only; do not bypass permissions, conceal automation, replay private network calls, or treat browser capture as a way around Figma access controls.

## Procedure

1. Classify the source as a public share/prototype link or an already-authorized browser session. Require a frame-specific URL when possible, reject credentials in URLs, and stop for login, permission, CAPTCHA, or 2FA. Complete when the accessible source, target frame, access mode, and intended viewport are identified.
2. Choose the richest authorized view. Use Presentation or Embed view for a clean raster; use Editor or Dev Mode only when visible inspector properties or asset downloads are needed. Hide Figma chrome and hotspot hints when the view supports it, but preserve the original URL and selected node id in the manifest. Complete when the target frame is isolated without changing the design.
3. Install the helper dependencies in `scripts/`, then run `capture.mjs` with the Figma URL, output directory, viewport, and source/access modes. Use a managed Playwright browser for public links. For an existing authorized Chromium session, attach only through a loopback CDP endpoint and never pass cookies or credentials to the helper. Use `--clip` or `--selector` only after verifying the crop. Complete when `frame.png`, `capture-manifest.json`, and `integrity.json` exist and the stability check passes.
4. When structure is needed, select layers through the visible Layer panel or canvas, then read only the visible Editor/Dev Mode inspector. Record confirmed properties in the format documented by `references/inspector-format.md` with source `visible-inspector` or `dev-mode-code`; record guesses only under `inferred`. Keep authorized downloads under the evidence file's `assets/` directory. Pass that JSON through `--inspector` so the helper validates provenance, blocks path traversal, copies each asset, and seals every hash. Complete when every claimed property and asset has visible provenance and unavailable fields are listed.
5. Treat the browser result as `image-only` unless confirmed inspector evidence supplies a field. Never infer a complete node tree, Auto Layout, constraints, variables, components, or interaction states from the WebGL canvas. Hand `frame.png`, `inspector.json` when present, and the integrity files to `figma-responsive-implementation`; mark unobserved responsive behavior and states as inferred. Complete when the downstream contract identifies authored versus inferred evidence.
6. Verify the helper with its focused tests. Require a stable fixture to pass, an animated fixture to fail stability, unsafe URLs and non-loopback CDP targets to fail, inspector provenance and asset-traversal violations to fail, and every screenshot, manifest, inspector file, and copied asset hash to match. Complete when the skill validator and focused tests pass.

## Failure boundaries

- A public screenshot proves only the captured pixels and viewport.
- A visible inspector value proves only the selected layer and displayed field.
- Existing-session capture has weaker environmental control than managed Playwright; preserve the measured DPR and browser version in the manifest.
- Figma UI changes may invalidate interactive selectors. Refresh the snapshot and recover once; do not scrape undocumented application state.
- Use the official Figma Plugin API when a complete reliable node tree is required and the user can run a read-only plugin in the file.
