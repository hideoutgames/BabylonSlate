import { describe, expect, it } from "vitest";
import type { EditCommand } from "./command";
import { EditSession } from "./session";
import {
  createActor,
  createDefaultScene,
  type SerializedGraph,
} from "@babylonslate/core";
import { diffGraphCommands } from "./commands/graph-diff";
import { diffSceneCommands } from "./commands/scene-diff";
import { SetAssetDocumentCommand } from "./commands/asset-document";

interface TestDoc {
  value: number;
}

class IncrementCommand implements EditCommand<TestDoc> {
  readonly type = "test.increment";

  constructor(
    readonly amount = 1,
    readonly byteSize?: number,
  ) {}

  apply(doc: TestDoc): TestDoc {
    return { value: doc.value + this.amount };
  }

  invert(): EditCommand<TestDoc> {
    return new IncrementCommand(-this.amount, this.byteSize);
  }
}

describe("EditSession", () => {
  it("does not evict another document's retained history when admission fails", () => {
    const session = new EditSession({ maxBytes: 100 });
    session.apply("closed", { value: 0 }, new IncrementCommand(3, 40));
    session.closeDocument("closed", () => "saved");
    session.apply("active", { value: 0 }, new IncrementCommand(1, 10));
    const undone = session.undo("active", { value: 1 })!;
    expect(session.applyWithHistoryAdmission("active", undone.doc, new IncrementCommand(9, 60)))
      .toMatchObject({ ok: false, reason: "history-budget", requiredBytes: 120 });
    expect(session.reopenDocument("closed", () => "saved")).toBe(true);
    expect(session.undo("closed", { value: 3 })?.doc).toEqual({ value: 0 });
    expect(session.redo("active", undone.doc)?.doc).toEqual({ value: 1 });
  });

  it("undoes and redoes a node deletion with every incident edge as one operation", () => {
    const session = new EditSession();
    const before: SerializedGraph = {
      nodes: [
        {
          id: "start",
          type: "flow.event.tick",
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: "middle",
          type: "debug.print",
          position: { x: 200, y: 0 },
          data: { value: "Keep me" },
        },
        {
          id: "end",
          type: "debug.print",
          position: { x: 400, y: 0 },
          data: { value: "Control" },
        },
      ],
      edges: [
        {
          id: "first",
          source: "start",
          target: "middle",
          sourceHandle: "execOut",
          targetHandle: "execIn",
        },
        {
          id: "second",
          source: "start",
          target: "end",
          sourceHandle: "execOut",
          targetHandle: "execIn",
        },
      ],
    };
    const after = {
      ...before,
      nodes: before.nodes.filter((node) => node.id !== "middle"),
      edges: before.edges.slice(1),
    };
    const applied = session.applyBatch(
      "graph",
      before,
      diffGraphCommands(before, after),
    );
    expect(applied?.doc).toEqual(after);
    expect(session.getStack("graph").undoDepth).toBe(1);
    const undone = session.undo("graph", applied!.doc)!;
    expect(undone.doc).toEqual(before);
    const redone = session.redo("graph", undone.doc)!;
    expect(redone.doc).toEqual(after);
    expect(session.undo("graph", redone.doc)?.doc).toEqual(before);
  });

  it("restores every deleted actor in its original order without touching another document", () => {
    const session = new EditSession();
    const before = {
      ...createDefaultScene(),
      actors: [
        createActor("parent", "Parent"),
        createActor("child", "Child", { parentId: "parent" }),
        createActor("control", "Control"),
      ],
    };
    const after = { ...before, actors: before.actors.slice(2) };
    session.apply("other", { value: 0 }, new IncrementCommand(5));
    const applied = session.applyBatch(
      "scene",
      before,
      diffSceneCommands(before, after),
    );
    expect(applied?.doc).toEqual(after);
    const undone = session.undo("scene", applied!.doc)!;
    expect(undone.doc).toEqual(before);
    expect(session.redo("scene", undone.doc)?.doc).toEqual(after);
    expect(session.undo("other", { value: 5 })?.doc).toEqual({ value: 0 });
  });

  it("budgets a multi-command deletion as one whole history entry", () => {
    const before = {
      ...createDefaultScene(),
      actors: [createActor("a", "A"), createActor("b", "B")],
    };
    const after = { ...before, actors: [] };
    const commands = diffSceneCommands(before, after);
    const bytes = commands.reduce(
      (sum, command) => sum + ("byteSize" in command ? command.byteSize : 0),
      0,
    );
    const session = new EditSession({ maxBytes: bytes - 1 });
    expect(session.applyBatch("scene", before, commands)?.doc).toEqual(after);
    expect(session.canUndo("scene")).toBe(false);
  });

  it("does not create history or clear redo for an empty batch", () => {
    const session = new EditSession();
    const applied = session.apply("doc", { value: 0 }, new IncrementCommand(1));
    const undone = session.undo("doc", applied.doc)!;
    expect(session.applyBatch("doc", undone.doc, [])).toBeNull();
    expect(session.redo("doc", undone.doc)?.doc).toEqual({ value: 1 });
  });

  it("keeps separate stacks per document id", () => {
    const session = new EditSession();
    let docA: TestDoc = { value: 0 };
    let docB: TestDoc = { value: 10 };

    ({ doc: docA } = session.apply("doc-a", docA, new IncrementCommand(1)));
    ({ doc: docB } = session.apply("doc-b", docB, new IncrementCommand(5)));

    expect(docA.value).toBe(1);
    expect(docB.value).toBe(15);
    expect(session.canUndo("doc-a")).toBe(true);
    expect(session.canUndo("doc-b")).toBe(true);

    const undoneA = session.undo("doc-a", docA);
    expect(undoneA?.doc.value).toBe(0);
    expect(session.canUndo("doc-b")).toBe(true);
  });

  it("undoes a renamed document's edits under its new id and keeps none under the old id", () => {
    const session = new EditSession();
    let doc: TestDoc = { value: 0 };
    ({ doc } = session.apply("scene:old", doc, new IncrementCommand(1)));
    session.getStack("scene:old").endGesture();
    ({ doc } = session.apply("scene:old", doc, new IncrementCommand(2)));

    session.rekeyDocument("scene:old", "scene:new");

    expect(session.canUndo("scene:old")).toBe(false);
    expect(session.undo("scene:old", { value: 40 })).toBeNull();
    const undone = session.undo("scene:new", doc);
    expect(undone?.doc).toEqual({ value: 1 });
    expect(session.redo("scene:new", undone!.doc)?.doc).toEqual({ value: 3 });
  });

  it("never gives a renamed document another document's history left under the new id", () => {
    const session = new EditSession();
    session.apply("scene:new", { value: 0 }, new IncrementCommand(100));
    session.apply("scene:old", { value: 0 }, new IncrementCommand(1));
    session.rekeyDocument("scene:old", "scene:new");
    expect(session.undo("scene:new", { value: 1 })?.doc).toEqual({ value: 0 });
    expect(session.canUndo("scene:new")).toBe(false);

    session.apply("scene:stale", { value: 0 }, new IncrementCommand(7));
    session.rekeyDocument("scene:untouched", "scene:stale");
    expect(session.canUndo("scene:stale")).toBe(false);
  });

  it("resumes a closed document's Undo and Redo when it reopens with the content it closed with", () => {
    const session = new EditSession();
    let doc: TestDoc = { value: 0 };
    ({ doc } = session.apply("scene:a", doc, new IncrementCommand(1)));
    ({ doc } = session.apply("scene:a", doc, new IncrementCommand(2)));
    doc = session.undo("scene:a", doc)!.doc;

    session.closeDocument("scene:a", () => "saved-1");
    expect(session.reopenDocument("scene:a", () => "saved-1")).toBe(true);

    expect(session.redo("scene:a", doc)?.doc).toEqual({ value: 3 });
    expect(session.undo("scene:a", { value: 3 })?.doc).toEqual({ value: 1 });
    expect(session.undo("scene:a", { value: 1 })?.doc).toEqual({ value: 0 });
  });

  it("drops closed history when the document reopens with other content or was never kept", () => {
    const session = new EditSession();
    session.apply("scene:a", { value: 0 }, new IncrementCommand(1));
    session.closeDocument("scene:a", () => "saved-1");
    expect(session.reopenDocument("scene:a", () => "changed")).toBe(false);
    expect(session.undo("scene:a", { value: 5 })).toBeNull();

    // History left behind without closeDocument has no recorded content.
    session.apply("scene:b", { value: 0 }, new IncrementCommand(1));
    expect(session.reopenDocument("scene:b", () => "anything")).toBe(false);
    expect(session.canUndo("scene:b")).toBe(false);
  });

  it("forgets closed history on drop and on clear", () => {
    const session = new EditSession();
    session.apply("scene:a", { value: 0 }, new IncrementCommand(1));
    session.closeDocument("scene:a", () => "saved");
    session.dropDocument("scene:a");
    expect(session.reopenDocument("scene:a", () => "saved")).toBe(false);

    session.apply("scene:b", { value: 0 }, new IncrementCommand(1));
    session.closeDocument("scene:b", () => "saved");
    session.clear();
    expect(session.reopenDocument("scene:b", () => "saved")).toBe(false);
  });

  it("moves a closed document's history with a rename and resumes it under the new id", () => {
    const session = new EditSession();
    session.apply("scene:old", { value: 0 }, new IncrementCommand(1));
    session.closeDocument("scene:old", () => "saved");

    session.rekeyDocument("scene:old", "scene:new");

    expect(session.reopenDocument("scene:old", () => "saved")).toBe(false);
    expect(session.reopenDocument("scene:new", () => "saved")).toBe(true);
    expect(session.undo("scene:new", { value: 1 })?.doc).toEqual({ value: 0 });
  });

  it("evicts closed history oldest close first, counting Redo, once all history exceeds the byte budget", () => {
    const session = new EditSession({ maxBytes: 100 });
    // 40 bytes waiting in Redo.
    const first = session.apply("doc:first", { value: 0 }, new IncrementCommand(1, 40));
    session.undo("doc:first", first.doc);
    session.closeDocument("doc:first", () => "first");
    session.apply("doc:second", { value: 0 }, new IncrementCommand(1, 40));
    session.closeDocument("doc:second", () => "second");

    // 80 + 30 bytes: only the oldest closed history has to go.
    session.apply("doc:open", { value: 0 }, new IncrementCommand(1, 30));

    expect(session.reopenDocument("doc:first", () => "first")).toBe(false);
    expect(session.reopenDocument("doc:second", () => "second")).toBe(true);
    expect(session.undo("doc:open", { value: 1 })?.doc).toEqual({ value: 0 });
  });

  it("applies a changed byte budget to documents that already have history", () => {
    const session = new EditSession({ maxBytes: 50 });
    const first = session.apply("doc", { value: 0 }, new IncrementCommand(1, 10));
    session.configure({ maxBytes: 500 });
    const second = session.apply("doc", first.doc, new IncrementCommand(1, 100));
    expect(second.history).toBe("recorded");
    expect(session.undo("doc", second.doc)?.doc).toEqual({ value: 1 });
    expect(session.undo("doc", { value: 1 })?.doc).toEqual({ value: 0 });
  });

  it("undoes a merged scrub of a large asset document to its pre-gesture state within the default budget", () => {
    const session = new EditSession();
    // About 0.6 MB per snapshot.
    const asset = (step: number) => ({ step, pixels: "x".repeat(600_000) });
    let doc: Record<string, unknown> = asset(0);
    for (let step = 1; step <= 20; step++) {
      const result = session.apply("tilemap", doc, new SetAssetDocumentCommand(doc, asset(step), "paint:stroke-1"));
      expect(result.history).toBe("recorded");
      doc = result.doc;
    }
    expect(session.undo("tilemap", doc)?.doc).toEqual(asset(0));
    expect(session.canUndo("tilemap")).toBe(false);
    expect(session.redo("tilemap", asset(0))?.doc).toEqual(asset(20));
  });
});
