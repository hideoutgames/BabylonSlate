import { describe, expect, it } from "vitest";
import {
  compileGraph,
  pin,
  EXEC,
  FLOAT,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";

function node(
  registry: NodeRegistry,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const def = registry.get(typeId);
  return {
    id,
    typeId,
    position: { x: 0, y: 0 },
    pins: def ? def.pins(properties) : [pin("execOut", "then", "out", EXEC)],
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
  return new Function(`${body}\nreturn { run };`)() as Record<string, unknown>;
}

const jsProps = (
  body: string,
  outName: string,
  extra: Record<string, unknown> = {},
) => ({
  inputs: [{ name: "value", type: FLOAT }],
  outputs: [{ name: outName, type: FLOAT }],
  body,
  ...extra,
});

describe("compiler emits runnable JavaScript", () => {
  it("supports two ExecuteJavaScript nodes in one exec chain", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "entry", "flow.entry"),
        node(
          registry,
          "js1",
          "debug.executeJavaScript",
          jsProps("first = value + 1;", "first", { value: 1 }),
        ),
        node(
          registry,
          "js2",
          "debug.executeJavaScript",
          jsProps("second = value + 10;", "second"),
        ),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        edge("e1", "entry", "execOut", "js1", "execIn"),
        edge("e2", "js1", "execOut", "js2", "execIn"),
        edge("e3", "js1", "out_first", "js2", "in_value"),
        edge("e4", "js2", "execOut", "log", "execIn"),
        edge("e5", "js2", "out_second", "log", "message"),
      ],
    };

    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    const mod = loadModule(compiled.source);
    const logs: string[] = [];
    (mod.run as (ctx: unknown) => void)({
      formatValue: (v: unknown) => String(v),
      log: (_s: string, _c: string, message: string) => logs.push(message),
    });
    expect(logs).toEqual(["12"]);
  });

  it("makes the entry point async when a latent node awaits", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "entry", "flow.entry"),
        node(
          registry,
          "js",
          "debug.executeJavaScript",
          jsProps("out = await Promise.resolve(value + 5);", "out", {
            async: true,
            value: 2,
          }),
        ),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        edge("e1", "entry", "execOut", "js", "execIn"),
        edge("e2", "js", "execOut", "log", "execIn"),
        edge("e3", "js", "out_out", "log", "message"),
      ],
    };

    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain(`export async function run(ctx)`);
    expect(compiled.isAsync).toBe(true);
    const mod = loadModule(compiled.source);
    const logs: string[] = [];
    await (mod.run as (ctx: unknown) => Promise<void>)({
      formatValue: (v: unknown) => String(v),
      log: (_s: string, _c: string, message: string) => logs.push(message),
    });
    expect(logs).toEqual(["7"]);
  });

  it("runs a node reachable from two Sequence outputs without redeclaring vars", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "entry", "flow.entry"),
        node(registry, "seq", "flow.sequence", { count: 2 }),
        node(registry, "cmd", "debug.executeConsoleCommand", {
          command: "stat fps",
        }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        edge("e1", "entry", "execOut", "seq", "execIn"),
        edge("e2", "seq", "then0", "cmd", "execIn"),
        edge("e3", "seq", "then1", "cmd", "execIn"),
        edge("e4", "cmd", "execOut", "log", "execIn"),
        edge("e5", "cmd", "output", "log", "message"),
      ],
    };

    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    const mod = loadModule(compiled.source);
    const logs: string[] = [];
    (mod.run as (ctx: unknown) => void)({
      formatValue: (v: unknown) => String(v),
      log: (_s: string, _c: string, message: string) => logs.push(message),
      executeConsoleCommand: (command: string) => ({
        success: true,
        output: `ran ${command}`,
      }),
    });
    expect(logs).toEqual(["ran stat fps", "ran stat fps"]);
  });

  it("keeps impure node outputs readable after a Branch merges", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "entry", "flow.entry"),
        node(registry, "cmd", "debug.executeConsoleCommand", {
          command: "warmup",
        }),
        node(registry, "branch", "flow.branch", { condition: true }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        edge("e1", "entry", "execOut", "cmd", "execIn"),
        edge("e2", "cmd", "execOut", "branch", "execIn"),
        edge("e3", "cmd", "success", "branch", "condition"),
        edge("e4", "branch", "true", "log", "execIn"),
        edge("e5", "cmd", "output", "log", "message"),
      ],
    };

    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    const mod = loadModule(compiled.source);
    const logs: string[] = [];
    (mod.run as (ctx: unknown) => void)({
      formatValue: (v: unknown) => String(v),
      log: (_s: string, _c: string, message: string) => logs.push(message),
      executeConsoleCommand: () => ({ success: true, output: "warm" }),
    });
    expect(logs).toEqual(["warm"]);
  });

  it("emits authored default: pin values when the input is unconnected", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "entry", "flow.entry"),
        node(registry, "add", "math.add", { "default:a": 2, "default:b": 3 }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        edge("e1", "entry", "execOut", "log", "execIn"),
        edge("e2", "add", "out", "log", "message"),
      ],
    };

    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("2");
    expect(compiled.source).toContain("3");
    const mod = loadModule(compiled.source);
    const logs: string[] = [];
    (mod.run as (ctx: unknown) => void)({
      formatValue: (v: unknown) => String(v),
      log: (_s: string, _c: string, message: string) => logs.push(message),
    });
    expect(logs).toEqual(["5"]);
  });

  it("ignores a stored pin default when that input is connected", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "entry", "flow.entry"),
        node(registry, "left", "math.add", { "default:a": 10, "default:b": 1 }),
        node(registry, "right", "math.add", { "default:a": 2, "default:b": 3 }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        edge("e1", "entry", "execOut", "log", "execIn"),
        edge("e2", "left", "out", "right", "a"),
        edge("e3", "right", "out", "log", "message"),
      ],
    };

    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    const mod = loadModule(compiled.source);
    const logs: string[] = [];
    (mod.run as (ctx: unknown) => void)({
      formatValue: (v: unknown) => String(v),
      log: (_s: string, _c: string, message: string) => logs.push(message),
    });
    expect(logs).toEqual(["14"]);
  });
});
