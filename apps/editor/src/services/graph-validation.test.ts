import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import {
  createDefaultLogicGraphSerialized,
  hydrateSerializedGraphForEditor,
} from "./graph-validation";

const registry = createDefaultNodeRegistry();

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
