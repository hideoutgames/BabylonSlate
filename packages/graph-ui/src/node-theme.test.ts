import { describe, expect, it } from "vitest";
import {
  edgeStyleForPin,
  nodeRoleClass,
  nodeVisualRole,
  pinCssVar,
  pinVisualShape,
} from "./node-theme";

describe("pinCssVar", () => {
  it("maps primitive pin kinds to CSS variables", () => {
    expect(pinCssVar({ kind: "exec" })).toBe("var(--pin-exec)");
    expect(pinCssVar({ kind: "bool" })).toBe("var(--pin-bool)");
    expect(pinCssVar({ kind: "int" })).toBe("var(--pin-int)");
    expect(pinCssVar({ kind: "float" })).toBe("var(--pin-float)");
    expect(pinCssVar({ kind: "string" })).toBe("var(--pin-string)");
  });

  it("maps vector families to --pin-vector", () => {
    expect(pinCssVar({ kind: "vec2" })).toBe("var(--pin-vector)");
    expect(pinCssVar({ kind: "vec3" })).toBe("var(--pin-vector)");
    expect(pinCssVar({ kind: "vec4" })).toBe("var(--pin-vector)");
  });

  it("maps math, ref, and wildcard families", () => {
    expect(pinCssVar({ kind: "rotator" })).toBe("var(--pin-rotator)");
    expect(pinCssVar({ kind: "transform" })).toBe("var(--pin-transform)");
    expect(pinCssVar({ kind: "color" })).toBe("var(--pin-color)");
    expect(pinCssVar({ kind: "objectRef", classId: "Actor" })).toBe(
      "var(--pin-object)",
    );
    expect(pinCssVar({ kind: "actorRef", classId: "Actor" })).toBe(
      "var(--pin-actor)",
    );
    expect(pinCssVar({ kind: "structRef", guid: "g" })).toBe("var(--pin-struct)");
    expect(pinCssVar({ kind: "enumRef", guid: "g" })).toBe("var(--pin-enum)");
    expect(pinCssVar({ kind: "resolvingWildcard" })).toBe("var(--pin-wildcard)");
    expect(pinCssVar({ kind: "boxedWildcard" })).toBe("var(--pin-wildcard)");
    expect(pinCssVar({ kind: "delegate" })).toBe("var(--pin-delegate)");
  });

  it("uses the element type for arrays and the value type for maps", () => {
    expect(pinCssVar({ kind: "array", element: { kind: "float" } })).toBe(
      "var(--pin-float)",
    );
    expect(
      pinCssVar({
        kind: "map",
        key: { kind: "string" },
        value: { kind: "bool" },
      }),
    ).toBe("var(--pin-bool)");
  });

  it("falls back to wildcard for unknown kinds", () => {
    expect(pinCssVar({ kind: "mystery" })).toBe("var(--pin-wildcard)");
  });
});

describe("pinVisualShape", () => {
  it("uses a diamond for exec, a list for arrays, and a circle otherwise", () => {
    expect(pinVisualShape({ kind: "exec" })).toBe("diamond");
    expect(
      pinVisualShape({ kind: "array", element: { kind: "float" } }),
    ).toBe("list");
    expect(
      pinVisualShape({
        kind: "array",
        element: { kind: "array", element: { kind: "string" } },
      }),
    ).toBe("list");
    expect(pinVisualShape({ kind: "string" })).toBe("circle");
    expect(
      pinVisualShape({
        kind: "map",
        key: { kind: "string" },
        value: { kind: "bool" },
      }),
    ).toBe("circle");
  });
});

describe("nodeVisualRole", () => {
  it("treats flow.event nodes and Event titles as events even when marked pure", () => {
    expect(
      nodeVisualRole({
        nodeType: "flow.event.beginPlay",
        category: "flow",
        pure: true,
      }),
    ).toBe("event");
    expect(
      nodeVisualRole({ title: "Event Tick", category: "flow", pure: true }),
    ).toBe("event");
  });

  it("maps latent and timer nodes", () => {
    expect(nodeVisualRole({ latent: true, category: "debug" })).toBe("latent");
    expect(nodeVisualRole({ category: "timers" })).toBe("latent");
  });

  it("maps debug, flow, and variable roles", () => {
    expect(nodeVisualRole({ category: "debug" })).toBe("debug");
    expect(nodeVisualRole({ category: "flow", nodeType: "flow.branch" })).toBe(
      "flow",
    );
    expect(
      nodeVisualRole({ category: "variables", nodeType: "variables.get" }),
    ).toBe("variable");
    expect(
      nodeVisualRole({ category: "variables", nodeType: "variables.set" }),
    ).toBe("variable-set");
  });

  it("maps pure nodes to the pure role and defaults to function", () => {
    expect(nodeVisualRole({ category: "math", pure: true })).toBe("pure");
    expect(nodeVisualRole({ category: "physics" })).toBe("function");
  });
});

describe("nodeRoleClass", () => {
  it("returns a static Tailwind background class per role", () => {
    expect(nodeRoleClass("event")).toBe("bg-node-event");
    expect(nodeRoleClass("function")).toBe("bg-node-function");
    expect(nodeRoleClass("variable-set")).toBe("bg-node-variable-set");
  });
});

describe("edgeStyleForPin", () => {
  it("colors and thickens exec wires", () => {
    expect(edgeStyleForPin({ kind: "exec" })).toEqual({
      stroke: "var(--pin-exec)",
      strokeWidth: 5,
    });
    expect(edgeStyleForPin({ kind: "bool" })).toEqual({
      stroke: "var(--pin-bool)",
      strokeWidth: 4,
    });
  });
});
