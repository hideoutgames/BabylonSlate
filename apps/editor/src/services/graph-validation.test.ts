import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import { createText3DComponent } from "@babylonslate/core";
import { createDefaultNodeRegistry, formatArgPinId, selectOptionPinId } from "@babylonslate/scripting-nodes";
import {
  classHierarchyFromParentOf,
  createDefaultLogicGraphSerialized,
  hydrateClassDocumentPayload,
  hydrateSerializedGraphForEditor,
  knownClassIdSet,
  materializeLogicGraph,
  ScriptPaletteCache,
  scriptPaletteNodes,
  scriptPinCompatibility,
  validateSerializedGraph,
} from "./graph-validation";

const registry = createDefaultNodeRegistry();

describe("hydrateClassDocumentPayload", () => {
  it("seeds a default event graph when the Class payload is empty", () => {
    const seeded = hydrateClassDocumentPayload({});
    expect(seeded.nodes.some((node) => node.type.includes("beginPlay"))).toBe(
      true,
    );
    expect(seeded.nodes.some((node) => node.type.includes("tick"))).toBe(true);
  });

  it("keeps an existing SerializedGraph payload", () => {
    const existing: SerializedGraph = { nodes: [], edges: [] };
    expect(hydrateClassDocumentPayload(existing)).toEqual(existing);
  });
});

describe("hydrateSerializedGraphForEditor", () => {
  it("injects __pins from the registry when missing", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "tick-1",
          type: "flow.event.tick",
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
      edges: [],
    };

    const hydrated = hydrateSerializedGraphForEditor(graph, registry);
    const pins = hydrated.nodes[0]?.data.__pins as unknown[];
    expect(Array.isArray(pins)).toBe(true);
    expect(pins.length).toBeGreaterThan(0);
    expect(pins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "execOut", direction: "out" }),
        expect.objectContaining({ id: "deltaSeconds", direction: "out" }),
      ]),
    );
  });

  it("rehydrates Print catalog defaultValue onto stored pins that lack it", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "print-1",
          type: "debug.print",
          position: { x: 0, y: 0 },
          data: {
            __nodeType: "debug.print",
            "default:key": "hp",
            __pins: [
              {
                id: "duration",
                name: "Duration",
                kind: "data",
                direction: "in",
                type: { kind: "float" },
              },
              {
                id: "color",
                name: "Color",
                kind: "data",
                direction: "in",
                type: { kind: "color" },
              },
            ],
          },
        },
      ],
      edges: [],
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, registry);
    const pins = hydrated.nodes[0]?.data.__pins as Array<{
      id: string;
      defaultValue?: unknown;
    }>;
    expect(hydrated.nodes[0]?.data["default:key"]).toBe("hp");
    expect(pins.find((pin) => pin.id === "duration")?.defaultValue).toBe(2);
    expect(pins.find((pin) => pin.id === "color")?.defaultValue).toEqual({
      x: 1,
      y: 1,
      z: 1,
      w: 1,
    });
  });

  it("maps legacy logMessage to debug.log with Log pins", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "log-1",
          type: "logMessage",
          position: { x: 10, y: 20 },
          data: { message: "Hello" },
        },
      ],
      edges: [],
    };

    const hydrated = hydrateSerializedGraphForEditor(graph, registry);
    expect(hydrated.nodes[0]?.type).toBe("debug.log");
    expect(hydrated.nodes[0]?.data.message).toBe("Hello");
    const pins = hydrated.nodes[0]?.data.__pins as unknown[];
    expect(pins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "execIn" }),
        expect.objectContaining({ id: "execOut" }),
        expect.objectContaining({ id: "message" }),
      ]),
    );
  });

  it("titles Call Parent from eventType and the name fallback", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "cp-begin",
          type: "flow.event.callParent",
          position: { x: 0, y: 0 },
          data: {
            eventType: "flow.event.beginPlay",
            parentClassId: "Actor",
          },
        },
        {
          id: "cp-custom",
          type: "flow.event.callParent",
          position: { x: 0, y: 80 },
          data: {
            eventType: "flow.event.custom",
            name: "on hit",
            parentClassId: "Actor",
          },
        },
      ],
      edges: [],
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, registry);
    expect(hydrated.nodes[0]?.data.title).toBe("Call Begin Play Parent");
    expect(hydrated.nodes[1]?.data).toMatchObject({
      title: "Call On Hit Parent",
      eventName: "On Hit",
      name: "On Hit",
    });
  });

  it("titles an unconnected Cast node from the default class", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "cast-1",
          type: "casting.cast",
          position: { x: 0, y: 0 },
          data: {
            defaultClassId: "Hero",
            "default:class": "Hero",
            title: "Cast to BObject",
            __pins: [
              {
                id: "result",
                name: "result",
                kind: "data",
                direction: "out",
                type: { kind: "objectRef", classId: "BObject" },
              },
            ],
          },
        },
      ],
      edges: [],
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, registry, {
      parentOf: (id) => (id === "Hero" ? "Actor" : undefined),
    });
    expect(hydrated.nodes[0]?.data.title).toBe("Cast to Hero");
    const pins = hydrated.nodes[0]?.data.__pins as Array<{
      id: string;
      type: { kind: string; classId?: string };
    }>;
    expect(pins.find((pin) => pin.id === "result")?.type).toEqual({
      kind: "actorRef",
      classId: "Hero",
    });
  });

  it("titles a wired Cast node Cast to Class and types Result from the connected constraint", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "class-lit",
          type: "variables.get",
          position: { x: 0, y: 0 },
          data: {
            variableName: "Kind",
            typeId: "class",
            typeClassId: "Actor",
            implicitSelf: true,
          },
        },
        {
          id: "cast-1",
          type: "casting.cast",
          position: { x: 200, y: 0 },
          data: {
            defaultClassId: "Hero",
            "default:class": "Hero",
          },
        },
      ],
      edges: [
        {
          id: "e1",
          source: "class-lit",
          target: "cast-1",
          sourceHandle: "value",
          targetHandle: "class",
        },
      ],
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, registry, {
      parentOf: (id) => (id === "Hero" ? "Actor" : undefined),
    });
    expect(hydrated.nodes[1]?.data.title).toBe("Cast to Class");
    const pins = hydrated.nodes[1]?.data.__pins as Array<{
      id: string;
      type: { kind: string; classId?: string };
    }>;
    expect(pins.find((pin) => pin.id === "result")?.type).toEqual({
      kind: "actorRef",
      classId: "Actor",
    });
  });

  it("preserves existing __pins", () => {
    const customPins = [
      {
        id: "execOut",
        name: "then",
        kind: "exec" as const,
        direction: "out" as const,
        type: { kind: "exec" },
      },
    ];
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "n1",
          type: "flow.event.beginPlay",
          position: { x: 0, y: 0 },
          data: { __pins: customPins },
        },
      ],
      edges: [],
    };

    const hydrated = hydrateSerializedGraphForEditor(graph, registry);
    expect(hydrated.nodes[0]?.data.__pins).toEqual(customPins);
  });

  it("regenerates Call Custom Event pins so same-class Calls drop Target", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "call",
          type: "flow.event.call",
          position: { x: 0, y: 0 },
          data: {
            name: "On Hit",
            classId: "Hero",
            implicitSelf: true,
            __pins: [
              {
                id: "target",
                name: "target",
                kind: "data",
                direction: "in",
                type: { kind: "objectRef", classId: "Hero" },
              },
            ],
          },
        },
      ],
      edges: [],
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, registry);
    const pins = hydrated.nodes[0]?.data.__pins as Array<{ id: string }>;
    expect(pins?.some((pin) => pin.id === "target")).toBe(false);
  });

  it("injects node visual metadata from the registry", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "begin",
          type: "flow.event.beginPlay",
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
      edges: [],
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, registry);
    expect(hydrated.nodes[0]?.data.__category).toBe("flow");
    expect(hydrated.nodes[0]?.data.__pure).toBe(true);
    expect(hydrated.nodes[0]?.data.__latent).toBe(false);
    expect(hydrated.nodes[0]?.data.__nodeType).toBe("flow.event.beginPlay");
  });

  it("keeps an authored custom event title instead of the registry default", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "hit",
          type: "flow.event.custom",
          position: { x: 0, y: 0 },
          data: { title: "Event On Hit", name: "On Hit" },
        },
      ],
      edges: [],
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, registry);
    expect(hydrated.nodes[0]?.data.title).toBe("Event On Hit");
  });

  it("stamps __editorOnly from the registry on saved editor lifecycle nodes", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "startup",
          type: "flow.event.editorStartup",
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: "begin",
          type: "flow.event.beginPlay",
          position: { x: 0, y: 80 },
          data: {},
        },
      ],
      edges: [],
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, registry);
    expect(hydrated.nodes[0]?.data.__editorOnly).toBe(true);
    expect(hydrated.nodes[1]?.data.__editorOnly).toBeUndefined();
  });

  it("drops Get Variable wires whose types no longer assign after a container change", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "get",
          type: "variables.get",
          position: { x: 0, y: 0 },
          data: {
            variableName: "Health",
            typeId: "float",
            container: "array",
            implicitSelf: true,
          },
        },
        {
          id: "add",
          type: "math.add",
          position: { x: 200, y: 0 },
          data: {},
        },
      ],
      edges: [
        {
          id: "e1",
          source: "get",
          target: "add",
          sourceHandle: "value",
          targetHandle: "a",
        },
      ],
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, registry);
    const pins = hydrated.nodes[0]?.data.__pins as Array<{
      id: string;
      type: { kind: string };
    }>;
    expect(pins.find((pin) => pin.id === "value")?.type.kind).toBe("array");
    expect(hydrated.edges).toEqual([]);
  });
});

