import { describe, expect, it } from "vitest";
import { compileGraph } from "./compile";
import type { LogicGraph } from "./ir";
import { NodeRegistry, pin, type NodeDefinition } from "./node-registry";
import { EXEC, INT, BOOL } from "./types";

function registryWith(
  id: string,
  title: string,
  pins: ReturnType<typeof pin>[],
  structuredFlow: NonNullable<NodeDefinition["structuredFlow"]>,
): NodeRegistry {
  const nodes = new NodeRegistry();
  nodes.register({
    id: "flow.entry",
    title: "Entry",
    category: "flow",
    pins: () => [pin("execOut", "then", "out", EXEC)],
    codegen: () => {},
  });
  nodes.register({
    id: "debug.log",
    title: "Log",
    category: "debug",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("message", "message", "in", INT, "data", true),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.log("log", "T", String(${ctx.input("message")}));`);
    },
  });
  nodes.register({
    id,
    title,
    category: "flow",
    pins: () => pins,
    codegen: () => {},
    structuredFlow,
  });
  return nodes;
}

describe("compile structured flow metadata", () => {
  it("emits a for-loop from structuredFlow forLoop without hard-coding only type ids in the loop path", () => {
    const registry = registryWith(
      "flow.forLoop",
      "For Loop",
      [
        pin("execIn", "exec", "in", EXEC),
        pin("firstIndex", "firstIndex", "in", INT),
        pin("lastIndex", "lastIndex", "in", INT),
        pin("loopBody", "loopBody", "out", EXEC),
        pin("index", "index", "out", INT),
        pin("completed", "completed", "out", EXEC),
      ],
      {
        kind: "forLoop",
        firstIndexPin: "firstIndex",
        lastIndexPin: "lastIndex",
        loopBodyPin: "loopBody",
        completedPin: "completed",
        indexPin: "index",
      },
    );
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
          id: "loop",
          typeId: "flow.forLoop",
          position: { x: 40, y: 0 },
          pins: registry.get("flow.forLoop")!.pins({}),
          properties: { firstIndex: 1, lastIndex: 2 },
        },
        {
          id: "log",
          typeId: "debug.log",
          position: { x: 80, y: 0 },
          pins: registry.get("debug.log")!.pins({}),
          properties: {},
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "entry",
          sourcePinId: "execOut",
          targetNodeId: "loop",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "loop",
          sourcePinId: "loopBody",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
        {
          id: "e3",
          sourceNodeId: "loop",
          sourcePinId: "index",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toMatch(/for\s*\(/);
    expect(compiled.source).toContain("_n_loop_index");
  });

  it("still emits classic if/else for Branch by typeId", () => {
    const nodes = new NodeRegistry();
    nodes.register({
      id: "flow.entry",
      title: "Entry",
      category: "flow",
      pins: () => [pin("execOut", "then", "out", EXEC)],
      codegen: () => {},
    });
    nodes.register({
      id: "flow.branch",
      title: "Branch",
      category: "flow",
      pins: () => [
        pin("execIn", "exec", "in", EXEC),
        pin("condition", "condition", "in", BOOL),
        pin("true", "true", "out", EXEC),
        pin("false", "false", "out", EXEC),
      ],
      codegen: () => {},
    });
    nodes.register({
      id: "debug.log",
      title: "Log",
      category: "debug",
      pins: () => [
        pin("execIn", "exec", "in", EXEC),
        pin("execOut", "then", "out", EXEC),
      ],
      codegen: (ctx) => {
        ctx.emit(`ctx.log("log", "T", "x");`);
      },
    });
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
          id: "branch",
          typeId: "flow.branch",
          position: { x: 40, y: 0 },
          pins: nodes.get("flow.branch")!.pins({}),
          properties: { condition: true },
        },
        {
          id: "log",
          typeId: "debug.log",
          position: { x: 80, y: 0 },
          pins: nodes.get("debug.log")!.pins({}),
          properties: {},
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "entry",
          sourcePinId: "execOut",
          targetNodeId: "branch",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "branch",
          sourcePinId: "true",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
      ],
    };
    const src = compileGraph(graph, { assetGuid: "a", registry: nodes }).source;
    expect(src).toMatch(/if\s*\(/);
    expect(src).toMatch(/\}\s*else\s*\{/);
  });
});
