# Inspector evidence format

Create a JSON file only from values visible in Figma's Layer panel, Editor inspector, Dev Mode inspector, code panel, or authorized asset download UI.

```json
{
  "version": 1,
  "source": { "view": "dev-mode" },
  "selection": {
    "nodeId": "43:44",
    "name": "Primary button",
    "layerType": "INSTANCE"
  },
  "properties": [
    {
      "name": "padding-inline",
      "value": 16,
      "unit": "px",
      "source": "visible-inspector",
      "evidence": "right-sidebar"
    },
    {
      "name": "css",
      "value": "border-radius: 8px",
      "source": "dev-mode-code",
      "evidence": "code-panel"
    }
  ],
  "assets": [
    {
      "name": "logo.svg",
      "path": "assets/logo.svg",
      "source": "visible-download"
    }
  ],
  "unavailable": ["constraints", "prototype-hover"],
  "inferred": [
    {
      "field": "mobile-collapse",
      "value": "drawer",
      "reason": "No authored mobile frame was visible"
    }
  ]
}
```

Rules:

- Put only directly displayed or downloaded values in `properties` and `assets`.
- Store asset inputs beneath an `assets/` directory next to the evidence JSON; the helper rejects traversal, copies them into the capture bundle, and adds SHA-256 hashes.
- Use `visible-inspector`, `dev-mode-code`, or `visible-download` exactly.
- Put guesses in `inferred`; never promote them to confirmed properties.
- List inaccessible or absent fields under `unavailable`.
- Keep one file per selected layer when different layers would make provenance ambiguous.