describe("createDefaultLogicGraphSerialized", () => {
  it("seeds Begin Play and Tick with pins", () => {
    const graph = createDefaultLogicGraphSerialized(registry);
    const types = graph.nodes.map((n) => n.type);
    expect(types).toContain("flow.event.beginPlay");
    expect(types).toContain("flow.event.tick");
    expect(types).not.toContain("flow.event.destroyed");
    expect(types).not.toContain("flow.event.hit");
    expect(types).not.toContain("flow.event.beginOverlap");
    expect(types).not.toContain("flow.event.endOverlap");
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "event-begin-play",
      "event-tick",
    ]);
    for (const node of graph.nodes) {
      expect(Array.isArray(node.data.__pins)).toBe(true);
      expect((node.data.__pins as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it("seeds Call Parent wires when a parent class is set", () => {
    const graph = createDefaultLogicGraphSerialized(registry, {
      parentClass: "Actor",
    });
    expect(graph.nodes.map((node) => node.type)).toEqual([
      "flow.event.beginPlay",
      "flow.event.callParent",
      "flow.event.tick",
      "flow.event.callParent",
    ]);
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "event-begin-play",
      "call-parent-flow-event-beginPlay",
      "event-tick",
      "call-parent-flow-event-tick",
    ]);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "event-begin-play",
          target: "call-parent-flow-event-beginPlay",
          sourceHandle: "execOut",
          targetHandle: "execIn",
        }),
        expect.objectContaining({
          source: "event-tick",
          target: "call-parent-flow-event-tick",
          sourceHandle: "execOut",
          targetHandle: "execIn",
        }),
        expect.objectContaining({
          source: "event-tick",
          target: "call-parent-flow-event-tick",
          sourceHandle: "deltaSeconds",
          targetHandle: "deltaSeconds",
        }),
      ]),
    );
    expect(
      graph.nodes.find((node) => node.id === "call-parent-flow-event-beginPlay")
        ?.data,
    ).toMatchObject({
      title: "Call Begin Play Parent",
      parentClassId: "Actor",
      eventType: "flow.event.beginPlay",
    });
  });

  it("seeds inherited custom events with Call Parent", () => {
    const graph = createDefaultLogicGraphSerialized(registry, {
      parentClass: "HeroBase",
      parentOf: (id) => (id === "HeroBase" ? "Actor" : null),
      parentGraphs: {
        HeroBase: {
          nodes: [],
          edges: [],
          members: [
            {
              id: "evt-1",
              kind: "event",
              name: "On Hit",
              pins: [{ name: "amount", typeId: "float", direction: "out" }],
            },
          ],
        },
      },
    });
    expect(graph.nodes.some((node) => node.type === "flow.event.custom")).toBe(
      true,
    );
    expect(
      graph.nodes.some(
        (node) =>
          node.type === "flow.event.callParent" &&
          node.data.eventName === "On Hit",
      ),
    ).toBe(true);
  });

  it("seeds On Evaluate for a BTDecorator class", () => {
    const graph = createDefaultLogicGraphSerialized(registry, {
      parentClass: "BTDecorator",
    });
    expect(graph.nodes.map((node) => node.type)).toEqual([
      "bt.event.evaluate",
      "flow.event.callParent",
    ]);
    expect(graph.nodes.some((node) => node.type === "flow.event.beginPlay")).toBe(
      false,
    );
  });

  it("seeds Activate, Tick, and Abort for a BTTask class", () => {
    const graph = createDefaultLogicGraphSerialized(registry, {
      parentClass: "BTTask",
    });
    expect(graph.nodes.filter((node) => node.type.startsWith("bt.event.")).map((node) => node.type)).toEqual([
      "bt.event.activate",
      "bt.event.tick",
      "bt.event.abort",
    ]);
    expect(
      graph.nodes.filter((node) => node.type === "flow.event.callParent"),
    ).toHaveLength(3);
  });

  it("seeds editor lifecycle events for an EditorUtilityObject class", () => {
    const graph = createDefaultLogicGraphSerialized(registry, {
      parentClass: "EditorUtilityObject",
    });
    expect(
      graph.nodes
        .filter((node) => node.type.startsWith("flow.event.") && node.type !== "flow.event.callParent")
        .map((node) => node.type),
    ).toEqual([
      "flow.event.editorBeginPlay",
      "flow.event.editorStartup",
      "flow.event.sceneOpen",
      "flow.event.sceneSaved",
      "flow.event.editorShutdown",
    ]);
    expect(graph.nodes.some((node) => node.type === "flow.event.beginPlay")).toBe(
      false,
    );
  });

  it("seeds no event nodes for a FunctionLibrary class", () => {
    const graph = createDefaultLogicGraphSerialized(registry, {
      parentClass: "FunctionLibrary",
    });
    expect(graph.nodes).toEqual([]);
  });

  it("seeds no event nodes for a BObject class", () => {
    const graph = createDefaultLogicGraphSerialized(registry, {
      parentClass: "BObject",
    });
    expect(graph.nodes).toEqual([]);
  });

  it("does not seed leftover EditorUtilityInterface as a logic host", () => {
    const graph = createDefaultLogicGraphSerialized(registry, {
      parentClass: "BObject",
      assetType: "EditorUtilityInterface",
    });
    expect(graph.nodes).toEqual([]);
  });
});

describe("validateSerializedGraph", () => {
  it("warns when ExecuteConsoleCommand literals name a debug-tier command", () => {
    const diags = validateSerializedGraph(
      {
        id: "event-graph",
        kind: "event",
        nodes: [
          {
            id: "cmd",
            typeId: "debug.executeConsoleCommand",
            position: { x: 0, y: 0 },
            pins: [],
            properties: { command: "showfps" },
          },
        ],
        edges: [],
      },
      { assetGuid: "g1", graphId: "event-graph" },
    );
    expect(diags.some((d) => d.code === "console.debug_tier")).toBe(true);
  });

  it("errors when On Command Run uses a reserved engine name", () => {
    const diags = validateSerializedGraph(
      {
        id: "event-graph",
        kind: "event",
        nodes: [
          {
            id: "run",
            typeId: "flow.event.commandRun",
            position: { x: 0, y: 0 },
            pins: [],
            properties: { commandName: "pause" },
          },
        ],
        edges: [],
      },
      { assetGuid: "g1", graphId: "event-graph" },
    );
    expect(
      diags.some(
        (d) =>
          d.code === "console.reserved_name" &&
          d.severity === "error" &&
          d.nodeId === "run",
      ),
    ).toBe(true);
  });

  it("does not report a pure cycle when Line Trace location feeds back through Make Vector3", () => {
    const beginPins = registry.get("flow.event.beginPlay")!.pins({});
    const tracePins = registry.get("physics.lineTrace")!.pins({});
    const addPins = registry.get("vector.add3")!.pins({});
    const diags = validateSerializedGraph(
      {
        nodes: [
          {
            id: "begin",
            type: "flow.event.beginPlay",
            position: { x: 0, y: 0 },
            data: { __pins: beginPins },
          },
          {
            id: "trace",
            type: "physics.lineTrace",
            position: { x: 200, y: 0 },
            data: { __pins: tracePins },
          },
          {
            id: "add",
            type: "vector.add3",
            position: { x: 200, y: 80 },
            data: { __pins: addPins },
          },
        ],
        edges: [
          {
            id: "exec",
            source: "begin",
            target: "trace",
            sourceHandle: "execOut",
            targetHandle: "execIn",
          },
          {
            id: "hitToAdd",
            source: "trace",
            target: "add",
            sourceHandle: "location",
            targetHandle: "a",
          },
          {
            id: "addToEnd",
            source: "add",
            target: "trace",
            sourceHandle: "out",
            targetHandle: "end",
          },
        ],
      },
      { assetGuid: "g1", graphId: "event-graph" },
    );
    expect(diags.some((d) => d.code === "pure.cycle")).toBe(false);
  });

  it("flags a stale Call Function when the class symbol table is supplied", () => {
    const diags = validateSerializedGraph(
      {
        nodes: [
          {
            id: "begin",
            type: "flow.event.beginPlay",
            position: { x: 0, y: 0 },
            data: {},
          },
          {
            id: "call",
            type: "functions.call",
            position: { x: 200, y: 0 },
            data: { functionName: "Jump", classId: "Hero", implicitSelf: true },
          },
        ],
        edges: [
          {
            id: "e1",
            source: "begin",
            target: "call",
            sourceHandle: "execOut",
            targetHandle: "execIn",
          },
        ],
      },
      {
        assetGuid: "g1",
        graphId: "event-graph",
        classId: "Hero",
        members: [
          { id: "fn-1", name: "Dash", kind: "function", classId: "Hero" },
        ],
      },
    );
    expect(diags.some((d) => d.code === "member.missing_function")).toBe(true);
  });
});

describe("classHierarchyFromParentOf", () => {
  it("treats Hero as a subclass of Actor and BObject", () => {
    const hierarchy = classHierarchyFromParentOf((id) =>
      id === "Hero" ? "Actor" : id === "Actor" ? "BObject" : null,
    );
    expect(hierarchy.isSubclassOf("Hero", "BObject")).toBe(true);
    expect(hierarchy.isSubclassOf("BObject", "Hero")).toBe(false);
  });
});

describe("scriptPinCompatibility", () => {
  it("allows an actor reference into a live object pin of a superclass", () => {
    const rule = scriptPinCompatibility(
      classHierarchyFromParentOf((id) =>
        id === "Hero" ? "Actor" : id === "Actor" ? "BObject" : null,
      ),
    );
    const pin = (
      kind: string,
      classId: string,
    ): { id: string; name: string; kind: "data"; direction: "out"; type: { kind: string; classId: string } } => ({
      id: "p",
      name: "p",
      kind: "data",
      direction: "out",
      type: { kind, classId },
    });
    expect(rule(pin("actorRef", "Hero"), pin("objectRef", "BObject"))).toBe(true);
    expect(rule(pin("objectRef", "Hero"), pin("actorRef", "Actor"))).toBe(false);
  });
});

