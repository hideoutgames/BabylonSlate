import { describe, expect, it } from "vitest";
import { compileGraph } from "./compile";
import { isDevelopmentOnlyNode } from "./development-only";
import type { GraphNode, LogicGraph } from "./ir";
import { NodeRegistry, pin } from "./node-registry";
import { BOOL, EXEC, FLOAT, STRING } from "./types";

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
    codegen: () => {},
  });
  registry.register({
    id: "flow.branch",
    title: "Branch",
    category: "flow",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("condition", "condition", "in", BOOL, "data", true),
      pin("true", "true", "out", EXEC),
      pin("false", "false", "out", EXEC),
    ],
    codegen: () => {},
  });
  registry.register({
    id: "debug.use",
    title: "Use",
    category: "debug",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("value", "value", "in", FLOAT),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.use(${ctx.input("value")});`);
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

  it("skips a flagged Sequence as a no-op and still runs then_0 then then_1", () => {
    const registry = registryWithDebugNodes();
    const sequenceDef = registry.get("flow.sequence")!;
    const entryDef = registry.get("flow.entry")!;
    const logDef = registry.get("debug.log")!;
    const seqProps = { developmentOnly: true, count: 2 };
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node("flow.entry", "entry", {}, entryDef.pins({})),
        node("flow.sequence", "seq", seqProps, sequenceDef.pins(seqProps)),
        node(
          "debug.log",
          "logA",
          { message: "a" },
          logDef.pins({ message: "a" }),
        ),
        node(
          "debug.log",
          "logB",
          { message: "b" },
          logDef.pins({ message: "b" }),
        ),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "entry",
          sourcePinId: "execOut",
          targetNodeId: "seq",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "seq",
          sourcePinId: "then0",
          targetNodeId: "logA",
          targetPinId: "execIn",
        },
        {
          id: "e3",
          sourceNodeId: "seq",
          sourcePinId: "then1",
          targetNodeId: "logB",
          targetPinId: "execIn",
        },
      ],
    };
    const exported = compileGraph(graph, {
      assetGuid: "a",
      registry,
      stripDevelopmentOnly: true,
    });
    const logA = exported.source.indexOf('ctx.log("a")');
    const logB = exported.source.indexOf('ctx.log("b")');
    expect(logA).toBeGreaterThan(-1);
    expect(logB).toBeGreaterThan(-1);
    expect(logA).toBeLessThan(logB);
  });

  it("does not enter exclusive Branch arms when the Branch is stripped", () => {
    const registry = registryWithDebugNodes();
    const branchDef = registry.get("flow.branch")!;
    const entryDef = registry.get("flow.entry")!;
    const logDef = registry.get("debug.log")!;
    const branchProps = { developmentOnly: true, condition: true };
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node("flow.entry", "entry", {}, entryDef.pins({})),
        node("flow.branch", "branch", branchProps, branchDef.pins(branchProps)),
        node(
          "debug.log",
          "logTrue",
          { message: "true" },
          logDef.pins({ message: "true" }),
        ),
        node(
          "debug.log",
          "logFalse",
          { message: "false" },
          logDef.pins({ message: "false" }),
        ),
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
          targetNodeId: "logTrue",
          targetPinId: "execIn",
        },
        {
          id: "e3",
          sourceNodeId: "branch",
          sourcePinId: "false",
          targetNodeId: "logFalse",
          targetPinId: "execIn",
        },
      ],
    };
    const exported = compileGraph(graph, {
      assetGuid: "a",
      registry,
      stripDevelopmentOnly: true,
    });
    expect(exported.source).not.toContain("ctx.log");
  });

  it("walks consecutive stripped Prints and still reaches Log", () => {
    const registry = registryWithDebugNodes();
    const printDef = registry.get("debug.print")!;
    const logDef = registry.get("debug.log")!;
    const entryDef = registry.get("flow.entry")!;
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node("flow.entry", "entry", {}, entryDef.pins({})),
        node("debug.print", "print1", { value: "one" }, printDef.pins({})),
        node("debug.print", "print2", { value: "two" }, printDef.pins({})),
        node(
          "debug.log",
          "log",
          { message: "kept" },
          logDef.pins({ message: "kept" }),
        ),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "entry",
          sourcePinId: "execOut",
          targetNodeId: "print1",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "print1",
          sourcePinId: "execOut",
          targetNodeId: "print2",
          targetPinId: "execIn",
        },
        {
          id: "e3",
          sourceNodeId: "print2",
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
    expect(exported.source).not.toContain("ctx.print");
    expect(exported.source).toContain("ctx.log");
  });

  it("compiles data pins from a stripped ExecuteJavaScript as type defaults", () => {
    const registry = registryWithDebugNodes();
    const jsDef = registry.get("debug.executeJavaScript")!;
    const useDef = registry.get("debug.use")!;
    const entryDef = registry.get("flow.entry")!;
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node("flow.entry", "entry", {}, entryDef.pins({})),
        node(
          "debug.executeJavaScript",
          "js",
          { developmentOnly: true, value: 7 },
          jsDef.pins({}),
        ),
        node("debug.use", "use", {}, useDef.pins({})),
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
          targetNodeId: "use",
          targetPinId: "execIn",
        },
        {
          id: "e3",
          sourceNodeId: "js",
          sourcePinId: "out_result",
          targetNodeId: "use",
          targetPinId: "value",
        },
      ],
    };
    const exported = compileGraph(graph, {
      assetGuid: "a",
      registry,
      stripDevelopmentOnly: true,
    });
    expect(exported.source).not.toContain("execJs_js");
    expect(exported.source).toContain("ctx.use(0)");
  });

  it("omits a flagged event entry from the export module", () => {
    const registry = registryWithDebugNodes();
    registry.register({
      id: "flow.event.tick",
      title: "Event Tick",
      category: "flow",
      pins: () => [pin("execOut", "then", "out", EXEC)],
      codegen: () => {},
    });
    const tickDef = registry.get("flow.event.tick")!;
    const logDef = registry.get("debug.log")!;
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(
          "flow.event.tick",
          "tick",
          { developmentOnly: true },
          tickDef.pins({}),
        ),
        node(
          "debug.log",
          "log",
          { message: "tick" },
          logDef.pins({ message: "tick" }),
        ),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "tick",
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
    expect(exported.source).not.toContain("function onTick");
    expect(exported.source).not.toContain("ctx.log");
  });
});
