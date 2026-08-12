import { describe, expect, it } from "vitest";
import { compileGraph } from "./compile";
import { NodeRegistry, pin } from "./node-registry";
import type { LogicGraph } from "./ir";
import { BOOL, EXEC, FLOAT, STRING } from "./types";

function testRegistry(): NodeRegistry {
  const registry = new NodeRegistry();
  registry.registerAll([
    {
      id: "flow.entry",
      title: "Entry",
      category: "flow",
      pins: () => [pin("execOut", "then", "out", EXEC)],
      codegen: () => {
        /* entry marker */
      },
    },
    {
      id: "flow.branch",
      title: "Branch",
      category: "flow",
      pins: () => [
        pin("execIn", "exec", "in", EXEC),
        pin("condition", "condition", "in", BOOL),
        pin("true", "true", "out", EXEC),
        pin("false", "false", "out", EXEC),
      ],
      codegen: () => {
        /* compiler special-case */
      },
    },
    {
      id: "flow.sequence",
      title: "Sequence",
      category: "flow",
      pins: (properties) => {
        const count = Math.max(1, Number(properties.count ?? 2));
        const pins = [pin("execIn", "exec", "in", EXEC)];
        for (let i = 0; i < count; i++) {
          pins.push(pin(`then${i}`, `then_${i}`, "out", EXEC));
        }
        return pins;
      },
      codegen: () => {
        /* compiler special-case */
      },
    },
    {
      id: "debug.log",
      title: "Log",
      category: "debug",
      pins: () => [
        pin("execIn", "exec", "in", EXEC),
        pin("execOut", "then", "out", EXEC),
        pin("message", "message", "in", STRING, "data", true),
      ],
      codegen: (ctx) => {
        ctx.emit(`ctx.log("log", "Script", ${ctx.input("message")});`);
      },
    },
    {
      id: "math.add",
      title: "Add",
      category: "math",
      pure: true,
      pins: () => [
        pin("a", "a", "in", FLOAT),
        pin("b", "b", "in", FLOAT),
        pin("out", "out", "out", FLOAT),
      ],
      codegen: (ctx) => ({
        out: `(${ctx.input("a")} + ${ctx.input("b")})`,
      }),
    },
  ]);
  return registry;
}

