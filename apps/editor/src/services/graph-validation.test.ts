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
    for (const node of graph.nodes) {
      expect(Array.isArray(node.data.__pins)).toBe(true);
      expect((node.data.__pins as unknown[]).length).toBeGreaterThan(0);
    }
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
    expect(nodes.some((node) => node.id === "functions.call")).toBe(true);
  });
});
