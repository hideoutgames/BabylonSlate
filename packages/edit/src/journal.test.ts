import { describe, expect, it } from "vitest";
import { MoveNodeCommand } from "./commands/graph";
import {
  commandToJournalPayload,
  parseJournalLine,
  reviveCommand,
  serializeJournalLine,
  type JournalLine,
} from "./journal";

describe("journal", () => {
  it("serializes and parses journal lines", () => {
    const line: JournalLine = {
      v: 1,
      docId: "graph:assets/main.graph.babasset",
      at: "2026-08-11T17:00:00.000Z",
      command: {
        type: "graph.moveNode",
        nodeId: "log-1",
        from: { x: 0, y: 0 },
        to: { x: 10, y: 20 },
      },
    };

    const serialized = serializeJournalLine(line);
    expect(parseJournalLine(serialized)).toEqual(line);
  });

  it("rejects invalid journal lines", () => {
    expect(() => parseJournalLine('{"v":2}')).toThrow("Invalid journal line");
  });

  it("revives graph commands from journal payloads", () => {
    const payload = commandToJournalPayload(
      new MoveNodeCommand("node-1", { x: 0, y: 0 }, { x: 5, y: 5 }),
    );
    const revived = reviveCommand(payload);

    expect(revived).toBeInstanceOf(MoveNodeCommand);
    const graph = {
      nodes: [
        {
          id: "node-1",
          type: "logMessage",
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
      edges: [],
    };
    const next = revived!.apply(graph) as typeof graph;
    expect(next.nodes[0]?.position).toEqual({ x: 5, y: 5 });
  });
});
