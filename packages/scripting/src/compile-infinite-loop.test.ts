import { describe, expect, it } from "vitest";
import { compileGraph } from "./compile";
import type { LogicGraph } from "./ir";
import { NodeRegistry, pin } from "./node-registry";
import { EXEC, STRING } from "./types";

function registry(): NodeRegistry {
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
      pin("message", "message", "in", STRING, "data", true),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.log(${ctx.input("message")});`);
    },
  });
  nodes.register({
    id: "debug.js",
    title: "JS",
    category: "debug",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
    ],
    codegen: (ctx) => {
      ctx.hoist(`function execJs_n() {
  while (true) {
    x++;
  }
}`);
      ctx.emit(`execJs_n();`);
    },
  });
  return nodes;
}

function logGraph(): LogicGraph {
  return {
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
        position: { x: 80, y: 0 },
        pins: [
          pin("execIn", "exec", "in", EXEC),
          pin("execOut", "then", "out", EXEC),
          pin("message", "message", "in", STRING, "data", true),
        ],
        properties: { message: "hi" },
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
}

describe("compileGraph instrumentInfiniteLoops", () => {
  it("does not emit loop checks unless instrumentInfiniteLoops is set", () => {
    const compiled = compileGraph(logGraph(), {
      assetGuid: "a",
      registry: registry(),
    });
    expect(compiled.source).toContain("ctx.log");
    expect(compiled.source).not.toContain("checkInfiniteLoop");
  });

  it("emits ctx.checkInfiniteLoop before each impure exec statement", () => {
    const compiled = compileGraph(logGraph(), {
      assetGuid: "a",
      registry: registry(),
      instrumentInfiniteLoops: true,
    });
    expect(compiled.source).toContain("ctx.checkInfiniteLoop();");
    const checkAt = compiled.source.indexOf("ctx.checkInfiniteLoop();");
    const logAt = compiled.source.indexOf("ctx.log");
    expect(checkAt).toBeGreaterThanOrEqual(0);
    expect(logAt).toBeGreaterThan(checkAt);
  });

  it("rewrites hoisted ExecuteJavaScript loop bodies when instrumenting", () => {
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
          id: "js",
          typeId: "debug.js",
          position: { x: 80, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
          ],
          properties: {},
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
      ],
    };
    const plain = compileGraph(graph, { assetGuid: "a", registry: registry() });
    expect(plain.source).toContain("while (true)");
    expect(plain.source).not.toContain("checkInfiniteLoop");

    const instrumented = compileGraph(graph, {
      assetGuid: "a",
      registry: registry(),
      instrumentInfiniteLoops: true,
    });
    expect(instrumented.source).toContain("while (true)");
    expect(instrumented.source).toContain("ctx.checkInfiniteLoop();");
    const whileAt = instrumented.source.indexOf("while (true)");
    const innerCheck = instrumented.source.indexOf(
      "ctx.checkInfiniteLoop();",
      whileAt,
    );
    expect(innerCheck).toBeGreaterThan(whileAt);
  });
});
