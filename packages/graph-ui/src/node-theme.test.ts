import { describe, expect, it } from "vitest";
import { basicParticleStageRole } from "@babylonslate/ui/lib/data-types";
import {
  nodeVisualRole,
  pinCssVar,
} from "./node-theme";

describe("pinCssVar", () => {
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
    expect(
      nodeVisualRole({
        nodeType: "anim.event.initialize",
        category: "animation",
        pure: true,
      }),
    ).toBe("event");
    expect(
      nodeVisualRole({
        nodeType: "anim.rule.exitState",
        title: "Exit State",
        category: "animation",
        pure: true,
      }),
    ).toBe("event");
    expect(
      nodeVisualRole({
        nodeType: "flow.event.call",
        title: "Call On Hit",
        category: "flow",
      }),
    ).toBe("event");
  });

  it("maps Call Parent Event to a distinct brown role", () => {
    expect(
      nodeVisualRole({
        nodeType: "flow.event.callParent",
        title: "Call Begin Play Parent",
        category: "flow",
      }),
    ).toBe("call-parent");
    expect(
      nodeVisualRole({
        nodeType: "flow.event.callParent",
        title: "Event Call Begin Play Parent",
        category: "flow",
      }),
    ).toBe("call-parent");
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
    expect(
      nodeVisualRole({
        category: "variables",
        nodeType: "variables.getValidated",
        title: "Validated Get Target",
      }),
    ).toBe("variable");
  });

  it("maps pure nodes to the pure role and defaults to function", () => {
    expect(nodeVisualRole({ category: "math", pure: true })).toBe("pure");
    expect(nodeVisualRole({ category: "physics" })).toBe("function");
  });

  it("colours Particle Graph headers like the matching Basic Particle Emitter stage", () => {
    const graphHeader = (nodeType: string, title: string, category: string, particleRole: string) =>
      nodeVisualRole({ nodeType, title, category, particleRole });
    // Generic rules would call every one of these a function node.
    expect(graphHeader("particle.output", "Emitter Output", "Emitter", "output")).toBe(
      basicParticleStageRole("emitter"),
    );
    expect(graphHeader("create.particle", "Create Particle", "Emitter", "create")).toBe(
      basicParticleStageRole("initialize"),
    );
    expect(graphHeader("shape.sphere", "Sphere Shape", "Shape", "shape")).toBe(
      basicParticleStageRole("shape"),
    );
    expect(graphHeader("update.color", "Update Color", "Update", "update")).toBe(
      basicParticleStageRole("overLife"),
    );
  });

  it("ignores a Particle Graph role that is not a stage", () => {
    expect(nodeVisualRole({ category: "math", pure: true, particleRole: "toString" })).toBe("pure");
    expect(nodeVisualRole({ category: "physics", particleRole: "constructor" })).toBe("function");
  });
});
