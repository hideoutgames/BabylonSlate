import { describe, expect, it } from "vitest";
import { MoveNodeCommand } from "./commands/graph";
import {
  commandToJournalPayload,
  serializeJournalLine,
} from "./journal";
import { replayJournalLines } from "./journal-replay";
import { EditSession } from "./session";
import { diffGraphCommands } from "./commands/graph-diff";
import type { SerializedGraph } from "@babylonslate/core";

describe("journal replay", () => {
  it("recovers batched deletion, Undo and Redo as complete graph changes", () => {
    const docId = "graph:assets/history.class.babasset";
    const graph: SerializedGraph = {
      nodes: [
        { id: "start", type: "event", position: { x: 0, y: 0 }, data: {} },
        { id: "print", type: "print", position: { x: 200, y: 0 }, data: {} },
      ],
      edges: [{ id: "wire", source: "start", target: "print" }],
    };
    const session = new EditSession();
    const deleted = session.applyBatch(docId, graph, diffGraphCommands(graph, {
      nodes: [graph.nodes[0]!], edges: [],
    }))!;
    const undone = session.undo(docId, deleted.doc)!;
    const redone = session.redo(docId, undone.doc)!;
    const changes = [deleted, undone, redone];
    const lines = changes.map(({ command }) => serializeJournalLine({
      v: 1, docId, at: "2026-09-07T20:00:00Z",
      command: commandToJournalPayload(command),
    }));
    for (const count of [1, 2, 3]) {
      const replayed = replayJournalLines(lines.slice(0, count), new Map([[docId, graph]]));
      expect(replayed.skipped).toEqual([]);
      expect(replayed.documents.get(docId)?.nodes.map((node) => node.id))
        .toEqual(count === 2 ? ["start", "print"] : ["start"]);
      expect(replayed.documents.get(docId)?.edges.map((edge) => edge.id))
        .toEqual(count === 2 ? ["wire"] : []);
    }
  });

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

  it("skips a whole batch when one child command cannot be recovered", () => {
    const docId = "graph:assets/history.class.babasset";
    const graph = { nodes: [{ id: "node-1", type: "print", position: { x: 0, y: 0 }, data: {} }], edges: [] };
    const line = serializeJournalLine({
      v: 1, docId, at: "2026-09-07T20:00:00Z",
      command: { type: "edit.batch", commands: [
        commandToJournalPayload(new MoveNodeCommand("node-1", { x: 0, y: 0 }, { x: 99, y: 0 })),
        { type: "future.unknown" },
      ] },
    });
    const result = replayJournalLines([line], new Map([[docId, graph]]));
    expect(result.skipped).toHaveLength(1);
    expect(result.documents.get(docId)?.nodes[0]?.position).toEqual({ x: 0, y: 0 });
  });
});
