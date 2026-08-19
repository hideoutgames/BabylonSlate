import { describe, expect, it } from "vitest";
import {
  assertEveryConcreteTypeHasConverter,
  compileGraph,
  pin,
  EXEC,
  FLOAT,
  INT,
  STRING,
  type LogicGraph,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry, mathNodes, flowNodes } from "./index";

async function loadModule(source: string): Promise<Record<string, unknown>> {
  const body = source.replace(/export\s+function\s+/g, "function ");
  const fn = new Function(`${body}\nreturn { run };`);
  return fn() as Record<string, unknown>;
}

describe("node catalog", () => {
  it("registers all categories without id collisions", () => {
    const registry = createDefaultNodeRegistry();
    expect(registry.list().length).toBeGreaterThan(40);
    expect(registry.get("math.add")).toBeDefined();
    expect(registry.get("debug.log")).toBeDefined();
    expect(registry.get("debug.executeJavaScript")).toBeDefined();
    expect(registry.get("debug.print")).toBeDefined();
    expect(registry.get("debug.printString")?.title).toBe("Print String");
    expect(registry.get("render.setResolution")).toBeDefined();
    expect(registry.get("camera.possess")).toBeDefined();
    expect(registry.get("light.setIntensity")).toBeDefined();
    expect(registry.get("bt.event.activate")).toBeDefined();
    expect(registry.get("bt.finish")).toBeDefined();
    expect(registry.get("bt.returnCondition")).toBeDefined();
    expect(registry.get("bt.blackboard.get")).toBeDefined();
    expect(registry.get("bt.blackboard.set")).toBeDefined();
    expect(registry.get("anim.event.initialize")).toBeDefined();
    expect(registry.get("anim.actor.jumpToState")).toBeDefined();
    expect(registry.get("anim.rule.exitState")).toBeDefined();
    expect(registry.get("anim.state.justFinished")).toBeDefined();
    expect(registry.get("navigation.findPathTo")).toBeDefined();
    expect(registry.get("navigation.moveTo")).toBeDefined();
  });

  it("has a WildcardTo* converter for every concrete target", () => {
    const registry = createDefaultNodeRegistry();
    const ids = new Set(registry.list().map((d) => d.id));
    expect(assertEveryConcreteTypeHasConverter(ids)).toEqual([]);
  });

  it("math category exposes expected nodes", () => {
    expect(mathNodes.map((n) => n.id)).toContain("math.add");
    expect(flowNodes.map((n) => n.id)).toContain("flow.branch");
  });
});

describe("compiler goldens", () => {
  it("compiles entry → log deterministically", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "entry",
          typeId: "flow.entry",
          position: { x: 0, y: 0 },
          pins: [pin("execOut", "then", "out", EXEC)],
          properties: {},
        },
        {
          id: "log",
          typeId: "debug.log",
          position: { x: 200, y: 0 },
          pins: registry.get("debug.log")!.pins({}),
          properties: { message: "hello", severity: "log", category: "Test" },
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "entry",
          sourcePinId: "execOut",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
      ],
    };
    const result = compileGraph(graph, { assetGuid: "guid-1", registry });
    expect(result.source).toContain("sourceURL=babylonslate:///guid-1.js");
    expect(result.source).toContain("ctx.log");
    expect(result.anchors.some((a) => a.nodeId === "log")).toBe(true);
    // Determinism
    const again = compileGraph(graph, { assetGuid: "guid-1", registry });
    expect(again.source).toBe(result.source);
  });

  it("ExecuteJavaScript round-trips values through the graph", async () => {
    const registry = createDefaultNodeRegistry();
    const jsPins = registry.get("debug.executeJavaScript")!.pins({
      inputs: [{ name: "damage", type: FLOAT }],
      outputs: [{ name: "newHealth", type: FLOAT }],
    });
    const graph: LogicGraph = {
      id: "g",
      kind: "function",
      nodes: [
        {
          id: "entry",
          typeId: "flow.entry",
          position: { x: 0, y: 0 },
          pins: [pin("execOut", "then", "out", EXEC)],
          properties: {},
        },
        {
          id: "js",
          typeId: "debug.executeJavaScript",
          position: { x: 120, y: 0 },
          pins: jsPins,
          properties: {
            inputs: [{ name: "damage", type: FLOAT }],
            outputs: [{ name: "newHealth", type: FLOAT }],
            body: "newHealth = 100 - damage;",
            damage: 10,
          },
        },
        {
          id: "log",
          typeId: "debug.log",
          position: { x: 360, y: 0 },
          pins: registry.get("debug.log")!.pins({}),
          properties: { severity: "log", category: "Test" },
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "entry",
          sourcePinId: "execOut",
          targetNodeId: "js",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "js",
          sourcePinId: "execOut",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
        {
          id: "e3",
          sourceNodeId: "js",
          sourcePinId: "out_newHealth",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };

    const compiled = compileGraph(graph, { assetGuid: "js-asset", registry });
    expect(compiled.source).toContain("function execJs_js");
    const mod = await loadModule(compiled.source);
    const logs: unknown[] = [];
    (mod.run as (ctx: unknown) => void)?.({
      formatValue: (v: unknown) => String(v),
      log: (_s: string, _c: string, message: string) => {
        logs.push(message);
      },
    });
    expect(logs).toEqual(["90"]);
  });

  it("compiles math add as a pure expression", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "entry",
          typeId: "flow.entry",
          position: { x: 0, y: 0 },
          pins: [pin("execOut", "then", "out", EXEC)],
          properties: {},
        },
        {
          id: "add",
          typeId: "math.add",
          position: { x: 0, y: 80 },
          pins: registry.get("math.add")!.pins({}),
          properties: { a: 2, b: 3 },
        },
        {
          id: "log",
          typeId: "debug.log",
          position: { x: 200, y: 0 },
          pins: registry.get("debug.log")!.pins({}),
          properties: { severity: "log", category: "Test" },
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "entry",
          sourcePinId: "execOut",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "add",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const result = compileGraph(graph, { assetGuid: "m", registry });
    expect(result.source).toMatch(/2.*\+.*3|3.*\+.*2/);
    void INT;
    void STRING;
  });
});
