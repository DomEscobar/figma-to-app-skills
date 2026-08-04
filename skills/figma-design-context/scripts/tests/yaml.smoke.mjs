/**
 * The YAML emitter is hand-rolled (to keep the scripts dependency-free) and its output
 * *is* the product of this skill — a quoting bug doesn't degrade quality, it hands the
 * consuming agent unparseable text or, worse, silently the wrong type. So these tests
 * round-trip through a real YAML parser rather than asserting on formatting.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
import { toYaml } from "../lib/yaml.mjs";

/**
 * Emit, then parse back under both YAML versions. 1.1 is not academic: PyYAML and
 * libyaml implement it, so anything that only round-trips under 1.2 is a latent bug
 * for whoever consumes this output with a script rather than a model.
 */
function roundTrip(value) {
  const text = toYaml(value);
  return { text, parsed: parse(text), parsed11: parse(text, { version: "1.1" }) };
}

function assertRoundTrip(value, label) {
  const { text, parsed, parsed11 } = roundTrip(value);
  assert.deepEqual(parsed, value, `${label} did not survive a YAML 1.2 round trip.\n--- emitted ---\n${text}`);
  assert.deepEqual(parsed11, value, `${label} did not survive a YAML 1.1 round trip.\n--- emitted ---\n${text}`);
}

test("toYaml: layer names that collide with YAML syntax survive as strings", () => {
  // Every one of these is a plausible Figma layer or style name.
  const names = [
    "Frame 1",
    "icon/24: chevron",
    "#hero",
    "- divider",
    "* spacer",
    "&anchor",
    "?maybe",
    "!important",
    "@media",
    "%pct",
    "`tick`",
    '"quoted"',
    "'single'",
    "back\\slash",
    "{brace}",
    "[bracket]",
    "trailing space ",
    " leading space",
    "",
    "hash # comment-looking",
    "Button — primary",
    "日本語ラベル",
    "emoji 🎨 label",
    // A trailing colon ends a plain scalar early and used to emit invalid YAML.
    "Email:",
    "Label: ",
    "---",
    "...",
    "a\rb",
    "a\tb",
    "a\u0001b",
  ];
  for (const name of names) {
    assertRoundTrip({ name }, `value ${JSON.stringify(name)}`);
    assertRoundTrip({ [name]: "v" }, `key ${JSON.stringify(name)}`);
  }
});

test("toYaml: strings YAML would coerce to another type stay strings", () => {
  // Figma names like "123" or "on" are common; if these come back as a number or
  // boolean the consuming agent silently generates the wrong thing.
  const traps = [
    "null", "true", "false", "yes", "no", "on", "off", "~",
    "y", "Y", "n", "N", // YAML 1.1 single-letter booleans
    "123", "1.5", "-7", "+7", "1e5", ".5", ".inf", ".nan",
    "0x1f", "0o17", "0664", "0b101", "1_000",
  ];
  for (const text of traps) {
    const { parsed, parsed11 } = roundTrip({ name: text });
    assert.equal(typeof parsed.name, "string", `${JSON.stringify(text)} lost its type under YAML 1.2`);
    assert.equal(typeof parsed11.name, "string", `${JSON.stringify(text)} lost its type under YAML 1.1`);
    assert.equal(parsed.name, text);
    assert.equal(parsed11.name, text);
  }
});

test("toYaml: a node id is never read as a sexagesimal number", () => {
  // `1:23` is the API's node id format and appears on every node. YAML 1.1 resolves
  // it to 83 unless it is quoted, which would corrupt every id in the output.
  for (const id of ["1:23", "12:30:00", "0:1", "1234:5678"]) {
    const { parsed, parsed11 } = roundTrip({ id });
    assert.equal(parsed.id, id);
    assert.equal(parsed11.id, id, `${id} was resolved as sexagesimal under YAML 1.1`);
  }
});

test("toYaml: real types are preserved rather than stringified", () => {
  assertRoundTrip({ n: 12, f: 1.5, neg: -3, zero: 0, t: true, f2: false, nil: null }, "scalar types");
});

test("toYaml: multi-line text content round-trips exactly", () => {
  // Multi-line TEXT layers are routine, and this is the emitter's most delicate path.
  assertRoundTrip({ characters: "line one\nline two\nline three" }, "multi-line string");
  assertRoundTrip({ characters: "paragraph one\n\nparagraph two" }, "string with a blank line");
  assertRoundTrip({ characters: "trailing newline\n" }, "one trailing newline");
  assertRoundTrip({ characters: "two trailing\n\n" }, "two trailing newlines");
  assertRoundTrip({ characters: "\n" }, "a lone newline");
  assertRoundTrip({ characters: "  indented\n    deeper" }, "leading indentation");
  assertRoundTrip({ characters: "trailing space \nnext" }, "a trailing space on a line");
  assertRoundTrip({ characters: "windows\r\nline endings" }, "CRLF line endings");
  assertRoundTrip({ nested: { deep: { characters: "a\nb" } } }, "nested multi-line string");
  assertRoundTrip({ list: ["a\nb", "c\nd"] }, "multi-line strings inside a list");
});

test("toYaml: a multi-line string still uses a readable block scalar in the common case", () => {
  // The correctness fallback is a quoted one-liner; if it started firing for ordinary
  // paragraph text the output would get much harder for a model to read.
  const { text } = roundTrip({ characters: "line one\nline two" });
  assert.match(text, /characters: \|-\n {2}line one\n {2}line two/);
});

test("toYaml: nested structures and empty containers round-trip", () => {
  assertRoundTrip({ emptyObj: {}, emptyArr: [], list: [1, 2, 3] }, "empty containers");
  assertRoundTrip(
    {
      nodes: [
        { id: "1:2", name: "Card", children: [{ id: "1:3", name: "Title", characters: "Hi" }] },
        { id: "1:4", name: "Row", children: [] },
      ],
      globalVars: { styles: { fill_ABC: ["#fff"] } },
    },
    "a design-shaped tree",
  );
});

test("toYaml: a list of lists keeps its nesting", () => {
  assertRoundTrip({ matrix: [[1, 2], [3, 4]] }, "nested arrays");
  assertRoundTrip({ mixed: [{ a: 1 }, [2, 3], "four"] }, "heterogeneous array");
});

test("toYaml: undefined members are dropped, not emitted as null", () => {
  const { parsed } = roundTrip({ kept: 1, dropped: undefined });
  assert.deepEqual(parsed, { kept: 1 });
});
