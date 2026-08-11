import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createDefaultGraph, engineCommandBus } from "@babylonslate/core";
import {
  deserializeGraph,
  executeGraph,
  serializeGraph,
} from "./graph-execution";

function collectLogs(run: () => void): string[] {
  const messages: string[] = [];
  const unsubscribe = engineCommandBus.subscribe((command) => {
    if (command.type === "log") {
      messages.push(command.message);
    }
  });
  try {
    run();
  } finally {
    unsubscribe();
  }
  return messages;
}

describe("graph serialization", () => {
  it("serializes and deserializes graphs", () => {
    const graph = createDefaultGraph();
    expect(deserializeGraph(serializeGraph(graph))).toEqual(graph);
  });

  it("round-trips any generated graph unchanged", () => {
    const nodeArb = fc.record({
      id: fc.string({ minLength: 1 }),
      type: fc.constantFrom("logMessage", "branch", "custom"),
      position: fc.record({
        x: fc.integer({ min: -1000, max: 1000 }),
        y: fc.integer({ min: -1000, max: 1000 }),
      }),
      data: fc.dictionary(fc.string({ minLength: 1 }), fc.string()),
    });

    fc.assert(
      fc.property(fc.array(nodeArb), (nodes) => {
        const graph = { nodes, edges: [] };
        expect(deserializeGraph(serializeGraph(graph))).toEqual(graph);
      }),
    );
  });
});

describe("executeGraph", () => {
  it("dispatches log commands for logMessage nodes", () => {
    const messages = collectLogs(() =>
      executeGraph({
        nodes: [
          {
            id: "log-1",
            type: "logMessage",
            position: { x: 0, y: 0 },
            data: { message: "Hello test" },
          },
        ],
        edges: [],
      }),
    );
    expect(messages).toEqual(["Hello test"]);
  });

  it("treats a missing message as an empty string", () => {
    const messages = collectLogs(() =>
      executeGraph({
        nodes: [
          {
            id: "log-1",
            type: "logMessage",
            position: { x: 0, y: 0 },
            data: {},
          },
        ],
        edges: [],
      }),
    );
    expect(messages).toEqual([""]);
  });

  it("coerces a non-string message", () => {
    const messages = collectLogs(() =>
      executeGraph({
        nodes: [
          {
            id: "log-1",
            type: "logMessage",
            position: { x: 0, y: 0 },
            data: { message: 42 },
          },
        ],
        edges: [],
      }),
    );
    expect(messages).toEqual(["42"]);
  });

  it("ignores node types it does not understand", () => {
    const messages = collectLogs(() =>
      executeGraph({
        nodes: [
          {
            id: "other-1",
            type: "notALogNode",
            position: { x: 0, y: 0 },
            data: { message: "ignored" },
          },
        ],
        edges: [],
      }),
    );
    expect(messages).toEqual([]);
  });

  it("dispatches nothing for an empty graph", () => {
    expect(collectLogs(() => executeGraph({ nodes: [], edges: [] }))).toEqual(
      [],
    );
  });
});
