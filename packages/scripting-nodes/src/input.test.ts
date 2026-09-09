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

  it("registers Get Cursor Position, Project Cursor To Scene, Show Cursor, and Hide Cursor", () => {
    expect(inputNodes.map((n) => n.id)).toEqual(
      expect.arrayContaining([
        "input.getCursorPosition",
        "input.projectCursorToScene",
        "input.showCursor",
        "input.hideCursor",
      ]),
    );
    const registry = createDefaultNodeRegistry();
    const get = registry.get("input.getCursorPosition")!;
    expect(get.title).toBe("Get Cursor Position");
    expect(get.pure).toBe(true);
    expect(get.pins({}).map((p) => p.id)).toEqual(
      expect.arrayContaining(["out", "pressed"]),
    );
    const project = registry.get("input.projectCursorToScene")!;
    expect(project.title).toBe("Project Cursor To Scene");
    expect(project.pins({}).find((p) => p.id === "drawDebug")?.defaultValue).toBe(
      true,
    );
    expect(project.pins({}).find((p) => p.id === "duration")?.defaultValue).toBe(
      0,
    );
    expect(registry.get("input.showCursor")!.title).toBe("Show Cursor");
    expect(registry.get("input.hideCursor")!.title).toBe("Hide Cursor");
  });

  it("compiled Get Cursor Position reads ctx.getCursorPosition on Tick", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "tick", "flow.event.tick"),
        node(registry, "cursor", "input.getCursorPosition"),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        edge("e1", "tick", "execOut", "log", "execIn"),
        edge("e2", "cursor", "out", "log", "message"),
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("ctx.getCursorPosition");
    const mod = loadModule(compiled.source);
    const logs: string[] = [];
    (mod.onTick as (ctx: unknown) => void)({
      formatValue: (v: unknown) => String((v as { x: number }).x),
      log: (_s: string, _c: string, message: string) => logs.push(message),
      getCursorPosition: () => ({ x: 42, y: 9, pressed: true }),
    });
    expect(logs).toEqual(["42"]);
  });
});


describe("asset input event compilation", () => {
  it("dispatches independent phase chains and typed values without polling strings", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = { id: "input-events", kind: "event", nodes: [
      node(registry, "input", "input.event", { "default:input": { Name: "Jump", Asset: "jump" }, valueType: "button" }),
      ...["started", "held", "released"].map((phase) => node(registry, phase, "debug.log", { message: phase })),
    ], edges: ["started", "held", "released"].map((phase) => edge(phase, "input", phase, phase, "execIn")) };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    const mod = loadModule(compiled.source);
    const logs: string[] = [];
    let snapshot = { started: true, held: true, released: false, value: true, heldSeconds: 0, lastHeldSeconds: 0 };
    const ctx = { getInputState: (input: { Asset: string }) => { expect(input.Asset).toBe("jump"); return snapshot; }, formatValue: String, log: (_s: string, _c: string, message: string) => logs.push(message) };
    (mod.onTick as (ctx: unknown) => void)(ctx);
    expect(logs).toEqual(["started", "held"]);
    logs.length = 0;
    snapshot = { ...snapshot, held: false, released: true, value: false };
    (mod.onTick as (ctx: unknown) => void)(ctx);
    expect(logs).toEqual(["started", "released"]);
    logs.length = 0;
    snapshot = { ...snapshot, held: true, value: true };
    (mod.onTick as (ctx: unknown) => void)(ctx);
    expect(logs).toEqual(["released", "started", "held"]);
  });
});
