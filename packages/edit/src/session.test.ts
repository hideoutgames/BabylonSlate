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

interface TestDoc {
  value: number;
}

class IncrementCommand implements EditCommand<TestDoc> {
  readonly type = "test.increment";

  constructor(readonly amount = 1) {}

  apply(doc: TestDoc): TestDoc {
    return { value: doc.value + this.amount };
  }

  invert(): EditCommand<TestDoc> {
    return new IncrementCommand(-this.amount);
  }
}

describe("EditSession", () => {
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

  it("drops document stacks on close", () => {
    const session = new EditSession();
    let doc: TestDoc = { value: 0 };

    ({ doc } = session.apply("doc-a", doc, new IncrementCommand(1)));
    expect(session.canUndo("doc-a")).toBe(true);

    session.dropDocument("doc-a");
    expect(session.canUndo("doc-a")).toBe(false);
  });
});
