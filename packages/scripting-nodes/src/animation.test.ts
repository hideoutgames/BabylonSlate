import { describe, expect, it } from "vitest";
import {
  compileGraph,
  compileTransitionRuleGraph,
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
});
