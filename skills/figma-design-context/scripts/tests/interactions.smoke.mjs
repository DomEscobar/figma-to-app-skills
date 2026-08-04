import assert from "node:assert/strict";
import { test } from "node:test";
import { buildInteractions, buildVariantProperties, parseVariantName } from "../lib/interactions.mjs";
import { extractDesign } from "../lib/extract.mjs";

test("buildInteractions: ON_HOVER marks reverts, CHANGE_TO becomes changeTo with variant name", () => {
  const node = {
    id: "1:1",
    interactions: [
      {
        trigger: { type: "ON_HOVER" },
        actions: [
          {
            type: "NODE",
            destinationId: "2:2",
            navigation: { type: "CHANGE_TO" },
            transition: { type: "SMART_ANIMATE", duration: 0.2, easing: { type: "EASE_OUT" } },
          },
        ],
      },
    ],
  };

  const [interaction] = buildInteractions(node, (id) => (id === "2:2" ? "State=hover" : undefined));
  assert.equal(interaction.on, "hover");
  assert.equal(interaction.reverts, true);
  assert.deepEqual(interaction.actions, [
    {
      type: "changeTo",
      to: "2:2",
      toVariant: "State=hover",
      transition: { type: "smartAnimate", duration: "200ms", easing: "ease-out" },
    },
  ]);
});

test("buildInteractions: MOUSE_ENTER is permanent, so it carries no reverts flag", () => {
  const node = {
    interactions: [
      { trigger: { type: "MOUSE_ENTER", delay: 0.3 }, actions: [{ type: "NODE", destinationId: "3:3", navigation: { type: "NAVIGATE" } }] },
    ],
  };

  const [interaction] = buildInteractions(node);
  assert.equal(interaction.on, "mouseEnter");
  assert.equal(interaction.reverts, undefined);
  assert.equal(interaction.delay, "300ms");
  assert.equal(interaction.actions[0].type, "navigate");
});

test("buildInteractions: a trigger whose actions are all null is dropped entirely", () => {
  // Observed in a real file: a leftover AFTER_TIMEOUT trigger with `actions: [null]`.
  const node = { interactions: [{ trigger: { type: "AFTER_TIMEOUT", timeout: 0.8 }, actions: [null] }] };
  assert.equal(buildInteractions(node), undefined);
});

test("buildInteractions: absent/empty interactions emit nothing", () => {
  assert.equal(buildInteractions({}), undefined);
  assert.equal(buildInteractions({ interactions: [] }), undefined);
  assert.equal(buildInteractions(undefined), undefined);
});

test("buildInteractions: unknown trigger types are skipped, unknown action types are named", () => {
  const unknownTrigger = { interactions: [{ trigger: { type: "ON_TELEPATHY" }, actions: [{ type: "BACK" }] }] };
  assert.equal(buildInteractions(unknownTrigger), undefined);

  const unknownAction = { interactions: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "FUTURE_ACTION" }] }] };
  assert.deepEqual(buildInteractions(unknownAction)[0].actions, [{ type: "FUTURE_ACTION" }]);
});

test("buildInteractions: URL, BACK and CLOSE actions map to explicit types", () => {
  const node = {
    interactions: [
      {
        trigger: { type: "ON_CLICK" },
        actions: [{ type: "URL", url: "https://example.com" }, { type: "BACK" }, { type: "CLOSE" }],
      },
    ],
  };

  assert.deepEqual(buildInteractions(node)[0].actions, [
    { type: "openUrl", url: "https://example.com" },
    { type: "goBack" },
    { type: "closeOverlay" },
  ]);
});

test("buildInteractions: a spring easing has no CSS equivalent and is passed through by name", () => {
  const node = {
    interactions: [
      {
        trigger: { type: "ON_CLICK" },
        actions: [
          {
            type: "NODE",
            destinationId: "4:4",
            navigation: { type: "NAVIGATE" },
            transition: { type: "MOVE_IN", direction: "LEFT", duration: 0.3, easing: { type: "GENTLE_SPRING" } },
          },
        ],
      },
    ],
  };

  const { transition } = buildInteractions(node)[0].actions[0];
  assert.equal(transition.type, "moveIn");
  assert.equal(transition.direction, "left");
  assert.deepEqual(transition.easing, { figmaEasing: "GENTLE_SPRING" });
});

test("buildInteractions: a custom cubic bezier easing becomes a CSS cubic-bezier()", () => {
  const node = {
    interactions: [
      {
        trigger: { type: "ON_CLICK" },
        actions: [
          {
            type: "NODE",
            destinationId: "5:5",
            navigation: { type: "NAVIGATE" },
            transition: {
              type: "DISSOLVE",
              duration: 0.15,
              easing: { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.4, y1: 0, x2: 0.2, y2: 1 } },
            },
          },
        ],
      },
    ],
  };

  const { transition } = buildInteractions(node)[0].actions[0];
  assert.equal(transition.easing, "cubic-bezier(0.4, 0, 0.2, 1)");
  assert.equal(transition.duration, "150ms");
});

