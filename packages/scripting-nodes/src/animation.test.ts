import { describe, expect, it } from "vitest";
import {
  compileGraph,
  compileTransitionRuleGraph,
  objectRef,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";
import { animationNodes } from "./animation";

function node(
  registry: NodeRegistry,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const def = registry.get(typeId);
  if (!def) throw new Error(`missing node ${typeId}`);
  return {
    id,
    typeId,
    position: { x: 0, y: 0 },
    pins: def.pins(properties),
    properties,
  };
}

function loadEvaluate(source: string): (ctx: Record<string, unknown>) => {
  enter: boolean;
  exit: boolean;
} {
  const body = source.replace(/export\s+function\s+/g, "function ");
  const fn = new Function(`${body}\nreturn { evaluate };`);
  return (fn() as { evaluate: (ctx: Record<string, unknown>) => {
    enter: boolean;
    exit: boolean;
  } }).evaluate;
}

describe("animation nodes", () => {
  it("registers lifecycle events, rule sinks, and state queries", () => {
    expect(animationNodes.map((entry) => entry.id)).toEqual([
      "anim.event.initialize",
      "anim.event.update",
      "anim.rule.enterState",
      "anim.rule.exitState",
      "anim.state.elapsedSeconds",
      "anim.state.durationSeconds",
      "anim.state.normalisedTime",
      "anim.state.remainingSeconds",
      "anim.state.remainingRatio",
      "anim.state.looping",
      "anim.state.loopCount",
      "anim.state.justLooped",
      "anim.state.justFinished",
      "anim.actor.getVariable",
      "anim.actor.setVariable",
      "anim.actor.getCurrentState",
      "anim.actor.jumpToState",
    ]);
  });

  it("keeps Enter State and Exit State as optional bool sinks", () => {
    const registry = createDefaultNodeRegistry();
    const enter = registry.get("anim.rule.enterState")!.pins({});
    const exit = registry.get("anim.rule.exitState")!.pins({});
    expect(enter).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "value",
          direction: "in",
          type: { kind: "bool" },
          optional: true,
        }),
      ]),
    );
    expect(exit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "value",
          direction: "in",
          type: { kind: "bool" },
          optional: true,
        }),
      ]),
    );
  });

  it("compiles disconnected Enter State and Exit State as true", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "rule",
      kind: "event",
      nodes: [
        node(registry, "enter-state", "anim.rule.enterState"),
        node(registry, "exit-state", "anim.rule.exitState"),
      ],
      edges: [],
    };
    const compiled = compileTransitionRuleGraph(graph, {
      assetGuid: "anim-1",
      registry,
    });
    const evaluate = loadEvaluate(compiled.source);
    expect(evaluate({})).toEqual({ enter: true, exit: true });
  });

  it("compiles a disabled Exit State as true even when wired", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "rule",
      kind: "event",
      nodes: [
        node(registry, "enter-state", "anim.rule.enterState"),
        node(registry, "exit-state", "anim.rule.exitState", {
          __disabled: true,
        }),
        node(registry, "get-moving", "variables.get", {
          variableName: "moving",
          typeId: "bool",
          implicitSelf: true,
        }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "get-moving",
          sourcePinId: "value",
          targetNodeId: "exit-state",
          targetPinId: "value",
        },
      ],
    };
    const compiled = compileTransitionRuleGraph(graph, {
      assetGuid: "anim-1",
      registry,
    });
    const evaluate = loadEvaluate(compiled.source);
    expect(
      evaluate({
        getVariable: () => false,
      }),
    ).toEqual({ enter: true, exit: true });
  });

  it("compiles a Get Variable wired to Exit State", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "rule",
      kind: "event",
      nodes: [
        node(registry, "enter-state", "anim.rule.enterState"),
        node(registry, "exit-state", "anim.rule.exitState"),
        node(registry, "get-moving", "variables.get", {
          variableName: "moving",
          typeId: "bool",
          implicitSelf: true,
        }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "get-moving",
          sourcePinId: "value",
          targetNodeId: "exit-state",
          targetPinId: "value",
        },
      ],
    };
    const compiled = compileTransitionRuleGraph(graph, {
      assetGuid: "anim-1",
      registry,
    });
    const evaluate = loadEvaluate(compiled.source);
    expect(
      evaluate({
        getVariable: (name: string) => name === "moving",
      }),
    ).toEqual({ enter: true, exit: true });
    expect(
      evaluate({
        getVariable: () => false,
      }),
    ).toEqual({ enter: true, exit: false });
  });

  it("reads animation state facts from ctx.animFacts", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "rule",
      kind: "event",
      nodes: [
        node(registry, "enter-state", "anim.rule.enterState"),
        node(registry, "exit-state", "anim.rule.exitState"),
        node(registry, "time", "anim.state.normalisedTime"),
        node(registry, "cmp", "math.greaterEqual", { b: 0.8 }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "time",
          sourcePinId: "value",
          targetNodeId: "cmp",
          targetPinId: "a",
        },
        {
          id: "e2",
          sourceNodeId: "cmp",
          sourcePinId: "out",
          targetNodeId: "exit-state",
          targetPinId: "value",
        },
      ],
    };
    const compiled = compileTransitionRuleGraph(graph, {
      assetGuid: "anim-1",
      registry,
    });
    const evaluate = loadEvaluate(compiled.source);
    expect(
      evaluate({ animFacts: { normalisedTime: 0.4 } }),
    ).toEqual({ enter: true, exit: false });
    expect(
      evaluate({ animFacts: { normalisedTime: 0.9 } }),
    ).toEqual({ enter: true, exit: true });
  });

  it("binds Animation Object lifecycle events", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "object",
      kind: "event",
      nodes: [
        node(registry, "init", "anim.event.initialize"),
        node(registry, "update", "anim.event.update"),
      ],
      edges: [],
    };
    const compiled = compileGraph(graph, {
      assetGuid: "anim-1",
      registry,
    });
    expect(compiled.entryPoints.map((entry) => entry.event)).toEqual([
      "onInitializeAnimation",
      "onUpdateAnimation",
    ]);
  });

  it("takes an AnimationGraphComponent target on Get and Set Anim Graph Variable", () => {
    const getPins = animationNodes.find(
      (entry) => entry.id === "anim.actor.getVariable",
    )!.pins({});
    const setPins = animationNodes.find(
      (entry) => entry.id === "anim.actor.setVariable",
    )!.pins({});
    const target = {
      id: "target",
      direction: "in" as const,
      type: objectRef("AnimationGraphComponent"),
    };
    expect(getPins).toEqual(expect.arrayContaining([expect.objectContaining(target)]));
    expect(setPins.map((pin) => pin.id)).toEqual([
      "execIn",
      "execOut",
      "target",
      "name",
      "value",
    ]);
    expect(setPins.find((pin) => pin.id === "target")).toEqual(
      expect.objectContaining(target),
    );
  });

  it("takes an AnimationGraphComponent target on Get Current State and Jump To State", () => {
    const getPins = animationNodes.find(
      (entry) => entry.id === "anim.actor.getCurrentState",
    )!.pins({});
    const jumpPins = animationNodes.find(
      (entry) => entry.id === "anim.actor.jumpToState",
    )!.pins({});
    const target = {
      id: "target",
      direction: "in" as const,
      type: objectRef("AnimationGraphComponent"),
    };
    expect(getPins.map((pin) => pin.id)).toEqual(["target", "name", "id"]);
    expect(getPins[0]).toEqual(expect.objectContaining(target));
    expect(jumpPins.map((pin) => pin.id)).toEqual([
      "execIn",
      "execOut",
      "target",
      "state",
    ]);
    expect(jumpPins.find((pin) => pin.id === "target")).toEqual(
      expect.objectContaining(target),
    );
  });

  it("compiles Actor Anim Graph control nodes against ctx helpers", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "hero",
      kind: "event",
      nodes: [
        node(registry, "tick", "flow.event.tick"),
        node(registry, "jump", "anim.actor.jumpToState", { state: "Run" }),
        node(registry, "get", "anim.actor.getCurrentState"),
        node(registry, "graph", "component.getNamed", {
          componentClassId: "AnimationGraphComponent",
          implicitSelf: true,
        }),
        node(registry, "read", "anim.actor.getVariable", { name: "moving" }),
        node(registry, "set", "anim.actor.setVariable", {
          name: "moving",
          value: true,
        }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "tick",
          sourcePinId: "execOut",
          targetNodeId: "set",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "set",
          sourcePinId: "execOut",
          targetNodeId: "jump",
          targetPinId: "execIn",
        },
        {
          id: "e3",
          sourceNodeId: "read",
          sourcePinId: "value",
          targetNodeId: "set",
          targetPinId: "value",
        },
        {
          id: "e4",
          sourceNodeId: "get",
          sourcePinId: "name",
          targetNodeId: "jump",
          targetPinId: "state",
        },
        {
          id: "e5",
          sourceNodeId: "graph",
          sourcePinId: "out",
          targetNodeId: "set",
          targetPinId: "target",
        },
        {
          id: "e6",
          sourceNodeId: "graph",
          sourcePinId: "out",
          targetNodeId: "read",
          targetPinId: "target",
        },
        {
          id: "e7",
          sourceNodeId: "graph",
          sourcePinId: "out",
          targetNodeId: "jump",
          targetPinId: "target",
        },
        {
          id: "e8",
          sourceNodeId: "graph",
          sourcePinId: "out",
          targetNodeId: "get",
          targetPinId: "target",
        },
      ],
    };
    const compiled = compileGraph(graph, {
      assetGuid: "hero-1",
      registry,
    });
    expect(compiled.source).toMatch(
      /ctx\.setAnimGraphVariable\([^,]+,\s*[^,]+,\s*[^)]+\)/,
    );
    expect(compiled.source).toMatch(/ctx\.getAnimGraphVariable\([^,]+,\s*[^)]+\)/);
    expect(compiled.source).toMatch(
      /ctx\.jumpAnimGraphState\([^,]+,\s*[^)]+\)/,
    );
    expect(compiled.source).toMatch(/ctx\.getAnimGraphCurrentState\([^)]+\)/);
  });
});