describe("scriptPaletteNodes", () => {
  it("embeds registry pins so Add Node is not an empty box", () => {
    const nodes = scriptPaletteNodes(registry);
    const begin = nodes.find((node) => node.id === "flow.event.beginPlay");
    expect(begin?.title).toBeTruthy();
    expect(begin?.pins?.some((pin) => pin.id === "execOut")).toBe(true);
    expect(nodes.some((node) => node.id === "flow.function.input")).toBe(false);
    expect(nodes.some((node) => node.id === "flow.function.output")).toBe(false);
    expect(nodes.some((node) => node.id === "flow.event.call")).toBe(false);
    expect(nodes.some((node) => node.id === "functions.call")).toBe(false);
    expect(nodes.some((node) => node.id === "interface.call")).toBe(false);
    expect(nodes.some((node) => node.title === "Call Interface")).toBe(false);
    expect(nodes.some((node) => node.id === "variables.get")).toBe(false);
    expect(nodes.some((node) => node.id === "variables.set")).toBe(false);
    expect(nodes.some((node) => node.id === "variables.getValidated")).toBe(
      false,
    );
    expect(nodes.some((node) => node.id === "navigation.moveTo")).toBe(true);
    const print = nodes.find((node) => node.id === "debug.print");
    expect(print?.defaultData).toMatchObject({ developmentOnly: true });
    const printString = nodes.find((node) => node.id === "debug.printString");
    expect(printString?.title).toBe("Print String");
    expect(printString?.defaultData).toMatchObject({ developmentOnly: true });
    const drawLine = nodes.find((node) => node.id === "debug.drawLine");
    expect(drawLine?.title).toBe("Draw Debug Line");
    expect(drawLine?.defaultData).toMatchObject({ developmentOnly: true });
  });

  it("keeps Is Valid on BObject and Actor palettes", () => {
    for (const parentClass of ["BObject", "Actor"] as const) {
      expect(
        scriptPaletteNodes(registry, { parentClass }).some(
          (node) => node.id === "actor.isValid",
        ),
      ).toBe(true);
    }
  });

  it("lists Play Sound and mixer volume nodes on Actor and Class with volume 1", () => {
    const actor = scriptPaletteNodes(registry, { parentClass: "Actor" });
    const klass = scriptPaletteNodes(registry, { parentClass: "BObject" });
    for (const nodes of [actor, klass]) {
      expect(nodes.some((node) => node.id === "audio.play")).toBe(true);
      expect(nodes.some((node) => node.id === "audio.setChannelVolume")).toBe(
        true,
      );
      expect(nodes.some((node) => node.id === "audio.setGlobalVolume")).toBe(
        true,
      );
      expect(nodes.find((node) => node.id === "audio.play")?.defaultData).toMatchObject({
        "default:volume": 1,
      });
    }
  });

  it("injects Call I rows per ScriptInterface method", () => {
    const nodes = scriptPaletteNodes(registry, {
      scriptInterfaces: [
        {
          guid: "iface-damageable",
          name: "Damageable",
          methods: [
            {
              name: "Apply Damage",
              pins: [
                { name: "amount", typeId: "float", direction: "in" },
                { name: "remaining", typeId: "float", direction: "out" },
              ],
            },
          ],
        },
      ],
    });
    const call = nodes.find(
      (node) => node.id === "interface.call:iface-damageable:Apply Damage",
    );
    expect(call?.title).toBe("Call I Apply Damage");
    expect(call?.nodeType).toBe("interface.call");
    expect(call?.pins?.some((pin) => pin.name === "amount")).toBe(true);
    expect(call?.pins?.some((pin) => pin.name === "remaining")).toBe(true);
    expect(call?.pins?.some((pin) => pin.name === "target")).toBe(true);
    expect(call?.defaultData).toMatchObject({
      interfaceGuid: "iface-damageable",
      method: "Apply Damage",
      implicitSelf: true,
    });
  });

  it("hides behaviour-tree events on Actor class graphs", () => {
    const nodes = scriptPaletteNodes(registry, { parentClass: "Actor" });
    expect(nodes.some((node) => node.id === "bt.event.evaluate")).toBe(false);
    expect(nodes.some((node) => node.id === "bt.finish")).toBe(false);
    expect(nodes.some((node) => node.id === "bt.returnCondition")).toBe(false);
    expect(nodes.some((node) => node.id === "bt.blackboard.get")).toBe(false);
    expect(nodes.some((node) => node.id === "flow.event.beginPlay")).toBe(true);
    expect(nodes.some((node) => node.id === "anim.event.initialize")).toBe(false);
    expect(nodes.some((node) => node.id === "anim.state.justFinished")).toBe(
      false,
    );
    expect(nodes.some((node) => node.id === "anim.actor.jumpToState")).toBe(true);
    expect(nodes.some((node) => node.id === "anim.actor.getVariable")).toBe(true);
  });

  it("shows Animation Object events and hides rule queries", () => {
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "BObject",
      animationGraphHost: "object",
    });
    expect(nodes.some((node) => node.id === "anim.event.initialize")).toBe(true);
    expect(nodes.some((node) => node.id === "anim.event.update")).toBe(true);
    expect(nodes.some((node) => node.id === "anim.actor.jumpToState")).toBe(false);
    expect(nodes.some((node) => node.id === "anim.rule.enterState")).toBe(false);
    expect(nodes.some((node) => node.id === "anim.state.justFinished")).toBe(
      false,
    );
    expect(nodes.some((node) => node.id === "flow.event.beginPlay")).toBe(false);
    expect(nodes.some((node) => node.id === "bt.finish")).toBe(false);
    expect(nodes.some((node) => node.id === "math.add")).toBe(true);
  });

  it("shows transition-rule state queries and hides lifecycle events", () => {
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "BObject",
      animationGraphHost: "rule",
      graph: {
        nodes: [],
        edges: [],
        members: [
          { id: "var-moving", kind: "variable", name: "moving", typeId: "bool" },
        ],
      },
    });
    expect(nodes.some((node) => node.id === "anim.state.justFinished")).toBe(
      true,
    );
    expect(nodes.some((node) => node.id === "math.greaterEqual")).toBe(true);
    expect(nodes.some((node) => node.id === "anim.event.initialize")).toBe(false);
    expect(nodes.some((node) => node.id === "anim.rule.exitState")).toBe(false);
    expect(nodes.some((node) => node.id === "debug.log")).toBe(false);
    expect(nodes.some((node) => node.title === "Get moving")).toBe(true);
    expect(nodes.some((node) => node.title === "Set moving")).toBe(false);
  });

  it("hides Begin Play and Tick on BObject class graphs", () => {
    const nodes = scriptPaletteNodes(registry, { parentClass: "BObject" });
    expect(nodes.some((node) => node.id === "flow.event.beginPlay")).toBe(false);
    expect(nodes.some((node) => node.id === "flow.event.tick")).toBe(false);
    expect(nodes.some((node) => node.id === "flow.event.destroyed")).toBe(false);
  });

  it("shows On Evaluate and hides Begin Play on BTDecorator class graphs", () => {
    const nodes = scriptPaletteNodes(registry, { parentClass: "BTDecorator" });
    expect(nodes.some((node) => node.id === "bt.event.evaluate")).toBe(true);
    expect(nodes.some((node) => node.id === "bt.returnCondition")).toBe(true);
    expect(nodes.some((node) => node.id === "bt.blackboard.get")).toBe(true);
    expect(nodes.some((node) => node.id === "bt.blackboard.set")).toBe(true);
    expect(nodes.some((node) => node.id === "flow.event.beginPlay")).toBe(false);
    expect(nodes.some((node) => node.id === "bt.finish")).toBe(false);
    expect(nodes.some((node) => node.id === "bt.event.activate")).toBe(false);
  });

  it("shows Finish Execute on BTTask class graphs", () => {
    const nodes = scriptPaletteNodes(registry, { parentClass: "BTTask" });
    expect(nodes.some((node) => node.id === "bt.finish")).toBe(true);
    expect(nodes.some((node) => node.id === "bt.blackboard.get")).toBe(true);
    expect(nodes.some((node) => node.id === "bt.event.activate")).toBe(true);
    expect(nodes.some((node) => node.id === "bt.returnCondition")).toBe(false);
    expect(nodes.some((node) => node.id === "flow.event.beginPlay")).toBe(false);
  });

  it("shows editor lifecycle events and hides Begin Play on EditorUtilityObject graphs", () => {
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "EditorUtilityObject",
    });
    expect(nodes.some((node) => node.id === "flow.event.editorBeginPlay")).toBe(
      true,
    );
    expect(nodes.some((node) => node.id === "flow.event.editorStartup")).toBe(
      true,
    );
    expect(nodes.some((node) => node.id === "flow.event.sceneOpen")).toBe(true);
    expect(nodes.some((node) => node.id === "flow.event.beginPlay")).toBe(false);
    expect(nodes.some((node) => node.id === "flow.event.tick")).toBe(false);
    expect(nodes.some((node) => node.id === "bt.event.activate")).toBe(false);
    expect(nodes.some((node) => node.id === "bt.finish")).toBe(false);
  });

  it("hides editor lifecycle events on Actor class graphs", () => {
    const nodes = scriptPaletteNodes(registry, { parentClass: "Actor" });
    expect(nodes.some((node) => node.id === "flow.event.editorStartup")).toBe(
      false,
    );
    expect(nodes.some((node) => node.id === "flow.event.editorShutdown")).toBe(
      false,
    );
    expect(nodes.some((node) => node.id === "flow.event.editorBeginPlay")).toBe(
      false,
    );
    expect(nodes.some((node) => node.id === "flow.event.mouseEnter")).toBe(false);
    expect(nodes.some((node) => node.id === "flow.event.widgetClick")).toBe(
      false,
    );
  });

  it("does not inject editor-only class functions into a runtime Actor palette", () => {
    const parentOf = (id: string) => {
      if (id === "LevelTools") return "EditorUtilityObject";
      if (id === "EditorUtilityObject") return "BObject";
      if (id === "Actor") return "BObject";
      return null;
    };
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "Actor",
      parentOf,
      otherClassGraphs: {
        LevelTools: {
          nodes: [],
          edges: [],
          members: [{ id: "f1", kind: "function", name: "RebuildNav" }],
        },
      },
    });
    expect(
      nodes.some((node) => node.id === "functions.call:LevelTools:RebuildNav"),
    ).toBe(false);
  });

  it("injects editor-only class functions into an EditorUtilityObject palette", () => {
    const parentOf = (id: string) => {
      if (id === "LevelTools") return "EditorUtilityObject";
      if (id === "EditorUtilityObject") return "BObject";
      return null;
    };
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "EditorUtilityObject",
      parentOf,
      otherClassGraphs: {
        LevelTools: {
          nodes: [],
          edges: [],
          members: [{ id: "f1", kind: "function", name: "RebuildNav" }],
        },
      },
    });
    expect(
      nodes.some((node) => node.id === "functions.call:LevelTools:RebuildNav"),
    ).toBe(true);
  });

  it("stamps editorOnly on palette rows for editor-only catalog defs", () => {
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "EditorUtilityObject",
    });
    const editorBegin = nodes.find(
      (node) => node.id === "flow.event.editorBeginPlay",
    );
    expect(editorBegin?.editorOnly).toBe(true);
    expect(editorBegin?.defaultData?.__editorOnly).toBe(true);
  });

  it("injects Call nodes for the class custom events and other open classes", () => {
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "Actor",
      classId: "Hero",
      graph: {
        nodes: [
          {
            id: "evt-1",
            type: "flow.event.custom",
            position: { x: 0, y: 0 },
            data: {
              name: "On Hit",
              pins: [{ name: "amount", typeId: "float", direction: "out" }],
            },
          },
        ],
        edges: [],
        members: [
          {
            id: "evt-1",
            kind: "event",
            name: "On Hit",
            pins: [{ name: "amount", typeId: "float", direction: "out" }],
          },
        ],
      },
      otherClassGraphs: {
        Guard: {
          nodes: [],
          edges: [],
          members: [{ id: "g-1", kind: "event", name: "On Alert" }],
        },
      },
    });
    const local = nodes.find((node) => node.id === "flow.event.call:Hero:On Hit");
    expect(local?.title).toBe("Call On Hit");
    expect(local?.nodeType).toBe("flow.event.call");
    expect(local?.defaultData).toMatchObject({
      name: "On Hit",
      classId: "Hero",
      implicitSelf: true,
    });
    expect(local?.pins?.some((pin) => pin.id === "amount" && pin.direction === "in")).toBe(
      true,
    );
    expect(local?.pins?.some((pin) => pin.id === "target")).toBe(false);
    const other = nodes.find(
      (node) => node.id === "flow.event.call:Guard:On Alert",
    );
    expect(other?.title).toBe("Call On Alert");
    expect(other?.defaultData).toMatchObject({
      name: "On Alert",
      classId: "Guard",
      implicitSelf: false,
    });
    expect(other?.pins?.some((pin) => pin.id === "target")).toBe(true);
  });

  it("marks inherited parent-class custom events as implicit-self Calls", () => {
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "Actor",
      parentOf: (id) => (id === "Hero" ? "Actor" : null),
      classId: "Hero",
      graph: { nodes: [], edges: [], members: [] },
      otherClassGraphs: {
        Actor: {
          nodes: [],
          edges: [],
          members: [{ id: "a-1", kind: "event", name: "On Damage" }],
        },
      },
    });
    const inherited = nodes.find(
      (node) => node.id === "flow.event.call:Actor:On Damage",
    );
    expect(inherited?.defaultData).toMatchObject({
      name: "On Damage",
      classId: "Actor",
      implicitSelf: true,
    });
    expect(inherited?.pins?.some((pin) => pin.id === "target")).toBe(false);
  });

  it("injects Call nodes for class functions and other open classes", () => {
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "Actor",
      classId: "Hero",
      graph: {
        nodes: [],
        edges: [],
        members: [
          {
            id: "fn-1",
            kind: "function",
            name: "Jump",
            pins: [
              { name: "exec", typeId: "exec", direction: "in" },
              { name: "height", typeId: "float", direction: "in" },
              { name: "then", typeId: "exec", direction: "out" },
            ],
          },
        ],
      },
      otherClassGraphs: {
        Guard: {
          nodes: [],
          edges: [],
          members: [{ id: "g-1", kind: "function", name: "Alert" }],
        },
      },
    });
    const local = nodes.find((node) => node.id === "functions.call:Hero:Jump");
    expect(local?.title).toBe("Call Jump");
    expect(local?.nodeType).toBe("functions.call");
    expect(local?.defaultData).toMatchObject({
      functionName: "Jump",
      classId: "Hero",
      implicitSelf: true,
    });
    expect(
      local?.pins?.some((pin) => pin.id === "height" && pin.direction === "in"),
    ).toBe(true);
    expect(local?.pins?.some((pin) => pin.id === "target")).toBe(false);
    const other = nodes.find(
      (node) => node.id === "functions.call:Guard:Alert",
    );
    expect(other?.title).toBe("Call Alert");
    expect(other?.defaultData).toMatchObject({
      functionName: "Alert",
      classId: "Guard",
      implicitSelf: false,
    });
    expect(other?.pins?.some((pin) => pin.id === "target")).toBe(true);
  });

  it("marks Call Function palette rows latent when the Function contains Delay", () => {
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "Actor",
      classId: "Hero",
      graph: {
        nodes: [],
        edges: [],
        members: [{ id: "fn-1", kind: "function", name: "Wait" }],
        functionGraphs: {
          "fn-1": {
            nodes: [
              {
                id: "delay",
                type: "timers.delay",
                position: { x: 0, y: 0 },
                data: { duration: 0.25 },
              },
            ],
            edges: [],
          },
        },
      },
    });
    const wait = nodes.find((node) => node.id === "functions.call:Hero:Wait");
    expect(wait?.latent).toBe(true);
  });

  it("recomputes Call Function __latent from live Function bodies, ignoring a stored false", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "call",
          type: "functions.call",
          position: { x: 0, y: 0 },
          data: {
            functionName: "Wait",
            classId: "Hero",
            implicitSelf: true,
            __latent: false,
            __pins: [
              { id: "exec", name: "exec", direction: "in", kind: "exec", type: { kind: "exec" } },
              { id: "then", name: "then", direction: "out", kind: "exec", type: { kind: "exec" } },
            ],
          },
        },
      ],
      edges: [],
      members: [{ id: "fn-1", kind: "function", name: "Wait" }],
      functionGraphs: {
        "fn-1": {
          nodes: [
            {
              id: "delay",
              type: "timers.delay",
              position: { x: 0, y: 0 },
              data: { duration: 0.25 },
            },
          ],
          edges: [],
        },
      },
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, registry, {
      classId: "Hero",
    });
    expect(hydrated.nodes[0]?.data.__latent).toBe(true);
  });

  it("marks inherited parent-class functions as implicit-self Calls", () => {
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "Actor",
      parentOf: (id) => (id === "Hero" ? "Actor" : null),
      classId: "Hero",
      graph: { nodes: [], edges: [], members: [] },
      otherClassGraphs: {
        Actor: {
          nodes: [],
          edges: [],
          members: [{ id: "a-1", kind: "function", name: "TakeDamage" }],
        },
      },
    });
    const inherited = nodes.find(
      (node) => node.id === "functions.call:Actor:TakeDamage",
    );
    expect(inherited?.defaultData).toMatchObject({
      functionName: "TakeDamage",
      classId: "Actor",
      implicitSelf: true,
    });
    expect(inherited?.pins?.some((pin) => pin.id === "target")).toBe(false);
  });

  it("injects Get/Set nodes for class variables and other open classes", () => {
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "Actor",
      classId: "Hero",
      graph: {
        nodes: [],
        edges: [],
        members: [
          { id: "var-1", kind: "variable", name: "Health", typeId: "bool" },
          {
            id: "var-2",
            kind: "variable",
            name: "Target",
            typeId: "object",
            typeClassId: "Actor",
          },
          {
            id: "loc-1",
            kind: "variable",
            name: "Temp",
            typeId: "float",
            functionId: "fn-1",
          },
        ],
      },
      otherClassGraphs: {
        Guard: {
          nodes: [],
          edges: [],
          members: [{ id: "g-1", kind: "variable", name: "Alert", typeId: "float" }],
        },
      },
    });
    const localGet = nodes.find(
      (node) => node.id === "variables.get:Hero:Health",
    );
    expect(localGet?.title).toBe("Get Health");
    expect(localGet?.nodeType).toBe("variables.get");
    expect(localGet?.defaultData).toMatchObject({
      variableName: "Health",
      variableId: "var-1",
      typeId: "bool",
      classId: "Hero",
      implicitSelf: true,
      scope: "member",
    });
    expect(localGet?.pins?.some((pin) => pin.id === "target")).toBe(false);
    expect(localGet?.pins?.some((pin) => pin.id === "name")).toBe(false);
    const localSet = nodes.find(
      (node) => node.id === "variables.set:Hero:Health",
    );
    expect(localSet?.title).toBe("Set Health");
    expect(localSet?.nodeType).toBe("variables.set");
    expect(nodes.some((node) => node.id === "variables.getValidated:Hero:Health")).toBe(
      false,
    );
    const validated = nodes.find(
      (node) => node.id === "variables.getValidated:Hero:Target",
    );
    expect(validated?.title).toBe("Validated Get Target");
    expect(validated?.nodeType).toBe("variables.getValidated");
    expect(validated?.pins?.some((pin) => pin.id === "isValid")).toBe(true);
    expect(validated?.pins?.some((pin) => pin.id === "notValid")).toBe(true);
    const other = nodes.find(
      (node) => node.id === "variables.get:Guard:Alert",
    );
    expect(other?.defaultData).toMatchObject({
      variableName: "Alert",
      classId: "Guard",
      implicitSelf: false,
    });
    expect(other?.pins?.some((pin) => pin.id === "target")).toBe(true);
    expect(nodes.some((node) => node.id.includes("Temp"))).toBe(false);
  });

  it("injects Get and Validated Get (not Set) for prefab component refs", () => {
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "Actor",
      classId: "Hero",
      graph: {
        nodes: [],
        edges: [],
        components: [createText3DComponent("text-1")],
      },
    });
    const get = nodes.find((node) => node.title === "Get 3D Text");
    expect(get?.nodeType).toBe("variables.get");
    expect(get?.defaultData).toMatchObject({
      variableName: "3D Text",
      typeId: "object",
      typeClassId: "Text3DComponent",
      componentId: "text-1",
      implicitSelf: true,
    });
    expect(
      nodes.some(
        (node) =>
          node.nodeType === "variables.set" &&
          node.defaultData?.componentId === "text-1",
      ),
    ).toBe(false);
    const validated = nodes.find(
      (node) => node.title === "Validated Get 3D Text",
    );
    expect(validated?.nodeType).toBe("variables.getValidated");
    expect(validated?.defaultData).toMatchObject({ componentId: "text-1" });
  });

  it("injects engine component Get/Set and Call Function from the script API catalog", () => {
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "Actor",
      classId: "Hero",
    });
    const getText = nodes.find(
      (node) => node.id === "variables.get:Text3DComponent:Text",
    );
    expect(getText?.title).toBe("Get Text");
    expect(getText?.defaultData).toMatchObject({
      variableName: "Text",
      propertyKey: "text",
      classId: "Text3DComponent",
      implicitSelf: false,
    });
    expect(getText?.pins?.some((pin) => pin.id === "target")).toBe(true);
    const setTextVar = nodes.find(
      (node) => node.id === "variables.set:Text3DComponent:Text",
    );
    expect(setTextVar?.defaultData).toMatchObject({ propertyKey: "text" });
    const callSetText = nodes.find(
      (node) => node.id === "functions.call:Text3DComponent:Set Text",
    );
    expect(callSetText?.title).toBe("Call Set Text");
    expect(callSetText?.defaultData).toMatchObject({
      functionName: "Set Text",
      runtime: "setText",
      classId: "Text3DComponent",
      implicitSelf: false,
    });
  });

  it("injects function-local Get/Set only when that function graph is open", () => {
    const graph = {
      nodes: [],
      edges: [],
      members: [
        { id: "fn-1", kind: "function" as const, name: "Jump" },
        {
          id: "loc-1",
          kind: "variable" as const,
          name: "Temp",
          typeId: "int",
          functionId: "fn-1",
        },
      ],
    };
    const eventNodes = scriptPaletteNodes(registry, {
      parentClass: "Actor",
      classId: "Hero",
      graph,
    });
    expect(
      eventNodes.some((node) => node.id === "variables.get:Hero:Temp"),
    ).toBe(false);
    const functionNodes = scriptPaletteNodes(registry, {
      parentClass: "Actor",
      classId: "Hero",
      graph,
      activeFunctionId: "fn-1",
    });
    const localGet = functionNodes.find(
      (node) => node.id === "variables.get:Hero:Temp",
    );
    expect(localGet?.title).toBe("Get Temp");
    expect(localGet?.defaultData).toMatchObject({
      scope: "local",
      functionId: "fn-1",
      typeId: "int",
      implicitSelf: true,
    });
  });

  it("regenerates function Input pins when the signature adds a data pin", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "in",
          type: "flow.function.input",
          position: { x: 0, y: 0 },
          data: {
            pins: [
              { name: "exec", typeId: "exec", direction: "in" },
              { name: "height", typeId: "float", direction: "in" },
              { name: "then", typeId: "exec", direction: "out" },
            ],
            __pins: [
              {
                id: "exec",
                name: "exec",
                kind: "exec",
                direction: "out",
                type: { kind: "exec" },
              },
            ],
          },
        },
      ],
      edges: [],
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, registry);
    const pins = hydrated.nodes[0]?.data.__pins as Array<{
      id: string;
      direction: string;
    }>;
    expect(pins?.map((pin) => ({ id: pin.id, direction: pin.direction }))).toEqual(
      [
        { id: "exec", direction: "out" },
        { id: "height", direction: "out" },
      ],
    );
  });

  it("regenerates function Output pins when the signature drops a data pin", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "out",
          type: "flow.function.output",
          position: { x: 0, y: 0 },
          data: {
            pins: [
              { name: "exec", typeId: "exec", direction: "in" },
              { name: "then", typeId: "exec", direction: "out" },
            ],
            __pins: [
              {
                id: "then",
                name: "then",
                kind: "exec",
                direction: "in",
                type: { kind: "exec" },
              },
              {
                id: "result",
                name: "result",
                kind: "data",
                direction: "in",
                type: { kind: "float" },
              },
            ],
          },
        },
      ],
      edges: [],
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, registry);
    const pins = hydrated.nodes[0]?.data.__pins as Array<{
      id: string;
      direction: string;
    }>;
    expect(pins?.map((pin) => ({ id: pin.id, direction: pin.direction }))).toEqual(
      [{ id: "then", direction: "in" }],
    );
  });

  it("regenerates Get Variable pins so type and Target stay in sync", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "get",
          type: "variables.get",
          position: { x: 0, y: 0 },
          data: {
            variableName: "Health",
            typeId: "bool",
            implicitSelf: true,
            __pins: [
              {
                id: "name",
                name: "name",
                kind: "data",
                direction: "in",
                type: { kind: "string" },
              },
            ],
          },
        },
      ],
      edges: [],
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, registry);
    const pins = hydrated.nodes[0]?.data.__pins as Array<{ id: string }>;
    expect(pins?.some((pin) => pin.id === "name")).toBe(false);
    expect(pins?.some((pin) => pin.id === "value")).toBe(true);
  });

  it("refreshes Make Structure pins from the live schema and keeps field names", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "make",
          type: "struct.make",
          position: { x: 0, y: 0 },
          data: {
            structGuid: "struct-stats",
            fields: [{ name: "Mana", typeId: "float" }],
            __pins: [
              {
                id: "Mana",
                name: "Mana",
                kind: "data",
                direction: "in",
                type: { kind: "float" },
              },
            ],
          },
        },
      ],
      edges: [],
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, registry, {
      structs: {
        "struct-stats": {
          name: "Stats",
          fields: [
            { name: "Health", typeId: "int" },
            { name: "Label", typeId: "string" },
          ],
        },
      },
    });
    expect(hydrated.nodes[0]?.data.title).toBe("Make Stats");
    const pins = hydrated.nodes[0]?.data.__pins as Array<{ id: string }>;
    expect(pins?.map((pin) => pin.id)).toEqual(["Health", "Label", "out"]);
  });

  it("keeps Make Structure wires by field name and drops renamed fields", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "get",
          type: "debug.log",
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: "make",
          type: "struct.make",
          position: { x: 80, y: 0 },
          data: {
            structGuid: "struct-stats",
            fields: [
              { name: "Health", typeId: "int" },
              { name: "Mana", typeId: "float" },
            ],
          },
        },
      ],
      edges: [
        {
          id: "keep-health",
          source: "get",
          target: "make",
          sourceHandle: "message",
          targetHandle: "Health",
        },
        {
          id: "drop-mana",
          source: "get",
          target: "make",
          sourceHandle: "message",
          targetHandle: "Mana",
        },
      ],
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, registry, {
      structs: {
        "struct-stats": {
          name: "Stats",
          fields: [
            { name: "Health", typeId: "int" },
            { name: "Armor", typeId: "float" },
          ],
        },
      },
    });
    const pins = hydrated.nodes[1]?.data.__pins as Array<{ id: string }>;
    expect(pins?.map((pin) => pin.id)).toEqual(["Health", "Armor", "out"]);
    expect(hydrated.edges.map((edge) => edge.id)).toEqual(["keep-health"]);
    expect(hydrated.edges[0]).toMatchObject({
      target: "make",
      targetHandle: "Health",
    });
  });

  it("keeps Switch case wires by member name and drops renamed members", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "sw",
          type: "enum.switch",
          position: { x: 0, y: 0 },
          data: {
            enumGuid: "enum-team",
            members: [
              { name: "Red", value: 1 },
              { name: "Green", value: 2 },
            ],
          },
        },
        {
          id: "red",
          type: "debug.log",
          position: { x: 80, y: 0 },
          data: {},
        },
        {
          id: "green",
          type: "debug.log",
          position: { x: 80, y: 40 },
          data: {},
        },
      ],
      edges: [
        {
          id: "keep-red",
          source: "sw",
          target: "red",
          sourceHandle: "case:Red",
          targetHandle: "execIn",
        },
        {
          id: "drop-green",
          source: "sw",
          target: "green",
          sourceHandle: "case:Green",
          targetHandle: "execIn",
        },
      ],
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, registry, {
      enums: {
        "enum-team": {
          name: "Team",
          members: [
            { name: "Red", value: 1 },
            { name: "Blue", value: 2 },
          ],
        },
      },
    });
    expect(hydrated.edges.map((edge) => edge.id)).toEqual(["keep-red"]);
  });

  it("copies a wired enum guid onto Switch and rebuilds member exec pins", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "make",
          type: "enum.make",
          position: { x: 0, y: 0 },
          data: {
            enumGuid: "enum-team",
            members: [
              { name: "Red", value: 1 },
              { name: "Blue", value: 2 },
            ],
            value: "Red",
          },
        },
        {
          id: "sw",
          type: "enum.switch",
          position: { x: 80, y: 0 },
          data: {
            __pins: [
              {
                id: "execIn",
                name: "exec",
                kind: "exec",
                direction: "in",
                type: { kind: "exec" },
              },
            ],
          },
        },
      ],
      edges: [
        {
          id: "e1",
          source: "make",
          target: "sw",
          sourceHandle: "out",
          targetHandle: "value",
        },
      ],
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, registry, {
      enums: {
        "enum-team": {
          name: "Team",
          members: [
            { name: "Red", value: 1 },
            { name: "Blue", value: 2 },
          ],
        },
      },
    });
    expect(hydrated.nodes[1]?.data.enumGuid).toBe("enum-team");
    expect(hydrated.nodes[1]?.data.title).toBe("Switch on Team");
    const pins = hydrated.nodes[1]?.data.__pins as Array<{ id: string }>;
    expect(pins?.map((pin) => pin.id)).toEqual([
      "execIn",
      "value",
      "case:Red",
      "case:Blue",
      "default",
    ]);
  });

  it("keeps the last Switch enum guid after disconnect", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "sw",
          type: "enum.switch",
          position: { x: 0, y: 0 },
          data: {
            enumGuid: "enum-team",
            members: [{ name: "Red", value: 1 }],
          },
        },
      ],
      edges: [],
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, registry, {
      enums: {
        "enum-team": {
          name: "Team",
          members: [{ name: "Red", value: 1 }],
        },
      },
    });
    expect(hydrated.nodes[0]?.data.enumGuid).toBe("enum-team");
  });

  it("materializes Make Structure pins from the live schema instead of stale __pins", () => {
    const logic = materializeLogicGraph(
      {
        nodes: [
          {
            id: "make",
            type: "struct.make",
            position: { x: 0, y: 0 },
            data: {
              structGuid: "struct-stats",
              fields: [{ name: "Mana", typeId: "float" }],
              __pins: [
                {
                  id: "Mana",
                  name: "Mana",
                  kind: "data",
                  direction: "in",
                  type: { kind: "float" },
                },
              ],
            },
          },
        ],
        edges: [],
      },
      "main",
      "event",
      {
        structs: {
          "struct-stats": {
            name: "Stats",
            fields: [
              { name: "Health", typeId: "int" },
              { name: "Label", typeId: "string" },
            ],
          },
        },
      },
    );
    expect(logic.nodes[0]?.pins.map((pin) => pin.id)).toEqual([
      "Health",
      "Label",
      "out",
    ]);
  });

  const libraryParentOf = (id: string) => {
    if (id === "MathLib") return "FunctionLibrary";
    if (id === "FunctionLibrary") return "BObject";
    if (id === "EditorMath") return "EditorFunctionLibrary";
    if (id === "EditorFunctionLibrary") return "FunctionLibrary";
    if (id === "EditorUtilityObject") return "BObject";
    if (id === "Actor") return "BObject";
    return null;
  };

  const addPins = [
    { name: "exec", typeId: "exec", direction: "in" as const },
    { name: "a", typeId: "float", direction: "in" as const },
    { name: "b", typeId: "float", direction: "in" as const },
    { name: "then", typeId: "exec", direction: "out" as const },
    { name: "result", typeId: "float", direction: "out" as const },
  ];

  it("injects static Call Function rows from functionLibraries on an Actor host", () => {
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "Actor",
      parentOf: libraryParentOf,
      classId: "Hero",
      functionLibraries: [
        {
          classId: "MathLib",
          parentClass: "FunctionLibrary",
          functions: [{ name: "Add", pins: addPins }],
        },
      ],
    });
    const call = nodes.find((node) => node.id === "functions.call:MathLib:Add");
    expect(call?.title).toBe("Call Add");
    expect(call?.defaultData).toMatchObject({
      functionName: "Add",
      classId: "MathLib",
      implicitSelf: true,
      static: true,
    });
    expect(call?.pins?.some((pin) => pin.id === "target")).toBe(false);
    expect(
      call?.pins?.some((pin) => pin.id === "a" && pin.direction === "in"),
    ).toBe(true);
  });

  it("shows FunctionLibrary calls on EditorUtilityObject hosts", () => {
    const libraries = [
      {
        classId: "MathLib",
        parentClass: "FunctionLibrary",
        functions: [{ name: "Add", pins: addPins }],
      },
    ];
    const utility = scriptPaletteNodes(registry, {
      parentClass: "EditorUtilityObject",
      parentOf: libraryParentOf,
      functionLibraries: libraries,
    });
    expect(
      utility.some((node) => node.id === "functions.call:MathLib:Add"),
    ).toBe(true);
  });

  it("hides EditorFunctionLibrary calls on Actor hosts", () => {
    const libraries = [
      {
        classId: "EditorMath",
        parentClass: "EditorFunctionLibrary",
        functions: [{ name: "Snap", pins: addPins }],
      },
    ];
    const actor = scriptPaletteNodes(registry, {
      parentClass: "Actor",
      parentOf: libraryParentOf,
      functionLibraries: libraries,
    });
    expect(
      actor.some((node) => node.id === "functions.call:EditorMath:Snap"),
    ).toBe(false);
  });

  it("shows EditorFunctionLibrary calls on editor graph hosts", () => {
    const libraries = [
      {
        classId: "EditorMath",
        parentClass: "EditorFunctionLibrary",
        functions: [{ name: "Snap", pins: addPins }],
      },
    ];
    const hosts = [
      scriptPaletteNodes(registry, {
        parentClass: "EditorUtilityObject",
        parentOf: libraryParentOf,
        functionLibraries: libraries,
      }),
      scriptPaletteNodes(registry, {
        parentClass: "EditorFunctionLibrary",
        parentOf: libraryParentOf,
        functionLibraries: libraries,
      }),
    ];
    for (const nodes of hosts) {
      expect(
        nodes.some((node) => node.id === "functions.call:EditorMath:Snap"),
      ).toBe(true);
    }
  });

  it("emits a static Call (no Target) for otherClassGraphs FunctionLibrary ancestry", () => {
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "Actor",
      parentOf: libraryParentOf,
      classId: "Hero",
      otherClassGraphs: {
        MathLib: {
          nodes: [],
          edges: [],
          members: [{ id: "fn-1", kind: "function", name: "Add", pins: addPins }],
        },
      },
    });
    const call = nodes.find((node) => node.id === "functions.call:MathLib:Add");
    expect(call?.defaultData).toMatchObject({
      functionName: "Add",
      classId: "MathLib",
      implicitSelf: true,
      static: true,
    });
    expect(call?.pins?.some((pin) => pin.id === "target")).toBe(false);
  });

  it("does not duplicate a library function already added from otherClassGraphs", () => {
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "Actor",
      parentOf: libraryParentOf,
      classId: "Hero",
      otherClassGraphs: {
        MathLib: {
          nodes: [],
          edges: [],
          members: [{ id: "fn-1", kind: "function", name: "Add", pins: addPins }],
        },
      },
      functionLibraries: [
        {
          classId: "MathLib",
          parentClass: "FunctionLibrary",
          functions: [{ name: "Add", pins: addPins }],
        },
      ],
    });
    expect(
      nodes.filter((node) => node.id === "functions.call:MathLib:Add"),
    ).toHaveLength(1);
  });

  it("hides generic Cast catalog ids and injects Cast to <Class> rows", () => {
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "Actor",
      classId: "Hero",
      parentOf: (id) => (id === "Hero" ? "Actor" : undefined),
      otherClassGraphs: {
        Hero: { nodes: [], edges: [] },
      },
    });
    expect(nodes.some((node) => node.id === "casting.cast")).toBe(false);
    expect(nodes.some((node) => node.id === "casting.castActor")).toBe(false);
    const actorCast = nodes.find((node) => node.id === "casting.cast:Actor");
    expect(actorCast?.title).toBe("Cast to Actor");
    expect(actorCast?.pure).not.toBe(true);
    expect(actorCast?.pins?.some((pin) => pin.id === "execIn")).toBe(true);
    expect(actorCast?.pins?.some((pin) => pin.id === "execOut")).toBe(true);
    expect(actorCast?.defaultData).toMatchObject({
      defaultClassId: "Actor",
      "default:class": "Actor",
      resultKind: "actorRef",
    });
    expect(
      actorCast?.pins?.some(
        (pin) =>
          pin.id === "result" &&
          (pin.type as { kind?: string; classId?: string }).kind === "actorRef" &&
          (pin.type as { classId?: string }).classId === "Actor",
      ),
    ).toBe(true);
    const heroCast = nodes.find((node) => node.id === "casting.cast:Hero");
    expect(heroCast?.title).toBe("Cast to Hero");
    expect(heroCast?.defaultData).toMatchObject({
      defaultClassId: "Hero",
      resultKind: "actorRef",
    });
    const giCast = nodes.find((node) => node.id === "casting.cast:GameInstance");
    expect(giCast?.title).toBe("Cast to GameInstance");
    expect(giCast?.defaultData).toMatchObject({
      resultKind: "objectRef",
    });
  });

  it("does not include removed UserInterface engine classes in the known-class set", () => {
    const ids = knownClassIdSet(() => null, []);
    expect(ids.has("UserInterface")).toBe(false);
    expect(ids.has("Widget")).toBe(false);
    expect(ids.has("ButtonWidget")).toBe(false);
    expect(ids.has("ImageWidget")).toBe(false);
    expect(ids.has("MaterialWidget")).toBe(false);
  });

  it("hides native and editor lifecycle events on FunctionLibrary palettes", () => {
    const library = scriptPaletteNodes(registry, {
      parentClass: "FunctionLibrary",
    });
    const editorLibrary = scriptPaletteNodes(registry, {
      parentClass: "EditorFunctionLibrary",
      parentOf: libraryParentOf,
    });
    for (const nodes of [library, editorLibrary]) {
      expect(nodes.some((node) => node.id === "flow.event.beginPlay")).toBe(
        false,
      );
      expect(nodes.some((node) => node.id === "flow.event.tick")).toBe(false);
      expect(nodes.some((node) => node.id === "flow.event.editorStartup")).toBe(
        false,
      );
      expect(nodes.some((node) => node.id === "flow.event.sceneOpen")).toBe(
        false,
      );
      expect(nodes.some((node) => node.id === "debug.log")).toBe(true);
    }
  });

  it("hides generic Make/Break Structure and injects typed rows", () => {
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "Actor",
      structures: [
        {
          guid: "struct-stats",
          name: "Stats",
          fields: [
            { name: "Health", typeId: "int" },
            { name: "Label", typeId: "string" },
          ],
        },
      ],
    });
    expect(nodes.some((node) => node.id === "struct.make")).toBe(false);
    expect(nodes.some((node) => node.id === "struct.break")).toBe(false);
    expect(nodes.some((node) => node.id === "struct.makeRotator")).toBe(true);
    const make = nodes.find((node) => node.id === "struct.make:struct-stats");
    expect(make?.title).toBe("Make Stats");
    expect(make?.nodeType).toBe("struct.make");
    expect(make?.defaultData).toMatchObject({
      structGuid: "struct-stats",
    });
    expect(
      make?.pins?.some(
        (pin) =>
          pin.id === "out" &&
          (pin.type as { kind?: string; guid?: string }).kind === "structRef" &&
          (pin.type as { guid?: string }).guid === "struct-stats",
      ),
    ).toBe(true);
    expect(nodes.some((node) => node.id === "struct.break:struct-stats")).toBe(
      true,
    );
  });

  it("keeps generic enum catalog nodes and injects typed Make/Equal/Switch rows", () => {
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "Actor",
      enums: [
        {
          guid: "enum-team",
          name: "Team",
          members: [
            { name: "Red", value: 1 },
            { name: "Blue", value: 2 },
          ],
        },
      ],
    });
    expect(nodes.some((node) => node.id === "enum.make")).toBe(true);
    const make = nodes.find((node) => node.id === "enum.make:enum-team");
    expect(make?.title).toBe("Make Team");
    expect(make?.defaultData).toMatchObject({
      enumGuid: "enum-team",
      value: "Red",
    });
    expect(nodes.some((node) => node.id === "enum.switch:enum-team")).toBe(true);
    expect(nodes.some((node) => node.id === "enum.equals:enum-team")).toBe(true);
    expect(nodes.some((node) => node.id === "enum.select")).toBe(true);
    const select = nodes.find((node) => node.id === "enum.select:enum-team");
    expect(select?.title).toBe("Select Team");
    expect(select?.nodeType).toBe("enum.select");
    expect(select?.defaultData).toMatchObject({
      enumGuid: "enum-team",
      "default:index": "Red",
    });
  });

  it("seeds Format String palette with default {input}", () => {
    const nodes = scriptPaletteNodes(registry, { parentClass: "Actor" });
    const format = nodes.find((node) => node.id === "string.format");
    expect(format?.title).toBe("Format String");
    expect(format?.defaultData).toMatchObject({
      "default:format": "{input}",
    });
    expect(
      format?.pins?.some(
        (pin) => pin.id === "arg:input" || pin.name === "input",
      ),
    ).toBe(true);
    expect(nodes.some((node) => node.id === "select.bool")).toBe(true);
    expect(nodes.some((node) => node.id === "select.float")).toBe(true);
  });

  it("passes typeClassId onto Get/Set palette rows", () => {
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "Actor",
      classId: "Hero",
      graph: {
        nodes: [],
        edges: [],
        members: [
          {
            id: "var-1",
            kind: "variable",
            name: "Stats",
            typeId: "struct",
            typeClassId: "struct-stats",
          },
        ],
      },
    });
    const get = nodes.find((node) => node.id === "variables.get:Hero:Stats");
    expect(get?.defaultData).toMatchObject({
      typeId: "struct",
      typeClassId: "struct-stats",
    });
    expect(
      get?.pins?.some(
        (pin) =>
          pin.id === "value" &&
          (pin.type as { kind?: string; guid?: string }).guid === "struct-stats",
      ),
    ).toBe(true);
  });

  it("stamps Array container onto Get palette pins", () => {
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "Actor",
      classId: "Hero",
      graph: {
        nodes: [],
        edges: [],
        members: [
          {
            id: "var-1",
            kind: "variable",
            name: "Hits",
            typeId: "rotator",
            container: "array",
          },
        ],
      },
    });
    const get = nodes.find((node) => node.id === "variables.get:Hero:Hits");
    expect(get?.defaultData).toMatchObject({
      typeId: "rotator",
      container: "array",
    });
    expect(
      get?.pins?.some(
        (pin) =>
          pin.id === "value" && (pin.type as { kind?: string }).kind === "array",
      ),
    ).toBe(true);
  });
});

