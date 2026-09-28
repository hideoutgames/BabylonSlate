import { describe, expect, it } from "vitest";
import {
  EXEC,
  STRING,
  actorRef,
  compileGraph,
  objectRef,
  validateGraphs,
  type ClassHierarchy,
  type GraphEdge,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
  type PinType,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";
import { SUBSYSTEM_GET_NODE_ID, subsystemGetProperties } from "./subsystem";

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
  sourceNodeId: string,
  sourcePinId: string,
  targetNodeId: string,
  targetPinId: string,
): GraphEdge {
  return {
    id: `${sourceNodeId}.${sourcePinId}->${targetNodeId}.${targetPinId}`,
    sourceNodeId,
    sourcePinId,
    targetNodeId,
    targetPinId,
  };
}

/** Evaluates a compiled module and returns the named exports. */
function loadExports(
  source: string,
  names: readonly string[],
): Record<string, (ctx: unknown) => unknown> {
  const body = source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  return new Function(`${body}\nreturn { ${names.join(", ")} };`)() as Record<
    string,
    (ctx: unknown) => unknown
  >;
}

const PARENT_OF: Record<string, string> = {
  InventorySubsystem: "InventoryBase",
  InventoryBase: "GameSubsystem",
  GameSubsystem: "Subsystem",
  Subsystem: "BObject",
};

const hierarchy: ClassHierarchy = {
  isSubclassOf(child, parent) {
    for (let id: string | undefined = child; id; id = PARENT_OF[id]) {
      if (id === parent) return true;
    }
    return false;
  },
};

describe("Get <Subsystem>", () => {
  it("types its output as a reference to the requested class", () => {
    const registry = createDefaultNodeRegistry();
    const def = registry.get(SUBSYSTEM_GET_NODE_ID);
    expect(def?.pure).toBe(true);
    expect(def?.pins(subsystemGetProperties(" InventorySubsystem "))).toEqual([
      expect.objectContaining({
        id: "subsystem",
        direction: "out",
        type: objectRef("InventorySubsystem"),
      }),
    ]);
  });

  it("feeds member Call, Get and Set nodes declared on the subsystem or its parent", () => {
    const registry = createDefaultNodeRegistry();
    const addItemPins: Array<{ name: string; typeId: string; direction: "in" | "out" }> = [
      { name: "count", typeId: "int", direction: "in" },
      { name: "total", typeId: "int", direction: "out" },
    ];
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "init", "flow.event.init"),
        node(
          registry,
          "get",
          SUBSYSTEM_GET_NODE_ID,
          subsystemGetProperties("InventorySubsystem"),
        ),
        node(registry, "capacity", "variables.get", {
          classId: "InventorySubsystem",
          variableName: "Capacity",
          typeId: "int",
          implicitSelf: false,
        }),
        node(registry, "call", "functions.call", {
          classId: "InventoryBase",
          functionName: "Add Item",
          implicitSelf: false,
          pins: addItemPins,
        }),
        node(registry, "set", "variables.set", {
          classId: "InventoryBase",
          variableName: "Last Total",
          typeId: "int",
          implicitSelf: false,
        }),
      ],
      edges: [
        edge("init", "execOut", "call", "execIn"),
        edge("call", "execOut", "set", "execIn"),
        edge("get", "subsystem", "capacity", "target"),
        edge("get", "subsystem", "call", "target"),
        edge("get", "subsystem", "set", "target"),
        edge("capacity", "value", "call", "count"),
        edge("call", "total", "set", "value"),
      ],
    };

    const diagnostics = validateGraphs(
      [graph],
      {
        assetGuid: "hud",
        classId: "HudController",
        hierarchy,
        knownClassIds: new Set([...Object.keys(PARENT_OF), "BObject", "HudController"]),
        members: [
          { id: "fn", kind: "function", name: "Add Item", classId: "InventoryBase", pins: addItemPins },
          { id: "cap", kind: "variable", name: "Capacity", classId: "InventorySubsystem", typeId: "int" },
          { id: "last", kind: "variable", name: "Last Total", classId: "InventoryBase", typeId: "int" },
        ],
      },
      { registry },
    );
    expect(diagnostics).toEqual([]);

    const compiled = compileGraph(graph, { assetGuid: "hud", registry });
    const inventory = { vars: { Capacity: 5 } as Record<string, unknown> };
    const requested: string[] = [];
    const calls: Array<{ target: unknown; name: string; args: unknown }> = [];
    loadExports(compiled.source, ["onInit"]).onInit!({
      getSubsystem: (classId: string) => {
        requested.push(classId);
        return classId === "InventorySubsystem" ? inventory : null;
      },
      getVariableFrom: (target: typeof inventory, key: string) => target.vars[key],
      invokeFunction: (target: unknown, name: string, args: unknown) => {
        calls.push({ target, name, args });
        return { total: 12 };
      },
      setVariableOn: (target: typeof inventory, key: string, value: unknown) => {
        target.vars[key] = value;
      },
    });

    expect(new Set(requested)).toEqual(new Set(["InventorySubsystem"]));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBe(inventory);
    expect(calls[0]).toMatchObject({ name: "Add_Item", args: { count: 5 } });
    expect(inventory.vars["Last Total"]).toBe(12);
  });
});