test("buildInteractions: a CONDITIONAL action keeps its branches' actions", () => {
  const node = {
    interactions: [
      {
        trigger: { type: "ON_CLICK" },
        actions: [
          {
            type: "CONDITIONAL",
            conditionalBlocks: [
              { actions: [{ type: "NODE", destinationId: "6:6", navigation: { type: "NAVIGATE" } }] },
              { actions: [null] },
            ],
          },
        ],
      },
    ],
  };

  const [action] = buildInteractions(node)[0].actions;
  assert.equal(action.type, "conditional");
  assert.equal(action.branches.length, 1, "the branch whose only action was null is dropped");
  assert.equal(action.branches[0].actions[0].to, "6:6");
});

test("buildVariantProperties: VARIANT axes are listed, non-variant properties ignored", () => {
  const node = {
    type: "COMPONENT_SET",
    componentPropertyDefinitions: {
      "State#1:0": { type: "VARIANT", defaultValue: "default", variantOptions: ["default", "hover", "pressed"] },
      Size: { type: "VARIANT", defaultValue: "md", variantOptions: ["sm", "md"] },
      "Show icon#2:0": { type: "BOOLEAN", defaultValue: true },
    },
  };

  assert.deepEqual(buildVariantProperties(node), {
    State: ["default", "hover", "pressed"],
    Size: ["sm", "md"],
  });
  assert.equal(buildVariantProperties({ type: "FRAME" }), undefined);
});

test("parseVariantName: splits Figma's Axis=Value encoding, including axes with spaces", () => {
  assert.deepEqual(parseVariantName("Size=L, Type=Primary, State=Hover, Icon left=Off"), {
    Size: "L",
    Type: "Primary",
    State: "Hover",
    "Icon left": "Off",
  });
  assert.deepEqual(parseVariantName("State=Default"), { State: "Default" });
});

test("parseVariantName: a non-variant component name is rejected rather than coerced", () => {
  assert.equal(parseVariantName("Button/Primary"), undefined);
  assert.equal(parseVariantName("icon-16"), undefined);
  assert.equal(parseVariantName("Size=L, plain segment"), undefined);
  assert.equal(parseVariantName("=Hover"), undefined);
  assert.equal(parseVariantName(undefined), undefined);
});

test("buildVariantProperties: axes are derived from child names when definitions are absent", () => {
  // Real component sets come back with no componentPropertyDefinitions at all; the
  // axes only exist in the children's names. Values keep first-seen order.
  const node = {
    type: "COMPONENT_SET",
    children: [
      { type: "COMPONENT", name: "Size=L, State=Default" },
      { type: "COMPONENT", name: "Size=L, State=Hover" },
      { type: "COMPONENT", name: "Size=S, State=Default" },
      { type: "COMPONENT", name: "Divider" },
    ],
  };

  assert.deepEqual(buildVariantProperties(node), { Size: ["L", "S"], State: ["Default", "Hover"] });
});

test("buildVariantProperties: declared definitions win over derived names", () => {
  const node = {
    type: "COMPONENT_SET",
    componentPropertyDefinitions: {
      State: { type: "VARIANT", defaultValue: "a", variantOptions: ["a", "b"] },
    },
    children: [{ type: "COMPONENT", name: "State=derived" }],
  };

  assert.deepEqual(buildVariantProperties(node), { State: ["a", "b"] });
});

test("buildVariantProperties: a non-COMPONENT_SET frame never yields derived axes", () => {
  const frame = { type: "FRAME", children: [{ type: "TEXT", name: "width=100" }] };
  assert.equal(buildVariantProperties(frame), undefined);
});

test("extractDesign: interactions and variant states survive the full walk, named by component meta", () => {
  const raw = [
    {
      id: "0:1",
      name: "Buttons",
      type: "COMPONENT_SET",
      absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 100 },
      componentPropertyDefinitions: {
        State: { type: "VARIANT", defaultValue: "default", variantOptions: ["default", "hover"] },
      },
      children: [
        {
          id: "1:1",
          name: "State=default",
          type: "COMPONENT",
          absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
          interactions: [
            {
              trigger: { type: "ON_HOVER" },
              actions: [{ type: "NODE", destinationId: "1:2", navigation: { type: "CHANGE_TO" } }],
            },
          ],
        },
      ],
    },
  ];

  const { nodes } = extractDesign(raw, { componentMeta: { "1:2": { name: "State=hover" } } });
  assert.deepEqual(nodes[0].variantProperties, { State: ["default", "hover"] });

  const [interaction] = nodes[0].children[0].interactions;
  assert.equal(interaction.on, "hover");
  assert.equal(interaction.reverts, true);
  assert.equal(interaction.actions[0].toVariant, "State=hover");
});