describe("ScriptPaletteCache", () => {
  const libraryParentOf = (id: string) => {
    if (id.startsWith("Class")) return "Actor";
    if (id === "MathLib") return "FunctionLibrary";
    if (id === "FunctionLibrary") return "BObject";
    if (id === "Hero") return "Actor";
    if (id === "Actor") return "BObject";
    return null;
  };

  const addPins = [
    { name: "exec", typeId: "exec", direction: "in" as const },
    { name: "a", typeId: "float", direction: "in" as const },
    { name: "b", typeId: "float", direction: "in" as const },
    { name: "then", typeId: "exec", direction: "out" as const },
    { name: "result", typeId: "float", direction: "out" as const },
  ];

  const thousandClasses = Object.fromEntries(
    Array.from({ length: 1000 }, (_, index) => [
      `Class${index}`,
      { nodes: [], edges: [] },
    ]),
  ) as Record<string, SerializedGraph>;

  const members = [
    {
      id: "fn-foo",
      kind: "function" as const,
      name: "Foo",
    },
  ];

  function paletteOptions(graph: SerializedGraph) {
    return {
      parentClass: "Actor",
      classId: "Hero",
      parentOf: libraryParentOf,
      graph,
      otherClassGraphs: thousandClasses,
      functionLibraries: [
        {
          classId: "MathLib",
          parentClass: "FunctionLibrary",
          functions: [{ name: "Add", pins: addPins }],
        },
      ],
    };
  }

  it("omits Cast-to-Class and FL Call rows when injectors are deferred", () => {
    const nodes = scriptPaletteNodes(
      registry,
      paletteOptions({
        nodes: [],
        edges: [],
        members,
      }),
      { injectors: false },
    );
    expect(nodes.some((node) => node.id === "debug.log")).toBe(true);
    expect(nodes.some((node) => node.id.startsWith("casting.cast:"))).toBe(
      false,
    );
    expect(nodes.some((node) => node.id === "functions.call:MathLib:Add")).toBe(
      false,
    );
  });

  it("does not rebuild a ~1000-class injector set on an unrelated graph data edit", () => {
    const cache = new ScriptPaletteCache();
    const first = scriptPaletteNodes(
      registry,
      paletteOptions({
        nodes: [
          {
            id: "log-1",
            type: "debug.log",
            position: { x: 0, y: 0 },
            data: { message: "hello" },
          },
        ],
        edges: [],
        members,
      }),
      { injectors: true, cache },
    );
    expect(cache.injectors).toBe(1);
    expect(first.some((node) => node.id === "casting.cast:Actor")).toBe(true);
    expect(first.some((node) => node.id === "casting.cast:Class999")).toBe(
      true,
    );
    expect(first.some((node) => node.id === "functions.call:MathLib:Add")).toBe(
      true,
    );

    const second = scriptPaletteNodes(
      registry,
      paletteOptions({
        nodes: [
          {
            id: "log-1",
            type: "debug.log",
            position: { x: 40, y: 80 },
            data: { message: "changed" },
          },
        ],
        edges: [],
        members,
      }),
      { injectors: true, cache },
    );
    expect(cache.injectors).toBe(1);
    expect(second).toBe(first);
  });
});

