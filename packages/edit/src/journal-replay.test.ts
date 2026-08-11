import { describe, expect, it } from "vitest";
import { MoveNodeCommand } from "./commands/graph";
import {
  commandToJournalPayload,
  serializeJournalLine,
} from "./journal";
import { replayJournalLines } from "./journal-replay";

describe("journal replay", () => {
  it("replays lines onto open graph documents", () => {
    const docId = "graph:assets/main.graph.babasset";
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

    const line = serializeJournalLine({
      v: 1,
      docId,
      at: "2026-08-11T17:00:00.000Z",
      command: commandToJournalPayload(
        new MoveNodeCommand("node-1", { x: 0, y: 0 }, { x: 12, y: 8 }),
      ),
    });

    const result = replayJournalLines([line], new Map([[docId, graph]]));
    expect(result.skipped).toHaveLength(0);
    expect(result.documents.get(docId)?.nodes[0]?.position).toEqual({
      x: 12,
      y: 8,
    });
  });

  it("skips lines for documents that are not open", () => {
    const line = serializeJournalLine({
      v: 1,
      docId: "graph:missing",
      at: "2026-08-11T17:00:00.000Z",
      command: commandToJournalPayload(
        new MoveNodeCommand("node-1", { x: 0, y: 0 }, { x: 1, y: 1 }),
      ),
    });

    const result = replayJournalLines([line], new Map());
    expect(result.skipped).toHaveLength(1);
    expect(result.documents.size).toBe(0);
  });
});
