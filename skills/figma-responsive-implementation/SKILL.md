---
name: "figma-responsive-implementation"
description: "Implement Figma or screenshot UIs with persistent design memory, responsive browser gates, and deterministic visual checks."
---

# Figma responsive implementation

Use for implementing or repairing a screen from pinned Figma frames or reference screenshots.

Pixel fidelity, responsive behavior, design-scale consistency, accessibility, interaction states, and code quality are independent gates. None substitutes for another.

## Inputs

Require:
- pinned Figma version, node IDs, and exports, or protected image-only references;
- target route and pinned browser/font environment;
- authored reference viewports plus probe widths at every breakpoint -1, exact, and +1;
- profile: web or large-display;
- existing design tokens, or permission to derive a small local scale;
- a protected integrity manifest created before implementation.

One image proves only that width and state. Mark other behavior as inferred. Large-display requires an authored frame or explicit viewing-distance and typography requirements; UHD resolution alone is not a scaling rule.

## Workflow

1. Inspect repository primitives, tokens, fonts, breakpoints, styling conventions, components, and tests. Run `scripts/design-memory.mjs scan` in the trusted setup step to create a protected `design-system.snapshot.json` from the real application code and token files.
2. Review `design-decisions.json`. Map Figma styles to existing code tokens; record only narrow, justified exceptions with provenance. The code and token files are authoritative; the snapshot is a regenerable index.
3. In structured mode, extract Figma assets, auto-layout, variants, fixed/fill/hug semantics, and reference dimensions. When REST access is absent or rate-limited, run `figma-browser-capture` and verify its `frame.png`, capture manifest, integrity file, and optional visible-inspector evidence before use. Treat fields not confirmed by the visible inspector as image-only inference; never reconstruct a complete node tree from the WebGL canvas. In ordinary image-only mode, keep the reference immutable and record inferred structure separately.
4. Create the contract from templates/responsive-contract.json.
   - Reuse an existing design system.
   - Otherwise derive the smallest coherent typography, spacing, icon, control, and layout scale.
   - Mark values existing, Figma-derived, specified, or inferred.
5. Validate the JSON Schema. Protect the design-memory config, decisions, schemas, and generated snapshot in the same integrity manifest. Generate hashes for contract, schema, references, and thresholds outside the implementer's patch.
6. Implement with semantic components and normal flow, flex, or grid. Absolute positioning is for intentional overlays or decoration. Reuse an existing semantic token when it fits. Add a token through the application's existing mechanism when a value is semantic or repeated. Keep a truly unique illustration/component value local as a custom property or constant; do not create global token pollution.
7. Run scripts/figma-gate.mjs in the pinned harness. Inspect localized diff blobs, affected DOM elements, text-line diagnostics, relationship graphs, and viewport trajectories.
8. When a localized region lacks Figma-node or DOM correspondence, run DINOv2 ViT-S on native-resolution crops and record ranked candidate regions. Do not load DINO when deterministic correspondence already exists.
9. Keep SAM disabled by default. Use SAM only for an irregular illustration or image object after a precise box or grounded prompt exists. Never use SAM for ordinary cards, text, charts, or whole panels.
10. Repair one component or error class per cycle. Re-run every gate and viewport. Keep the previous candidate if total results regress.
11. Stop after three repairs, two non-improving cycles, or attempted changes to protected inputs.

## Acceptance

Pass only when:
- every authored viewport passes visual and geometry thresholds;
- every probe passes responsive and scale invariants;
- required states and serious/critical accessibility checks pass;
- code-quality findings and new design-memory findings are empty; copied token literals, unexplained values, expansions of inventoried legacy debt, unresolved mappings/references, and stale snapshots fail;
- protected hashes and protected-file CI checks pass;
- repository tests pass;
- no previously green viewport regresses.

The implementing agent may edit application code only. It may not update references, contracts, design-memory snapshots/config/decisions, schemas, thresholds, integrity manifests, gate scripts, or expected eval outcomes. A trusted reviewer regenerates and re-seals the snapshot only after approving a legitimate token-system change.

Run `scripts/design-memory-eval.mjs` after scanner or policy changes. It must accept tokenized code and approved local exceptions, and reject copied token literals, unknown values, and stale snapshots.

Run scripts/eval.mjs after harness changes. All positive and adversarial cases must match their expected verdict and reason.

Run scripts/image-only-eval.mjs for screenshot-only changes. The clean reconstruction must pass; the injected geometry fault must fail with a localized diff blob.

Optional OmniParser, DINOv2, grounded segmentation, LPIPS, or DISTS outputs must follow references/vision-diagnostics.schema.json, be integrity-pinned, and remain diagnostic-only. DINO may propose region correspondence. SAM may propose masks only under the routing rule above. No model output may override deterministic acceptance.

## Validated routing evidence

In the independent Atlas screenshot-to-code spike, official DINOv2 ViT-S matched 6/6 reference regions to the correct implementation regions on CPU. Official SAM 2.1 Tiny mostly selected whole panels under box prompts and produced unstable point-prompt masks across the reference and implementation. Treat this as routing evidence, not as a universal benchmark.


Read `references/design-memory.md` when setting up or changing repository-wide design memory.
