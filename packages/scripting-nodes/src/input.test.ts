import { describe, expect, it } from "vitest";
import {
  compileGraph,
  pin,
  EXEC,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry, inputNodes } from "./index";

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

function edge(
  id: string,
  sourceNodeId: string,
  sourcePinId: string,
  targetNodeId: string,
  targetPinId: string,
) {
  return { id, sourceNodeId, sourcePinId, targetNodeId, targetPinId };
}

function loadModule(source: string): Record<string, unknown> {
  const body = source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  return new Function(`${body}\nreturn { onTick };`)() as Record<string, unknown>;
}

describe("input nodes", () => {
  it("registers GetAxis, GetAxis2D, IsActionHeld, and OnAction", () => {
    expect(inputNodes.map((n) => n.id)).toEqual(
      expect.arrayContaining([
        "input.getAxis",
        "input.getAxis2D",
        "input.isActionHeld",
        "input.onAction",
      ]),
    );
  });

  it("compiled GetAxis2D reads ctx.getAxis2D on Tick", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "tick", "flow.event.tick"),
        node(registry, "axis", "input.getAxis2D", { axis: "Move" }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        edge("e1", "tick", "execOut", "log", "execIn"),
        edge("e2", "axis", "out", "log", "message"),
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("ctx.getAxis2D");
    const mod = loadModule(compiled.source);
    const logs: string[] = [];
    (mod.onTick as (ctx: unknown) => void)({
      formatValue: (v: unknown) => String((v as { x: number }).x),
      log: (_s: string, _c: string, message: string) => logs.push(message),
      getAxis2D: (axis: string) => {
        expect(axis).toBe("Move");
        return { x: 0.75, y: 0 };
      },
    });
    expect(logs).toEqual(["0.75"]);
  });

  it("compiled IsActionHeld reads ctx.isActionHeld", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "tick", "flow.event.tick"),
        node(registry, "held", "input.isActionHeld", { action: "Jump" }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        edge("e1", "tick", "execOut", "log", "execIn"),
        edge("e2", "held", "out", "log", "message"),
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    const mod = loadModule(compiled.source);
    const logs: string[] = [];
    (mod.onTick as (ctx: unknown) => void)({
      formatValue: (v: unknown) => String(v),
      log: (_s: string, _c: string, message: string) => logs.push(message),
      isActionHeld: (action: string) => action === "Jump",
    });
    expect(logs).toEqual(["true"]);
    void pin;
    void EXEC;
  });

  it("compiles Set Input Mode to ctx.setInputMode", () => {
    expect(inputNodes.map((n) => n.id)).toContain("input.setInputMode");
    const setMode = inputNodes.find((n) => n.id === "input.setInputMode");
    expect(setMode?.title).toBe("Set Input Mode");
    expect(setMode?.category).toBe("input");
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "mode", "input.setInputMode", { mode: "Game" }),
      ],
      edges: [edge("e1", "begin", "execOut", "mode", "execIn")],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain('ctx.setInputMode("Game")');
    const modePin = setMode?.pins({}).find((pin) => pin.id === "mode");
    expect(modePin?.type).toEqual({ kind: "enumRef", guid: "engine:InputMode" });
  });
});
