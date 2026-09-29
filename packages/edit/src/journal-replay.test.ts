import { describe, expect, it } from "vitest";
import { MoveNodeCommand } from "./commands/graph";
import { SetAssetDocumentCommand } from "./commands/asset-document";
import type { EditCommand } from "./command";
import {
  coalesceJournalLines,
  commandToJournalPayload,
  journalRepathLine,
  serializeJournalLine,
  type JournalLine,
} from "./journal";
import { replayJournalLines, resolveJournalLines } from "./journal-replay";
import { EditSession } from "./session";
import { diffGraphCommands } from "./commands/graph-diff";
import type { SerializedGraph } from "@babylonslate/core";

function journalRecord(docId: string, command: EditCommand<unknown>): JournalLine {
  return { v: 1, docId, at: "2026-09-28T10:00:00Z", command: commandToJournalPayload(command) };
}

/** Fold each record into the one before it when they coalesce, as the editor's buffer does. */
function fold(records: readonly JournalLine[]): JournalLine[] {
  const folded: JournalLine[] = [];
  for (const record of records) {
    const last = folded.at(-1);
    const merged = last ? coalesceJournalLines(last, record) : null;
    if (merged) folded[folded.length - 1] = merged;
    else folded.push(record);
  }
  return folded;
}

describe("journal coalescing", () => {
  const docId = "water:assets/Lake.water.babasset";
  const initial = { waveHeight: 1, opacity: 0.8 };

  it("recovers a folded scrub, then its Undo, to the same documents as the separate records", () => {
    const session = new EditSession();
    let doc: Record<string, unknown> = initial;
    const records: JournalLine[] = [];
    for (const waveHeight of [1.5, 2, 2.5]) {
      const command = new SetAssetDocumentCommand(doc, { ...doc, waveHeight }, "water:waveHeight");
      doc = session.apply(docId, doc, command).doc;
      records.push(journalRecord(docId, command));
    }
    const undone = session.undo(docId, doc)!;
    records.push(journalRecord(docId, undone.command));

    const folded = fold(records);
    expect(folded).toHaveLength(2);
    expect(folded[0]!.command).toMatchObject({ from: initial, to: { waveHeight: 2.5, opacity: 0.8 } });
    const replay = (lines: JournalLine[]) =>
      replayJournalLines(lines.map(serializeJournalLine), new Map([[docId, initial]])).documents.get(docId);
    expect(replay(folded.slice(0, 1))).toEqual({ waveHeight: 2.5, opacity: 0.8 });
    expect(replay(folded)).toEqual(initial);
    expect(replay(folded)).toEqual(replay(records));
  });

  it("folds a node drag but keeps other nodes, other documents and discrete edits separate", () => {
    const graphId = "graph:assets/Hero.class.babasset";
    const drag = [
      new MoveNodeCommand("a", { x: 0, y: 0 }, { x: 4, y: 0 }),
      new MoveNodeCommand("a", { x: 4, y: 0 }, { x: 9, y: 2 }),
    ].map((command) => journalRecord(graphId, command));
    expect(fold(drag)).toEqual([
      { ...drag[1], command: { ...drag[1]!.command, from: { x: 0, y: 0 } } },
    ]);

    const otherNode = journalRecord(graphId, new MoveNodeCommand("b", { x: 0, y: 0 }, { x: 1, y: 1 }));
    expect(coalesceJournalLines(drag[0]!, otherNode)).toBeNull();
    expect(coalesceJournalLines(drag[0]!, { ...drag[1]!, docId: "graph:assets/Other.class.babasset" })).toBeNull();

    const discrete = [
      new SetAssetDocumentCommand(initial, { ...initial, opacity: 0.5 }),
      new SetAssetDocumentCommand({ ...initial, opacity: 0.5 }, { ...initial, opacity: 0.2 }),
    ].map((command) => journalRecord(docId, command));
    expect(coalesceJournalLines(discrete[0]!, discrete[1]!)).toBeNull();

    const otherField = [
      new SetAssetDocumentCommand(initial, { ...initial, opacity: 0.5 }, "water:opacity"),
      new SetAssetDocumentCommand({ ...initial, opacity: 0.5 }, { ...initial, waveHeight: 3, opacity: 0.5 }, "water:waveHeight"),
    ].map((command) => journalRecord(docId, command));
    expect(coalesceJournalLines(otherField[0]!, otherField[1]!)).toBeNull();
  });
});

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

  it("replays an edit made before a rename and its Undo after it onto the renamed file", () => {
    const oldId = "graph:assets/hero.class.babasset";
    const newId = "graph:assets/player.class.babasset";
    // The file on disk: the deletion was never saved.
    const graph: SerializedGraph = {
      nodes: [
        { id: "start", type: "event", position: { x: 0, y: 0 }, data: {} },
        { id: "print", type: "print", position: { x: 200, y: 0 }, data: {} },
      ],
      edges: [{ id: "wire", source: "start", target: "print" }],
    };
    const session = new EditSession();
    const deleted = session.applyBatch(oldId, graph, diffGraphCommands(graph, {
      nodes: [graph.nodes[0]!], edges: [],
    }))!;
    session.rekeyDocument(oldId, newId);
    const undone = session.undo(newId, deleted.doc)!;
    const at = "2026-09-28T12:00:00Z";
    const lines = [
      serializeJournalLine({ v: 1, docId: oldId, at, command: commandToJournalPayload(deleted.command) }),
      serializeJournalLine(journalRepathLine(oldId, newId, at)),
      serializeJournalLine({ v: 1, docId: newId, at, command: commandToJournalPayload(undone.command) }),
    ];
    for (const count of [2, 3]) {
      const replayed = replayJournalLines(lines.slice(0, count), new Map([[newId, graph]]));
      expect(replayed.skipped).toEqual([]);
      expect(replayed.documents.get(newId)?.nodes.map((node) => node.id))
        .toEqual(count === 2 ? ["start"] : ["start", "print"]);
    }
  });

  it("keeps a document later opened at a renamed path apart from the renamed one", () => {
    const [a, b, c] = ["graph:assets/a.graph.babasset", "graph:assets/b.graph.babasset", "graph:assets/c.graph.babasset"];
    const at = "2026-09-28T12:00:00Z";
    const move = (docId: string, x: number) => serializeJournalLine({
      v: 1, docId, at,
      command: commandToJournalPayload(new MoveNodeCommand("node-1", { x: 0, y: 0 }, { x, y: 0 })),
    });
    const lines = [
      move(a, 1),
      serializeJournalLine(journalRepathLine(a, b, at)),
      move(a, 2),
      serializeJournalLine(journalRepathLine(b, c, at)),
    ];
    expect(resolveJournalLines(lines).map((line) => line.docId)).toEqual([c, a]);
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
