import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import {
  createDefaultLogicGraphSerialized,
  hydrateClassDocumentPayload,
  hydrateSerializedGraphForEditor,
  scriptPaletteNodes,
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
});

describe("createDefaultLogicGraphSerialized", () => {
  it("seeds Begin Play and Tick with pins", () => {
    const graph = createDefaultLogicGraphSerialized(registry);
    const types = graph.nodes.map((n) => n.type);
    expect(types).toContain("flow.event.beginPlay");
    expect(types).toContain("flow.event.tick");
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "event-begin-play",
      "event-tick",
    ]);
    for (const node of graph.nodes) {
      expect(Array.isArray(node.data.__pins)).toBe(true);
      expect((node.data.__pins as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it("seeds On Evaluate for a BTDecorator class", () => {
    const graph = createDefaultLogicGraphSerialized(registry, {
      parentClass: "BTDecorator",
    });
    expect(graph.nodes.map((node) => node.type)).toEqual(["bt.event.evaluate"]);
    expect(graph.nodes.some((node) => node.type === "flow.event.beginPlay")).toBe(
      false,
    );
  });

  it("seeds Activate, Tick, and Abort for a BTTask class", () => {
    const graph = createDefaultLogicGraphSerialized(registry, {
      parentClass: "BTTask",
    });
    expect(graph.nodes.map((node) => node.type)).toEqual([
      "bt.event.activate",
      "bt.event.tick",
      "bt.event.abort",
    ]);
  });

  it("seeds editor lifecycle events for an EditorUtilityObject class", () => {
    const graph = createDefaultLogicGraphSerialized(registry, {
      parentClass: "EditorUtilityObject",
    });
    expect(graph.nodes.map((node) => node.type)).toEqual([
      "flow.event.editorStartup",
      "flow.event.sceneOpen",
      "flow.event.sceneSaved",
      "flow.event.editorShutdown",
    ]);
    expect(graph.nodes.some((node) => node.type === "flow.event.beginPlay")).toBe(
      false,
    );
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
    expect(nodes.some((node) => node.id === "functions.call")).toBe(true);
    expect(nodes.some((node) => node.id === "navigation.moveTo")).toBe(true);
    const print = nodes.find((node) => node.id === "debug.print");
    expect(print?.defaultData).toMatchObject({ developmentOnly: true });
  });

  it("hides behaviour-tree events on Actor class graphs", () => {
    const nodes = scriptPaletteNodes(registry, { parentClass: "Actor" });
    expect(nodes.some((node) => node.id === "bt.event.evaluate")).toBe(false);
    expect(nodes.some((node) => node.id === "bt.finish")).toBe(false);
    expect(nodes.some((node) => node.id === "bt.returnCondition")).toBe(false);
    expect(nodes.some((node) => node.id === "bt.blackboard.get")).toBe(false);
    expect(nodes.some((node) => node.id === "flow.event.beginPlay")).toBe(true);
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
    expect(nodes.some((node) => node.id === "flow.event.editorStartup")).toBe(
      true,
    );
    expect(nodes.some((node) => node.id === "flow.event.sceneOpen")).toBe(true);
    expect(nodes.some((node) => node.id === "flow.event.beginPlay")).toBe(false);
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
});