type EventCase = {
  typeId: string;
  exportName: string;
  title: string;
  pins: Array<{ id: string; name: string; type: PinType }>;
};

const STREAMED_PINS = [
  { id: "streamingActor", name: "Streaming Actor", type: actorRef("SceneStreamingActor") },
  { id: "scene", name: "Scene", type: objectRef("Scene") },
];
const LAYER_PINS = [
  { id: "sceneLayer", name: "Scene Layer", type: objectRef("SceneLayer") },
];
const ACTOR_PINS = [{ id: "actor", name: "Actor", type: actorRef("Actor") }];

const SCENE_SUBSYSTEM_EVENTS: EventCase[] = [
  {
    typeId: "flow.event.sceneLoaded",
    exportName: "onSceneLoaded",
    title: "Event On Scene Loaded",
    pins: [{ id: "sceneName", name: "Scene Name", type: STRING }],
  },
  {
    typeId: "flow.event.streamedSceneLoaded",
    exportName: "onStreamedSceneLoaded",
    title: "Event On Streamed Scene Loaded",
    pins: STREAMED_PINS,
  },
  {
    typeId: "flow.event.streamedSceneUnloaded",
    exportName: "onStreamedSceneUnloaded",
    title: "Event On Streamed Scene Unloaded",
    pins: STREAMED_PINS,
  },
  {
    typeId: "flow.event.sceneLayerAdded",
    exportName: "onSceneLayerAdded",
    title: "Event On Scene Layer Added",
    pins: LAYER_PINS,
  },
  {
    typeId: "flow.event.sceneLayerRemoved",
    exportName: "onSceneLayerRemoved",
    title: "Event On Scene Layer Removed",
    pins: LAYER_PINS,
  },
  {
    typeId: "flow.event.sceneActorSpawned",
    exportName: "onSceneActorSpawned",
    title: "Event On Scene Actor Spawned",
    pins: ACTOR_PINS,
  },
  {
    typeId: "flow.event.sceneActorDestroyed",
    exportName: "onSceneActorDestroyed",
    title: "Event On Scene Actor Destroyed",
    pins: ACTOR_PINS,
  },
];

describe("Scene Subsystem events", () => {
  it.each(SCENE_SUBSYSTEM_EVENTS)(
    "$typeId compiles to $exportName and reads each output from the runtime args",
    ({ typeId, exportName, title, pins }) => {
      const registry = createDefaultNodeRegistry();
      const def = registry.get(typeId);
      expect(def?.title).toBe(title);
      expect(
        def?.pins({}).map((entry) => ({
          id: entry.id,
          name: entry.name,
          direction: entry.direction,
          type: entry.type,
        })),
      ).toEqual([
        { id: "execOut", name: "then", direction: "out", type: EXEC },
        ...pins.map((entry) => ({ ...entry, direction: "out" })),
      ]);

      const logs = pins.map((entry) => node(registry, `log_${entry.id}`, "debug.log"));
      const execChain = ["event", ...logs.map((log) => log.id)];
      const graph: LogicGraph = {
        id: "g",
        kind: "event",
        nodes: [node(registry, "event", typeId), ...logs],
        edges: [
          ...logs.map((log, index) =>
            edge(execChain[index]!, "execOut", log.id, "execIn"),
          ),
          ...pins.map((entry) => edge("event", entry.id, `log_${entry.id}`, "message")),
        ],
      };
      const compiled = compileGraph(graph, { assetGuid: "sub", registry });
      const args = Object.fromEntries(
        pins.map((entry) => [entry.id, { arg: entry.id }]),
      );
      const logged: unknown[] = [];
      loadExports(compiled.source, [exportName])[exportName]!({
        args,
        formatValue: (value: unknown) => value,
        log: (_severity: string, _category: string, message: unknown) =>
          logged.push(message),
      });
      expect(logged).toEqual(pins.map((entry) => args[entry.id]));
    },
  );

  it.each(SCENE_SUBSYSTEM_EVENTS)(
    "Call Parent Event on $typeId runs the parent's $exportName",
    ({ typeId, exportName }) => {
      const registry = createDefaultNodeRegistry();
      const graph: LogicGraph = {
        id: "g",
        kind: "event",
        nodes: [
          node(registry, "event", typeId),
          node(registry, "parent", "flow.event.callParent", {
            eventType: typeId,
            parentClassId: "LevelRulesBase",
          }),
        ],
        edges: [edge("event", "execOut", "parent", "execIn")],
      };
      const compiled = compileGraph(graph, { assetGuid: "sub", registry });
      const invoked: unknown[] = [];
      loadExports(compiled.source, [exportName])[exportName]!({
        args: {},
        invokeEvent: (classId: string, event: string) => invoked.push([classId, event]),
      });
      expect(invoked).toEqual([["LevelRulesBase", exportName]]);
    },
  );
});