describe("Format String and Select hydration", () => {
  it("regenerates Format String argument pins and prunes them when Format is wired", () => {
    const inputPin = formatArgPinId("input");
    const countPin = formatArgPinId("count");
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "lit",
          type: "literal.makeString",
          position: { x: 0, y: 0 },
          data: { "default:in": "wired" },
        },
        {
          id: "fmt",
          type: "string.format",
          position: { x: 80, y: 0 },
          data: {
            "default:format": "{input} {count}",
            __pins: [
              {
                id: "format",
                name: "Format",
                kind: "data",
                direction: "in",
                type: { kind: "string" },
              },
              {
                id: inputPin,
                name: "input",
                kind: "data",
                direction: "in",
                type: { kind: "boxedWildcard" },
              },
              {
                id: countPin,
                name: "count",
                kind: "data",
                direction: "in",
                type: { kind: "boxedWildcard" },
              },
              {
                id: "out",
                name: "Out",
                kind: "data",
                direction: "out",
                type: { kind: "string" },
              },
            ],
          },
        },
        {
          id: "src",
          type: "literal.makeInt",
          position: { x: 0, y: 40 },
          data: { "default:in": 3 },
        },
      ],
      edges: [
        {
          id: "arg-edge",
          source: "src",
          target: "fmt",
          sourceHandle: "out",
          targetHandle: countPin,
        },
        {
          id: "format-edge",
          source: "lit",
          target: "fmt",
          sourceHandle: "out",
          targetHandle: "format",
        },
      ],
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, registry);
    const pins = hydrated.nodes.find((node) => node.id === "fmt")?.data
      .__pins as Array<{ id: string }>;
    expect(pins?.map((pin) => pin.id)).toEqual(["format", "out"]);
    expect(hydrated.nodes.find((node) => node.id === "fmt")?.data.formatWired).toBe(
      true,
    );
    expect(hydrated.nodes.find((node) => node.id === "fmt")?.data["default:format"]).toBe(
      "{input} {count}",
    );
    expect(hydrated.edges.map((edge) => edge.id)).toEqual(["format-edge"]);
  });

  it("restores Format String argument pins from the retained default after disconnect", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "fmt",
          type: "string.format",
          position: { x: 0, y: 0 },
          data: {
            "default:format": "{player}",
            formatWired: true,
            __pins: [
              {
                id: "format",
                name: "Format",
                kind: "data",
                direction: "in",
                type: { kind: "string" },
              },
              {
                id: "out",
                name: "Out",
                kind: "data",
                direction: "out",
                type: { kind: "string" },
              },
            ],
          },
        },
      ],
      edges: [],
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, registry);
    const pins = hydrated.nodes[0]?.data.__pins as Array<{ id: string; name: string }>;
    expect(hydrated.nodes[0]?.data.formatWired).toBe(false);
    expect(pins?.map((pin) => pin.id)).toEqual([
      "format",
      formatArgPinId("player"),
      "out",
    ]);
  });

  it("hydrates enum Select members, binds index default, and drops stale option wires", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "sel",
          type: "enum.select",
          position: { x: 0, y: 0 },
          data: {
            enumGuid: "enum-team",
            members: [
              { name: "Red", value: 1 },
              { name: "Green", value: 2 },
            ],
            "default:index": "Green",
          },
        },
        {
          id: "lit",
          type: "literal.makeFloat",
          position: { x: 0, y: 40 },
          data: { "default:in": 1 },
        },
        {
          id: "sink",
          type: "literal.makeFloat",
          position: { x: 80, y: 40 },
          data: {},
        },
      ],
      edges: [
        {
          id: "keep",
          source: "lit",
          target: "sel",
          sourceHandle: "out",
          targetHandle: selectOptionPinId("Red"),
        },
        {
          id: "drop",
          source: "lit",
          target: "sel",
          sourceHandle: "out",
          targetHandle: selectOptionPinId("Green"),
        },
        {
          id: "out-edge",
          source: "sel",
          target: "sink",
          sourceHandle: "out",
          targetHandle: "in",
        },
      ],
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, registry, {
      enums: {
        "enum-team": {
          name: "Team",
          members: [
            { name: "Red", value: 1 },
            { name: "Blue", value: 2 },
          ],
        },
      },
    });
    const data = hydrated.nodes.find((node) => node.id === "sel")?.data;
    expect(data?.title).toBe("Select Team");
    expect(data?.["default:index"]).toBe("Red");
    const pins = data?.__pins as Array<{ id: string }>;
    expect(pins?.map((pin) => pin.id)).toEqual([
      "index",
      selectOptionPinId("Red"),
      selectOptionPinId("Blue"),
      "out",
    ]);
    expect(hydrated.edges.map((edge) => edge.id).sort()).toEqual([
      "keep",
      "out-edge",
    ]);
  });
});

