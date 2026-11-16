import { describe, expect, it } from "vitest";
import { basicParticleStageRole } from "@haptic/ui/lib/data-types";
import {
  nodeKind,
  nodeVisualRole,
  pinCssVar,
  type NodeKind,
  type NodeKindInput,
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
  });

  it("colours Call Custom Event as a function call, not an event", () => {
    expect(
      nodeVisualRole({
        nodeType: "flow.event.call",
        title: "Call On Hit",
        category: "flow",
      }),
    ).toBe("function");
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
    // Set nodes share the Get colour.
    expect(
      nodeVisualRole({ category: "variables", nodeType: "variables.set", title: "Set Health" }),
    ).toBe("variable");
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

  it("colours Behaviour Tree and state machine Add Node rows like their canvas nodes", () => {
    expect(nodeVisualRole({ nodeType: "bt.node", btKind: "task" })).toBe("bt-task");
    expect(nodeVisualRole({ nodeType: "bt.node", btKind: "selector" })).toBe("bt-composite");
    expect(nodeVisualRole({ nodeType: "anim.state", category: "Animation" })).toBe("anim-pose");
    expect(nodeVisualRole({ nodeType: "anim.alias", category: "Animation" })).toBe("anim-pose");
  });

  it("ignores a Particle Graph role that is not a stage", () => {
    expect(nodeVisualRole({ category: "math", pure: true, particleRole: "toString" })).toBe("pure");
    expect(nodeVisualRole({ category: "physics", particleRole: "constructor" })).toBe("function");
  });
});

describe("nodeKind", () => {
  const cases: Array<[string, NodeKindInput, NodeKind]> = [
    ["engine event", { nodeType: "flow.event.beginPlay", title: "Event Begin Play", category: "flow" }, "event"],
    ["custom event", { nodeType: "flow.event.custom", title: "Event On Hit", category: "flow", pure: true }, "event"],
    ["transition rule entry", { nodeType: "anim.rule.enterState", title: "Event Enter State" }, "event"],
    ["input action event", { nodeType: "input.actionEvent", category: "input" }, "input-event"],
    ["gamepad event", { nodeType: "input.onGamepadConnected", category: "input" }, "input-event"],
    ["touch event", { nodeType: "input.onTouchBegan", category: "input" }, "input-event"],
    ["function call", { nodeType: "functions.call", category: "functions" }, "function"],
    ["engine call", { nodeType: "actor.spawn", category: "actor" }, "function"],
    ["debug call", { nodeType: "debug.log", category: "debug" }, "function"],
    ["pure function call", { nodeType: "functions.call", category: "functions", pure: true }, "pure"],
    ["pure math", { nodeType: "math.add", category: "math", pure: true }, "pure"],
    ["latent call", { nodeType: "functions.call", category: "functions", latent: true }, "latent"],
    ["timer", { nodeType: "timers.delay", category: "timers" }, "latent"],
    ["interface call", { nodeType: "interface.call", category: "interface" }, "interface"],
    ["interface implementation entry", { nodeType: "flow.function.input", category: "flow", pure: true, interface: true }, "interface"],
    ["function entry", { nodeType: "flow.function.input", category: "flow", pure: true }, "function"],
    ["function return", { nodeType: "flow.function.output", category: "flow" }, "function"],
    ["dispatcher bind", { nodeType: "flow.dispatcher.bind", category: "eventDispatchers" }, "dispatcher"],
    ["dispatcher call", { nodeType: "flow.dispatcher.call", category: "eventDispatchers" }, "dispatcher"],
    ["create event", { nodeType: "flow.delegate.create", category: "eventDispatchers", pure: true }, "dispatcher"],
    ["call custom event", { nodeType: "flow.event.call", title: "Call Jump", category: "flow" }, "call-event"],
    ["call parent", { nodeType: "flow.event.callParent", title: "Call Begin Play Parent", category: "flow" }, "call-parent"],
    ["branch", { nodeType: "flow.branch", category: "flow" }, "flow"],
    ["for each loop", { nodeType: "flow.forEachWithBreak", category: "flow" }, "loop"],
    ["for loop", { nodeType: "flow.forLoop", category: "flow" }, "loop"],
    ["while loop", { nodeType: "flow.whileLoop", category: "flow" }, "loop"],
    ["variable get", { nodeType: "variables.get", category: "variables" }, "variable"],
    ["variable set", { nodeType: "variables.set", title: "Set Health", category: "variables" }, "variable"],
    ["material output", { nodeType: "output.surface", category: "output", material: true }, "material-output"],
    ["material constant", { nodeType: "const.float", category: "const", material: true }, "constant"],
    ["material parameter", { nodeType: "param.scalar", category: "param", material: true }, "parameter"],
    ["material global parameter", { nodeType: "global.parameter", category: "global", material: true }, "parameter"],
    ["material input", { nodeType: "input.uv", category: "input", material: true }, "input"],
    ["material texture", { nodeType: "texture.sample", category: "texture", material: true }, "texture"],
    ["material custom code", { nodeType: "custom.glsl", category: "custom", material: true }, "custom-code"],
    ["material function", { nodeType: "function.call", category: "function", material: true }, "function"],
    ["material operation", { nodeType: "math.multiply", category: "math", material: true }, "operation"],
    ["particle output", { nodeType: "particle.output", particleRole: "output" }, "emitter-output"],
    ["particle create", { nodeType: "particle.create", particleRole: "create" }, "create"],
    ["particle shape", { nodeType: "shape.sphere", particleRole: "shape" }, "shape"],
    ["particle update", { nodeType: "update.noise", particleRole: "update" }, "update"],
    ["particle parameter", { nodeType: "input.parameter", particleRole: "input" }, "parameter"],
    ["particle value", { nodeType: "math.add", particleRole: "value" }, "operation"],
    ["particle role that is not a stage", { nodeType: "math.add", category: "math", pure: true, particleRole: "toString" }, "pure"],
    ["sequence player", { nodeType: "anim.pose.sequencePlayer" }, "player"],
    ["sequence evaluator", { nodeType: "anim.pose.sequenceEvaluator" }, "player"],
    ["sprite blend space player", { nodeType: "anim.frame.spriteBlendSpacePlayer" }, "player"],
    ["blend by bool", { nodeType: "anim.pose.blendByBool" }, "blend"],
    ["select by int", { nodeType: "anim.frame.selectByInt" }, "select"],
    ["rest pose", { nodeType: "anim.pose.restPose" }, "rest-pose"],
    ["flip", { nodeType: "anim.frame.flip" }, "flip"],
    ["skeletal control", { nodeType: "anim.control.lookAt" }, "skeletal-control"],
    ["output pose", { nodeType: "anim.pose.output" }, "output-pose"],
    ["output frame", { nodeType: "anim.frame.output" }, "output-frame"],
    ["state", { nodeType: "anim.state" }, "state"],
    ["state alias", { nodeType: "anim.alias" }, "state-alias"],
    ["behaviour tree sequence", { nodeType: "bt.node", btKind: "sequence" }, "bt-sequence"],
    ["behaviour tree parallel", { nodeType: "bt.node", btKind: "parallel" }, "bt-parallel"],
    ["behaviour tree task", { nodeType: "bt.node", btKind: "task" }, "bt-task"],
  ];

  it.each(cases)("classifies a %s", (_name, input, expected) => {
    expect(nodeKind(input)).toBe(expected);
  });
});
