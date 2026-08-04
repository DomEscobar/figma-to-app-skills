import assert from "node:assert/strict";
import { test } from "node:test";
import { extractDesign } from "../lib/extract.mjs";
import { toYaml } from "../lib/yaml.mjs";
import { parseFigmaTarget, toApiNodeId, toUrlNodeId } from "../lib/url.mjs";
import { cssColor, flattenSolids } from "../lib/paint.mjs";
import { buildLayout } from "../lib/layout.mjs";

test("url parsing normalizes node ids and extracts file keys", () => {
  const a = parseFigmaTarget("https://www.figma.com/design/AbCdEf12345/My-File?node-id=12-34");
  assert.equal(a.fileKey, "AbCdEf12345");
  assert.equal(a.nodeId, "12:34");

  const b = parseFigmaTarget("AbCdEf12345/12:34");
  assert.equal(b.nodeId, "12:34");

  assert.equal(toApiNodeId("1-2"), "1:2");
  assert.equal(toUrlNodeId("1:2"), "1-2");
});

test("color conversion: opaque -> hex, translucent -> rgba", () => {
  assert.equal(cssColor({ r: 1, g: 1, b: 1, a: 1 }), "#FFFFFF");
  assert.equal(cssColor({ r: 0, g: 0, b: 0, a: 0.5 }), "rgba(0, 0, 0, 0.5)");
});

test("flattenSolids composites an opaque-over-opaque stack to the top color", () => {
  const result = flattenSolids([
    { type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } },
    { type: "SOLID", color: { r: 0, g: 1, b: 0, a: 1 } },
  ]);
  assert.equal(result, "#00FF00");
});

test("flattenSolids returns null for a gradient stack (cannot fold)", () => {
  const result = flattenSolids([{ type: "GRADIENT_LINEAR", gradientStops: [] }]);
  assert.equal(result, null);
});

test("buildLayout: row auto-layout with gap and padding", () => {
  const node = {
    type: "FRAME",
    layoutMode: "HORIZONTAL",
    itemSpacing: 16,
    paddingTop: 8,
    paddingBottom: 8,
    paddingLeft: 12,
    paddingRight: 12,
    primaryAxisAlignItems: "CENTER",
    counterAxisAlignItems: "CENTER",
    absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 48 },
  };
  const layout = buildLayout(node, undefined);
  assert.equal(layout.mode, "row");
  assert.equal(layout.gap, "16px");
  assert.equal(layout.padding, "8px 12px");
  assert.equal(layout.justifyContent, "center");
  assert.equal(layout.alignItems, "center");
});

test("buildLayout: layoutGrow in a row parent maps to horizontal fill, not vertical", () => {
  const parent = { type: "FRAME", layoutMode: "HORIZONTAL" };
  const child = { type: "FRAME", layoutGrow: 1, absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 } };
  const layout = buildLayout(child, parent);
  assert.equal(layout.sizing?.horizontal, "fill");
  assert.notEqual(layout.sizing?.vertical, "fill");
});

test("buildLayout: layoutGrow in a column parent maps to vertical fill (axis-swap regression)", () => {
  const parent = { type: "FRAME", layoutMode: "VERTICAL" };
  const child = { type: "FRAME", layoutGrow: 1, absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 } };
  const layout = buildLayout(child, parent);
  assert.equal(layout.sizing?.vertical, "fill");
  assert.notEqual(layout.sizing?.horizontal, "fill");
});

test("buildLayout: root node reports designed size as contextual, not a pinned dimension", () => {
  const node = { type: "FRAME", absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 } };
  const layout = buildLayout(node, undefined, { isRoot: true });
  assert.equal(layout.designedWidth, "1440px");
  assert.equal(layout.dimensions, undefined);
});

test("extractDesign: dedups a repeated fill into globalVars and inlines a one-off", () => {
  const redFill = { type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, visible: true };
  const blueFill = { type: "SOLID", color: { r: 0, g: 0, b: 1, a: 1 }, visible: true };
  const makeButton = (id, fill) => ({
    id,
    name: "Button",
    type: "FRAME",
    fills: [fill],
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
  });

  const root = {
    id: "0:1",
    name: "Root",
    type: "FRAME",
    absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 100 },
    children: [makeButton("1:1", redFill), makeButton("1:2", redFill), makeButton("1:3", blueFill)],
  };

  const { nodes, globalVars, assets } = extractDesign([root]);
  const [button1, button2, button3] = nodes[0].children;

  assert.equal(button1.fills, button2.fills, "repeated fill should share one dictionary key");
  assert.ok(typeof globalVars.styles[button1.fills] !== "undefined", "shared fill should be hoisted");
  assert.ok(Array.isArray(button3.fills), "single-use fill should be inlined, not referenced");
  assert.deepEqual(assets, { svgNodeIds: [], imageRefs: [] });

  // Sanity: the whole thing must actually serialize without throwing.
  const yaml = toYaml({ nodes, globalVars });
  assert.ok(yaml.includes("Root"));
});

test("extractDesign: collapses an all-vector icon container to a single IMAGE-SVG leaf", () => {
  const root = {
    id: "0:1",
    name: "Icon",
    type: "FRAME",
    absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
    children: [
      { id: "0:2", name: "Path 1", type: "VECTOR", absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 } },
      { id: "0:3", name: "Path 2", type: "VECTOR", absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 } },
    ],
  };
  const { nodes, assets } = extractDesign([root]);
  assert.equal(nodes[0].type, "IMAGE-SVG");
  assert.equal(nodes[0].children, undefined);
  assert.deepEqual(assets.svgNodeIds, ["0:1"]);
});

test("extractDesign: a named Figma fill style is hoisted under its name, even used once", () => {
  const node = {
    id: "0:1",
    name: "Chip",
    type: "FRAME",
    fills: [{ type: "SOLID", color: { r: 0.2, g: 0.4, b: 1, a: 1 }, visible: true }],
    styles: { fill: "S:123abc" },
    absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 20 },
  };
  const { nodes, globalVars } = extractDesign([node], {
    namedStyleMeta: { "S:123abc": { name: "Brand/Primary" } },
  });
  assert.equal(nodes[0].fills, "Brand/Primary");
  assert.ok(globalVars.styles["Brand/Primary"], "named style survives finalize even at one use");
});

test("extractDesign: rich text override becomes an inline {tsN} span, base run stays plain", () => {
  const node = {
    id: "0:1",
    name: "Label",
    type: "TEXT",
    characters: "Hello world",
    style: { fontFamily: "Inter", fontWeight: 400, fontSize: 16 },
    characterStyleOverrides: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1],
    styleOverrideTable: { 1: { fontWeight: 700 } },
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 },
  };
  const { nodes, globalVars } = extractDesign([node]);
  assert.match(nodes[0].text, /^Hello \{ts1\}world\{\/ts1\}$/);
  assert.deepEqual(globalVars.styles.ts1, { fontWeight: 700 });
});