describe("container constructor hydration", () => {
  it.each([
    {
      type: "array.make",
      count: 2,
      stalePin: "item2",
      expectedPins: ["item0", "item1", "out"],
    },
    {
      type: "map.make",
      count: 2,
      stalePin: "key2",
      expectedPins: ["key0", "value0", "key1", "value1", "out"],
    },
  ])("regenerates $type pins and prunes removed pair edges", ({
    type,
    count,
    stalePin,
    expectedPins,
  }) => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "make",
          type,
          position: { x: 0, y: 0 },
          data: {
            count,
            __pins: [
              { id: "item0", name: "Item 0", direction: "in", kind: "data", type: { kind: "float" } },
              { id: stalePin, name: stalePin, direction: "in", kind: "data", type: { kind: "float" } },
              { id: "out", name: "Out", direction: "out", kind: "data", type: { kind: "array", element: { kind: "float" } } },
            ],
          },
        },
        {
          id: "literal",
          type: "literal.makeFloat",
          position: { x: 0, y: 40 },
          data: { "default:in": 1 },
        },
      ],
      edges: [
        {
          id: "keep",
          source: "literal",
          target: "make",
          sourceHandle: "out",
          targetHandle: type === "map.make" ? "key0" : "item0",
        },
        {
          id: "drop",
          source: "literal",
          target: "make",
          sourceHandle: "out",
          targetHandle: stalePin,
        },
      ],
    };

    const hydrated = hydrateSerializedGraphForEditor(graph, registry);
    const pins = hydrated.nodes[0]?.data.__pins as Array<{ id: string }>;
    expect(pins.map((pin) => pin.id)).toEqual(expectedPins);
    expect(hydrated.edges.map((edge) => edge.id)).toEqual(["keep"]);
  });
});

