# Optional vision diagnostics

Use only when Figma node IDs and DOM correspondence are unavailable.

- OmniParser: screenshot UI boxes and labels.
- Grounding DINO plus SAM, or SAM 3: text-grounded boxes and masks for canvas, illustrations, and irregular shapes.
- DINO patch features: candidate correspondence between reference and rendered regions.
- LPIPS or DISTS: perceptual diagnosis after exact geometry and pixel checks.

Adapters run outside the acceptance process and write one protected JSON file conforming to vision-diagnostics.schema.json. Record provider, model/checkpoint identity, image hashes, boxes, masks, confidence, and perceptual scores. The gate includes this information in its report but ignores it when computing pass/fail.

For UHD, use coarse-to-fine crops at native resolution. Never downscale the only copy of a small target.
