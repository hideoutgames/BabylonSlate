import { describe, expect, it } from "vitest";
import {
  compileGraph,
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
  const body = source.replace(
    /export\s+(async\s+)?function\s+/g,
    "$1function ",
  );
  return new Function(`${body}\nreturn { onTick };`)() as Record<
    string,
    unknown
  >;
}

describe("input nodes", () => {
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
    expect(
      project.pins({}).find((p) => p.id === "drawDebug")?.defaultValue,
    ).toBe(true);
    expect(
      project.pins({}).find((p) => p.id === "duration")?.defaultValue,
    ).toBe(0);
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
  it.each(["Action", "Axis"])(
    "passes Any Key directly into %s add, set, and remove binding nodes",
    (kind) => {
      const registry = createDefaultNodeRegistry();
      const input = { Name: "Move", Asset: "move" };
      const binding = { Input: input, Id: "forward" };
      const options = { Component: "Y", DigitalValue: -1, Scale: 0.5 };
      const graph: LogicGraph = {
        id: "rebind",
        kind: "event",
        nodes: [
          node(registry, "key", "input.onAnyKeyPressed"),
          node(registry, "add", `input.add${kind}Binding`, {
            "default:input": input,
            "default:binding": options,
          }),
          node(registry, "set", `input.set${kind}Binding`, {
            "default:binding": binding,
          }),
          node(registry, "remove", `input.remove${kind}Binding`, {
            "default:input": input,
          }),
          node(registry, "log", "debug.log"),
        ],
        edges: [
          edge("begin", "key", "execOut", "add", "execIn"),
          edge("added", "add", "execOut", "set", "execIn"),
          edge("set", "set", "execOut", "remove", "execIn"),
          edge("removed", "remove", "execOut", "log", "execIn"),
          edge("success", "remove", "success", "log", "message"),
          ...["add", "set", "remove"].map((id) =>
            edge(`key-${id}`, "key", "key", id, "key"),
          ),
        ],
      };
      const compiled = compileGraph(graph, { assetGuid: "a", registry });
      const mod = loadModule(compiled.source);
      const calls: unknown[] = [];
      const logged: string[] = [];
      const controls = Object.fromEntries(
        ["add", "set", "remove"].map((operation) => [
          `${operation}Input${kind}Binding`,
          (...args: unknown[]) => {
            calls.push([operation, ...args]);
            return operation !== "remove";
          },
        ]),
      );
      (mod.onTick as (ctx: unknown) => void)({
        getPressedKeys: () => ["KeyI"],
        inputBindings: controls,
        formatValue: String,
        log: (_severity: string, _category: string, value: string) =>
          logged.push(value),
      });
      expect(calls).toEqual([
        ["add", input, "KeyI", options],
        ["set", binding, "KeyI"],
        ["remove", input, "KeyI"],
      ]);
      expect(logged).toEqual(["false"]);
    },
  );

  it.each([
    ["input.actionEvent", "button", true],
    ["input.axisEvent", "1d", -0.75],
    ["input.axisEvent", "2d", { x: -1, y: 0.5 }],
  ])(
    "%s resolves the whole asset from a connected binding (%s)",
    (typeId, valueType, value) => {
      const registry = createDefaultNodeRegistry();
      const graph: LogicGraph = {
        id: "binding-event",
        kind: "event",
        nodes: [
          node(registry, "make", "struct.make", {
            structGuid: "engine:InputBinding",
            fields: [
              {
                name: "Input",
                typeId: "struct",
                typeClassId: "engine:InputType",
              },
              { name: "Id", typeId: "string" },
            ],
            "default:Input": { Name: "Move", Asset: "move" },
            "default:Id": "a-different-slot",
          }),
          node(registry, "event", typeId as string, { valueType }),
          node(registry, "log", "debug.log"),
        ],
        edges: [
          edge("binding", "make", "out", "event", "binding"),
          edge("exec", "event", "started", "log", "execIn"),
          edge("value", "event", "value", "log", "message"),
        ],
      };
      const compiled = compileGraph(graph, { assetGuid: "a", registry });
      const mod = loadModule(compiled.source);
      const values: unknown[] = [];
      (mod.onTick as (ctx: unknown) => void)({
        getInputState: (input: unknown) => {
          expect(input).toEqual({ Name: "Move", Asset: "move" });
          return {
            valueType,
            started: true,
            held: true,
            released: false,
            value,
          };
        },
        formatValue: (entry: unknown) => entry,
        log: (_severity: string, _category: string, entry: unknown) =>
          values.push(entry),
      });
      expect(values).toEqual([value]);
      (mod.onTick as (ctx: unknown) => void)({
        getInputState: () => ({
          valueType: valueType === "button" ? "2d" : "button",
          started: true,
          held: true,
          released: true,
          value: "wrong-type",
        }),
        formatValue: (entry: unknown) => entry,
        log: (_severity: string, _category: string, entry: unknown) =>
          values.push(entry),
      });
      expect(values).toEqual([value]);
    },
  );

  it("executes Any Key once for each ordered press and passes the typed key through the chain", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "any-key",
      kind: "event",
      nodes: [
        node(registry, "key", "input.onAnyKeyPressed"),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        edge("exec", "key", "execOut", "log", "execIn"),
        edge("key", "key", "key", "log", "message"),
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    const mod = loadModule(compiled.source);
    const logged: string[] = [];
    const onTick = mod.onTick as (ctx: unknown) => void;
    const ctx = {
      formatValue: String,
      log: (_severity: string, _category: string, key: string) =>
        logged.push(key),
    };
    onTick({
      ...ctx,
      getPressedKeys: () => ["KeyW", "MouseLeft", "Gamepad2Button0"],
    });
    onTick({ ...ctx, getPressedKeys: () => [] });
    onTick(ctx);
    expect(logged).toEqual(["KeyW", "MouseLeft", "Gamepad2Button0"]);
  });

  it("dispatches independent phase chains and typed values without polling strings", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "input-events",
      kind: "event",
      nodes: [
        node(registry, "input", "input.actionEvent", {
          "default:binding": { Input: { Name: "Jump", Asset: "jump" } },
          valueType: "button",
        }),
        ...["started", "held", "released"].map((phase) =>
          node(registry, phase, "debug.log", { message: phase }),
        ),
      ],
      edges: ["started", "held", "released"].map((phase) =>
        edge(phase, "input", phase, phase, "execIn"),
      ),
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    const mod = loadModule(compiled.source);
    const logs: string[] = [];
    let snapshot = {
      valueType: "button",
      started: true,
      held: true,
      released: false,
      value: true,
      heldSeconds: 0,
      lastHeldSeconds: 0,
    };
    const ctx = {
      getInputState: (input: { Asset: string }) => {
        expect(input.Asset).toBe("jump");
        return snapshot;
      },
      formatValue: String,
      log: (_s: string, _c: string, message: string) => logs.push(message),
    };
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