describe("flow switch hydrate", () => {
  it("regenerates Switch on Int case pins, keeps matching wires, and prunes removed ones", () => {
    const keepPin = "case:1";
    const dropPin = "case:9";
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "sw",
          type: "flow.switchInt",
          position: { x: 0, y: 0 },
          data: {
            cases: [1, "", 1, 2],
            __pins: [
              {
                id: "execIn",
                name: "exec",
                kind: "exec",
                direction: "in",
                type: { kind: "exec" },
              },
              {
                id: keepPin,
                name: "1",
                kind: "exec",
                direction: "out",
                type: { kind: "exec" },
              },
              {
                id: dropPin,
                name: "9",
                kind: "exec",
                direction: "out",
                type: { kind: "exec" },
              },
            ],
          },
        },
        {
          id: "one",
          type: "debug.log",
          position: { x: 80, y: 0 },
          data: {},
        },
        {
          id: "nine",
          type: "debug.log",
          position: { x: 80, y: 40 },
          data: {},
        },
      ],
      edges: [
        {
          id: "keep",
          source: "sw",
          target: "one",
          sourceHandle: keepPin,
          targetHandle: "execIn",
        },
        {
          id: "drop",
          source: "sw",
          target: "nine",
          sourceHandle: dropPin,
          targetHandle: "execIn",
        },
      ],
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, registry);
    expect(hydrated.nodes[0]?.data.cases).toEqual([1, 2]);
    const pins = hydrated.nodes[0]?.data.__pins as Array<{ id: string }>;
    expect(pins.map((pin) => pin.id)).toEqual([
      "execIn",
      "value",
      "case:1",
      "case:2",
      "default",
    ]);
    expect(hydrated.edges.map((edge) => edge.id)).toEqual(["keep"]);
  });

  it("regenerates Switch on String encoded case pins and materializes the same shape", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "sw",
          type: "flow.switchString",
          position: { x: 0, y: 0 },
          data: {
            cases: ["idle", "", "a/b", "idle"],
          },
        },
      ],
      edges: [],
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, registry);
    expect(hydrated.nodes[0]?.data.cases).toEqual(["idle", "a/b"]);
    const pins = hydrated.nodes[0]?.data.__pins as Array<{ id: string }>;
    expect(pins.map((pin) => pin.id)).toEqual([
      "execIn",
      "value",
      "case:idle",
      "case:a%2Fb",
      "default",
    ]);

    const logic = materializeLogicGraph(hydrated, "g");
    expect(logic.nodes[0]?.properties.cases).toEqual(["idle", "a/b"]);
    expect(logic.nodes[0]?.pins.map((pin) => pin.id)).toEqual([
      "execIn",
      "value",
      "case:idle",
      "case:a%2Fb",
      "default",
    ]);
  });
});

