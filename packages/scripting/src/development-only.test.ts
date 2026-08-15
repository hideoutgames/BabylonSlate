import { describe, expect, it } from "vitest";
import { compileGraph } from "./compile";
import { isDevelopmentOnlyNode } from "./development-only";
import type { GraphNode, LogicGraph } from "./ir";
import { NodeRegistry, pin } from "./node-registry";
import { EXEC, FLOAT, STRING } from "./types";

function registryWithDebugNodes(): NodeRegistry {
  const registry = new NodeRegistry();
  registry.register({
    id: "flow.entry",
    title: "Entry",
    category: "flow",
    pins: () => [pin("execOut", "then", "out", EXEC)],
    codegen: () => {},
  });
  registry.register({
    id: "debug.print",
    title: "Print",
    category: "debug",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("value", "value", "in", STRING, "data", true),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.print(${ctx.input("value")});`);
    },
  });
  registry.register({
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
  registry.register({
    id: "debug.executeJavaScript",
    title: "Execute JavaScript",
    category: "debug",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("in_value", "value", "in", FLOAT),
      pin("out_result", "result", "out", FLOAT),
    ],
    codegen: (ctx) => {
      ctx.hoist("function execJs_js(value) {\n  let result = 0;\n  result = value;\n  return { result };\n}");
      ctx.emit(`({ result: ${ctx.output("result")} } = execJs_js(${ctx.input("value")}));`);
    },
  });
  return registry;
}

function node(
  typeId: string,
  id: string,
  properties: Record<string, unknown> = {},
  pins: GraphNode["pins"] = [],
): GraphNode {
  return { id, typeId, position: { x: 0, y: 0 }, pins, properties };
}

function chainGraph(options: {
  printProperties?: Record<string, unknown>;
  logProperties?: Record<string, unknown>;
}): LogicGraph {
  const registry = registryWithDebugNodes();
  const printDef = registry.get("debug.print")!;
  const logDef = registry.get("debug.log")!;
  const entryDef = registry.get("flow.entry")!;
  const printProps = { value: "debug", ...options.printProperties };
  const logProps = { message: "kept", ...options.logProperties };
  return {
    id: "g",
    kind: "event",
    nodes: [
      node("flow.entry", "entry", {}, entryDef.pins({})),
      node("debug.print", "print", printProps, printDef.pins(printProps)),
      node("debug.log", "log", logProps, logDef.pins(logProps)),
    ],
    edges: [
      {
        id: "e1",
        sourceNodeId: "entry",
        sourcePinId: "execOut",
        targetNodeId: "print",
        targetPinId: "execIn",
      },
      {
        id: "e2",
        sourceNodeId: "print",
        sourcePinId: "execOut",
        targetNodeId: "log",
        targetPinId: "execIn",
      },
    ],
  };
}

describe("isDevelopmentOnlyNode", () => {
  it("treats Print as development-only unless opted out", () => {
    expect(
      isDevelopmentOnlyNode(node("debug.print", "p")),
    ).toBe(true);
    expect(
      isDevelopmentOnlyNode(
        node("debug.print", "p", { developmentOnly: false }),
      ),
    ).toBe(false);
  });

  it("treats other nodes as development-only only when flagged", () => {
    expect(isDevelopmentOnlyNode(node("debug.log", "l"))).toBe(false);
    expect(
      isDevelopmentOnlyNode(
        node("debug.log", "l", { developmentOnly: true }),
      ),
    ).toBe(true);
  });
});

describe("compileGraph stripDevelopmentOnly", () => {
  it("omits Print and keeps the following Log when stripping for export", () => {
    const registry = registryWithDebugNodes();
    const graph = chainGraph({});
    const preview = compileGraph(graph, { assetGuid: "a", registry });
    expect(preview.source).toContain("ctx.print");
    expect(preview.source).toContain("ctx.log");

    const exported = compileGraph(graph, {
      assetGuid: "a",
      registry,
      stripDevelopmentOnly: true,
    });
    expect(exported.source).not.toContain("ctx.print");
    expect(exported.source).toContain("ctx.log");
  });

  it("keeps a Print that opted out of Development Only", () => {
    const registry = registryWithDebugNodes();
    const graph = chainGraph({ printProperties: { developmentOnly: false } });
    const exported = compileGraph(graph, {
      assetGuid: "a",
      registry,
      stripDevelopmentOnly: true,
    });
    expect(exported.source).toContain("ctx.print");
  });

  it("skips a flagged Log and does not hoist a flagged ExecuteJavaScript body", () => {
    const registry = registryWithDebugNodes();
    const jsDef = registry.get("debug.executeJavaScript")!;
    const entryDef = registry.get("flow.entry")!;
    const logDef = registry.get("debug.log")!;
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node("flow.entry", "entry", {}, entryDef.pins({})),
        node(
          "debug.executeJavaScript",
          "js",
          { developmentOnly: true, value: 1 },
          jsDef.pins({}),
        ),
        node(
          "debug.log",
          "log",
          { developmentOnly: true, message: "gone" },
          logDef.pins({}),
        ),
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
      ],
    };
    const exported = compileGraph(graph, {
      assetGuid: "a",
      registry,
      stripDevelopmentOnly: true,
    });
    expect(exported.source).not.toContain("execJs_js");
    expect(exported.source).not.toContain("ctx.log");
  });
});
