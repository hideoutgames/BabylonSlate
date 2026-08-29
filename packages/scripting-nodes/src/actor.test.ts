import { describe, expect, it } from "vitest";
import {
  compileGraph,
  arrayOf,
  actorRef,
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
  it("registers Spawn Actor", () => {
    expect(actorNodes.map((n) => n.id)).toContain("actor.spawn");
  });

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

  it("compiled Spawn Actor calls ctx.spawnActor", () => {
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
    expect(compiled.source).toContain("ctx.spawnActor");
    const mod = loadModule(compiled.source);
    const spawned: string[] = [];
    (mod.onBeginPlay as (ctx: unknown) => void)({
      spawnActor: (classId: string) => {
        spawned.push(classId);
        return { classId };
      },
    });
    expect(spawned).toEqual(["Child"]);
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

  it("compiled Spawn Actor passes transform as the second spawnActor argument", () => {
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
    expect(compiled.source).toMatch(
      /ctx\.spawnActor\(\s*[^,]+,\s*[^)]+\)/,
    );
    const mod = loadModule(compiled.source);
    const calls: Array<{ classId: string; transform: unknown }> = [];
    (mod.onBeginPlay as (ctx: unknown) => void)({
      spawnActor: (classId: string, transform: unknown) => {
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

  it("registers Get All Actors Of Class and Get Actor Of Class", () => {
    expect(actorNodes.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        "actor.getAllOfClass",
        "actor.getOfClass",
      ]),
    );
    expect(
      actorNodes.find((entry) => entry.id === "actor.getAllOfClass")?.title,
    ).toBe("Get All Actors Of Class");
    expect(actorNodes.find((entry) => entry.id === "actor.getOfClass")?.title).toBe(
      "Get Actor Of Class",
    );
    const allPins =
      actorNodes.find((entry) => entry.id === "actor.getAllOfClass")?.pins({}) ??
      [];
    expect(allPins.find((pin) => pin.id === "classId")?.type).toEqual(
      classRef("Actor"),
    );
    expect(allPins.find((pin) => pin.id === "out")?.type).toEqual(
      arrayOf(actorRef("Actor")),
    );
    const onePins =
      actorNodes.find((entry) => entry.id === "actor.getOfClass")?.pins({}) ?? [];
    expect(onePins.find((pin) => pin.id === "out")?.type).toEqual(
      actorRef("Actor"),
    );
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

  it("registers Attach, Detach, Get Parent, Set Owner, and Get Owner", () => {
    expect(actorNodes.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        "actor.attach",
        "actor.detach",
        "actor.getParent",
        "actor.setOwner",
        "actor.getOwner",
      ]),
    );
    expect(actorNodes.find((entry) => entry.id === "actor.attach")?.title).toBe(
      "Attach Actor",
    );
    expect(actorNodes.find((entry) => entry.id === "actor.detach")?.title).toBe(
      "Detach Actor",
    );
    expect(actorNodes.find((entry) => entry.id === "actor.getParent")?.title).toBe(
      "Get Parent",
    );
    expect(actorNodes.find((entry) => entry.id === "actor.setOwner")?.title).toBe(
      "Set Owner",
    );
    expect(actorNodes.find((entry) => entry.id === "actor.getOwner")?.title).toBe(
      "Get Owner",
    );
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
