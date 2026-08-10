import { describe, expect, it } from "vitest";
import { createDefaultGraph, engineCommandBus } from "@babylonslate/shared";
import {
  deserializeGraph,
  executeGraph,
  serializeGraph,
} from "./graph-execution";

describe("graph execution", () => {
  it("serializes and deserializes graphs", () => {
    const graph = createDefaultGraph();
    const roundTrip = deserializeGraph(serializeGraph(graph));
    expect(roundTrip).toEqual(graph);
  });

  it("dispatches log commands for logMessage nodes", () => {
    const messages: string[] = [];
    const unsubscribe = engineCommandBus.subscribe((command) => {
      if (command.type === "log") {
        messages.push(command.message);
      }
    });

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
    });

    unsubscribe();
    expect(messages).toEqual(["Hello test"]);
  });
});