describe("compileGraph", () => {
  const registry = testRegistry();

  it("compiles entry → log with property default and source anchors", () => {
    const graph: LogicGraph = {
      id: "main",
      kind: "event",
      nodes: [
        {
          id: "entry",
          typeId: "flow.entry",
          position: { x: 0, y: 0 },
          pins: registry.get("flow.entry")!.pins({}),
          properties: {},
        },
        {
          id: "log",
          typeId: "debug.log",
          position: { x: 200, y: 0 },
          pins: registry.get("debug.log")!.pins({}),
          properties: { message: "hello" },
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

    const result = compileGraph(graph, {
      assetGuid: "asset-1",
      registry,
    });

    expect(result.exportName).toBe("run");
    expect(result.source).toContain("//# sourceURL=babylonslate:///asset-1.js");
    expect(result.source).toContain('export function run(ctx)');
    expect(result.source).toContain('ctx.log("log", "Script", "hello")');
    expect(result.anchors.length).toBeGreaterThan(0);
    expect(result.anchors.every((a) => a.assetGuid === "asset-1")).toBe(true);
    expect(result.anchors.some((a) => a.nodeId === "log")).toBe(true);
    expect(result.anchors.every((a) => a.line >= 1 && a.column >= 1)).toBe(
      true,
    );
  });

  it("emits branch true/false exec chains from condition input", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "entry",
          typeId: "flow.entry",
          position: { x: 0, y: 0 },
          pins: registry.get("flow.entry")!.pins({}),
          properties: {},
        },
        {
          id: "br",
          typeId: "flow.branch",
          position: { x: 100, y: 0 },
          pins: registry.get("flow.branch")!.pins({}),
          properties: { condition: true },
        },
        {
          id: "t",
          typeId: "debug.log",
          position: { x: 200, y: -40 },
          pins: registry.get("debug.log")!.pins({}),
          properties: { message: "yes" },
        },
        {
          id: "f",
          typeId: "debug.log",
          position: { x: 200, y: 40 },
          pins: registry.get("debug.log")!.pins({}),
          properties: { message: "no" },
        },
      ],
      edges: [
        {
          id: "e0",
          sourceNodeId: "entry",
          sourcePinId: "execOut",
          targetNodeId: "br",
          targetPinId: "execIn",
        },
        {
          id: "e1",
          sourceNodeId: "br",
          sourcePinId: "true",
          targetNodeId: "t",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "br",
          sourcePinId: "false",
          targetNodeId: "f",
          targetPinId: "execIn",
        },
      ],
    };

    const { source } = compileGraph(graph, { assetGuid: "a", registry });
    expect(source).toMatch(/if \(true\) \{/);
    expect(source).toContain('ctx.log("log", "Script", "yes")');
    expect(source).toContain("} else {");
    expect(source).toContain('ctx.log("log", "Script", "no")');
  });

  it("runs sequence then pins in declaration order", () => {
    const seqPins = registry.get("flow.sequence")!.pins({ count: 2 });
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "entry",
          typeId: "flow.entry",
          position: { x: 0, y: 0 },
          pins: registry.get("flow.entry")!.pins({}),
          properties: {},
        },
        {
          id: "seq",
          typeId: "flow.sequence",
          position: { x: 100, y: 0 },
          pins: seqPins,
          properties: { count: 2 },
        },
        {
          id: "a",
          typeId: "debug.log",
          position: { x: 200, y: -20 },
          pins: registry.get("debug.log")!.pins({}),
          properties: { message: "first" },
        },
        {
          id: "b",
          typeId: "debug.log",
          position: { x: 200, y: 20 },
          pins: registry.get("debug.log")!.pins({}),
          properties: { message: "second" },
        },
      ],
      edges: [
        {
          id: "e0",
          sourceNodeId: "entry",
          sourcePinId: "execOut",
          targetNodeId: "seq",
          targetPinId: "execIn",
        },
        {
          id: "e1",
          sourceNodeId: "seq",
          sourcePinId: "then0",
          targetNodeId: "a",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "seq",
          sourcePinId: "then1",
          targetNodeId: "b",
          targetPinId: "execIn",
        },
      ],
    };

    const { source } = compileGraph(graph, { assetGuid: "a", registry });
    const first = source.indexOf('ctx.log("log", "Script", "first")');
    const second = source.indexOf('ctx.log("log", "Script", "second")');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
  });

  it("inlines pure math expressions into downstream inputs", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "entry",
          typeId: "flow.entry",
          position: { x: 0, y: 0 },
          pins: registry.get("flow.entry")!.pins({}),
          properties: {},
        },
        {
          id: "add",
          typeId: "math.add",
          position: { x: 80, y: 40 },
          pins: registry.get("math.add")!.pins({}),
          properties: { a: 2, b: 3 },
        },
        {
          id: "log",
          typeId: "debug.log",
          position: { x: 220, y: 0 },
          pins: registry.get("debug.log")!.pins({}),
          properties: {},
        },
      ],
      edges: [
        {
          id: "e0",
          sourceNodeId: "entry",
          sourcePinId: "execOut",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
        {
          id: "e1",
          sourceNodeId: "add",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };

    const { source } = compileGraph(graph, { assetGuid: "a", registry });
    expect(source).toContain('ctx.log("log", "Script", ((2 + 3)))');
  });

  it("comments missing node types instead of throwing", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "entry",
          typeId: "flow.entry",
          position: { x: 0, y: 0 },
          pins: registry.get("flow.entry")!.pins({}),
          properties: {},
        },
        {
          id: "ghost",
          typeId: "missing.unknown",
          position: { x: 100, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
          ],
          properties: {},
        },
      ],
      edges: [
        {
          id: "e0",
          sourceNodeId: "entry",
          sourcePinId: "execOut",
          targetNodeId: "ghost",
          targetPinId: "execIn",
        },
      ],
    };

    const { source } = compileGraph(graph, { assetGuid: "a", registry });
    expect(source).toContain("// missing node type missing.unknown");
  });

  it("emits empty-graph marker when there is no entry", () => {
    const graph: LogicGraph = {
      id: "empty",
      kind: "function",
      nodes: [],
      edges: [],
    };
    const { source, exportName } = compileGraph(graph, {
      assetGuid: "a",
      registry,
      exportName: "tick",
    });
    expect(exportName).toBe("tick");
    expect(source).toContain("export function tick(ctx)");
    expect(source).toContain("// empty graph");
  });
});
