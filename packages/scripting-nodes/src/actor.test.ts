import { describe, expect, it } from "vitest";
import {
  compileGraph,
  classRef,
  objectRef,
  TRANSFORM,
  validateGraphs,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { actorNodes, createDefaultNodeRegistry } from "./index";

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

function loadModule(source: string): Record<string, unknown> {
  const body = source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  return new Function(`${body}\nreturn { onBeginPlay };`)() as Record<
    string,
    unknown
  >;
}

describe("actor nodes", () => {
  it("Is Valid takes an Object pin and reports non-null instances", () => {
    const def = actorNodes.find((entry) => entry.id === "actor.isValid");
    const pins = def?.pins({}) ?? [];
    expect(pins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "target",
          name: "Object",
          direction: "in",
          type: objectRef("BObject"),
        }),
      ]),
    );
    expect(pins.find((pin) => pin.id === "target")?.name).toBe("Object");
    expect(def?.pure).toBe(true);

    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "self", "actor.getSelf"),
        node(registry, "valid", "actor.isValid"),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "self",
          sourcePinId: "out",
          targetNodeId: "valid",
          targetPinId: "target",
        },
        {
          id: "e3",
          sourceNodeId: "valid",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" }, { registry });
    expect(
      diags.some(
        (d) =>
          d.code === "type.mismatch" &&
          d.nodeId === "valid" &&
          d.pinId === "target",
      ),
    ).toBe(false);
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("!= null");
    const body = compiled.source.replace(
      /export\s+(async\s+)?function\s+/g,
      "$1function ",
    );
    const onBeginPlay = new Function(`${body}\nreturn { onBeginPlay };`)()
      .onBeginPlay as (ctx: { self: unknown; formatValue: (value: unknown) => string; log: (...args: unknown[]) => void }) => void;
    const messages: unknown[] = [];
    onBeginPlay({
      self: { classId: "Hero" },
      formatValue: String,
      log: (_severity, _category, message) => {
        messages.push(message);
      },
    });
    expect(messages).toEqual(["true"]);
    messages.length = 0;
    onBeginPlay({
      self: null,
      formatValue: String,
      log: (_severity, _category, message) => {
        messages.push(message);
      },
    });
    expect(messages).toEqual(["false"]);
  });

  it("uses a classRef pin for Spawn Actor classId", () => {
    const spawn = actorNodes.find((node) => node.id === "actor.spawn");
    expect(spawn?.pins({}).find((entry) => entry.id === "classId")?.type).toEqual(
      classRef("Actor"),
    );
  });

  it("compiled Spawn Actor waits for cold asset preparation", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "spawn", "actor.spawn", { classId: "Child" }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "spawn",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
        const mod = loadModule(compiled.source);
    const spawned: string[] = [];
    let ready!: () => void;
    let finished = false;
    const pending = (mod.onBeginPlay as (ctx: unknown) => Promise<void>)({
      spawnActorAsync: (classId: string) => {
        spawned.push(classId);
        return new Promise(resolve => { ready = () => resolve({ classId }); });
      },
    }).then(() => { finished = true; });
    expect(spawned).toEqual(["Child"]);
    await Promise.resolve();
    expect(finished).toBe(false);
    ready();
    await pending;
    expect(finished).toBe(true);
  });

  it("exposes an optional Transform pin on Spawn Actor", () => {
    const spawn = actorNodes.find((node) => node.id === "actor.spawn");
    const transformPin = spawn?.pins({}).find((entry) => entry.id === "transform");
    expect(transformPin).toMatchObject({
      name: "Transform",
      direction: "in",
      type: TRANSFORM,
      optional: true,
    });
  });

  it("compiled Spawn Actor passes the authored transform to asynchronous preparation", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "spawn", "actor.spawn", { classId: "Child" }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "spawn",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    const mod = loadModule(compiled.source);
    const calls: Array<{ classId: string; transform: unknown }> = [];
    await (mod.onBeginPlay as (ctx: unknown) => Promise<void>)({
      spawnActorAsync: async (classId: string, transform: unknown) => {
        calls.push({ classId, transform });
        return { classId };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.classId).toBe("Child");
    expect(calls[0]?.transform).toEqual({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    });
  });

  it("compiles class queries through ctx.getAllActorsOfClass and ctx.getActorOfClass", () => {
    const registry = createDefaultNodeRegistry();
    for (const [typeId, needle] of [
      ["actor.getAllOfClass", "ctx.getAllActorsOfClass"],
      ["actor.getOfClass", "ctx.getActorOfClass"],
    ] as const) {
      const graph: LogicGraph = {
        id: "g",
        kind: "event",
        nodes: [
          node(registry, "begin", "flow.event.beginPlay"),
          node(registry, "query", typeId, {
            "default:classId": "Hero",
          }),
          node(registry, "log", "debug.log"),
        ],
        edges: [
          {
            id: "e1",
            sourceNodeId: "begin",
            sourcePinId: "execOut",
            targetNodeId: "log",
            targetPinId: "execIn",
          },
          {
            id: "e2",
            sourceNodeId: "query",
            sourcePinId: "out",
            targetNodeId: "log",
            targetPinId: "message",
          },
        ],
      };
      const compiled = compileGraph(graph, { assetGuid: "a", registry });
      expect(compiled.source).toContain(needle);
    }

    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "all", "actor.getAllOfClass", {
          "default:classId": "Hero",
        }),
        node(registry, "one", "actor.getOfClass", {
          "default:classId": "Hero",
        }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "one",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
        {
          id: "e3",
          sourceNodeId: "all",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    // Second data wire to message replaces the first — keep getOfClass only for runtime call order.
    graph.edges = graph.edges.filter((edge) => edge.id !== "e3");
    const compiled = compileGraph(graph, {
      assetGuid: "a",
      registry,
    });
    // Force both queries by compiling a Sequence that logs both lengths via Execute JS would be heavy;
    // invoke both helpers through a dedicated module load of getAll alone:
    const allCompiled = compileGraph(
      {
        id: "all",
        kind: "event",
        nodes: [
          node(registry, "begin", "flow.event.beginPlay"),
          node(registry, "all", "actor.getAllOfClass", {
            "default:classId": "Hero",
          }),
          node(registry, "log", "debug.log"),
        ],
        edges: [
          {
            id: "e1",
            sourceNodeId: "begin",
            sourcePinId: "execOut",
            targetNodeId: "log",
            targetPinId: "execIn",
          },
          {
            id: "e2",
            sourceNodeId: "all",
            sourcePinId: "out",
            targetNodeId: "log",
            targetPinId: "message",
          },
        ],
      },
      { assetGuid: "a", registry },
    );
    const queried: string[] = [];
    const allMod = loadModule(allCompiled.source);
    (allMod.onBeginPlay as (ctx: unknown) => void)({
      formatValue: () => "",
      log: () => {},
      getAllActorsOfClass: (classId: string) => {
        queried.push(`all:${classId}`);
        return [{ name: "a" }, { name: "b" }];
      },
      getActorOfClass: (classId: string) => {
        queried.push(`one:${classId}`);
        return { name: "a" };
      },
    });
    const oneMod = loadModule(compiled.source);
    (oneMod.onBeginPlay as (ctx: unknown) => void)({
      formatValue: () => "",
      log: () => {},
      getAllActorsOfClass: (classId: string) => {
        queried.push(`all:${classId}`);
        return [{ name: "a" }, { name: "b" }];
      },
      getActorOfClass: (classId: string) => {
        queried.push(`one:${classId}`);
        return { name: "a" };
      },
    });
    expect(queried).toEqual(["all:Hero", "one:Hero"]);
  });

  it("compiles hierarchy and owner nodes through ctx attach/owner helpers", () => {
    const registry = createDefaultNodeRegistry();
    const cases = [
      ["actor.attach", "ctx.attachActor"],
      ["actor.detach", "ctx.detachActor"],
      ["actor.getParent", "ctx.getParent"],
      ["actor.setOwner", "ctx.setOwner"],
      ["actor.getOwner", "ctx.getOwner"],
    ] as const;
    for (const [typeId, needle] of cases) {
      const graph: LogicGraph = {
        id: "g",
        kind: "event",
        nodes: [
          node(registry, "begin", "flow.event.beginPlay"),
          node(registry, "self", "actor.getSelf"),
          node(registry, "op", typeId),
        ],
        edges: [
          {
            id: "e1",
            sourceNodeId: "begin",
            sourcePinId: "execOut",
            targetNodeId: typeId.startsWith("actor.get") ? "begin" : "op",
            targetPinId: "execIn",
          },
          {
            id: "e2",
            sourceNodeId: "self",
            sourcePinId: "out",
            targetNodeId: "op",
            targetPinId: typeId === "actor.attach" || typeId === "actor.setOwner"
              ? "target"
              : typeId.startsWith("actor.get")
                ? "target"
                : "target",
          },
        ],
      };
      if (typeId.startsWith("actor.get")) {
        graph.edges = [
          {
            id: "e2",
            sourceNodeId: "self",
            sourcePinId: "out",
            targetNodeId: "op",
            targetPinId: "target",
          },
        ];
        graph.nodes.push(node(registry, "log", "debug.log"));
        graph.edges.push({
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "log",
          targetPinId: "execIn",
        });
        graph.edges.push({
          id: "e3",
          sourceNodeId: "op",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        });
      }
      const compiled = compileGraph(graph, { assetGuid: "a", registry });
      expect(compiled.source, typeId).toContain(needle);
    }
  });
});