describe("validateSerializedGraph material domains", () => {
  it("errors when Register Scene Layer Post-processing uses a surface Material", () => {
    const pins = registry.get("scene-layer.registerPostProcess")!.pins({});
    const diags = validateSerializedGraph(
      {
        id: "event-graph",
        kind: "event",
        nodes: [
          {
            id: "reg",
            typeId: "scene-layer.registerPostProcess",
            position: { x: 0, y: 0 },
            pins,
            properties: { "default:material": "bloom" },
          },
        ],
        edges: [],
      },
      {
        assetGuid: "g1",
        graphId: "event-graph",
        materialDomains: { bloom: "surface" },
      },
    );
    expect(diags.some((d) => d.code === "scene-layer.postProcessDomain")).toBe(
      true,
    );
  });

  it("accepts a postProcess Material on Register Scene Layer Post-processing", () => {
    const pins = registry.get("scene-layer.registerPostProcess")!.pins({});
    const diags = validateSerializedGraph(
      {
        id: "event-graph",
        kind: "event",
        nodes: [
          {
            id: "reg",
            typeId: "scene-layer.registerPostProcess",
            position: { x: 0, y: 0 },
            pins,
            properties: { "default:material": "bloom" },
          },
        ],
        edges: [],
      },
      {
        assetGuid: "g1",
        graphId: "event-graph",
        materialDomains: { bloom: "postProcess" },
      },
    );
    expect(
      diags.filter((d) => d.code === "scene-layer.postProcessDomain"),
    ).toEqual([]);
  });
});
