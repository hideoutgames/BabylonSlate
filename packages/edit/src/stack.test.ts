import { describe, expect, it } from "vitest";
import type { EditCommand } from "./command";
import { SetAssetDocumentCommand } from "./commands/asset-document";
import { DocumentEditStack } from "./stack";

interface TestDoc {
  value: number;
}

class IncrementCommand implements EditCommand<TestDoc> {
  readonly type = "test.increment";
  readonly byteSize?: number;

  constructor(
    readonly amount = 1,
    byteSize?: number,
  ) {
    this.byteSize = byteSize;
  }

  apply(doc: TestDoc): TestDoc {
    return { value: doc.value + this.amount };
  }

  invert(): EditCommand<TestDoc> {
    return new IncrementCommand(-this.amount, this.byteSize);
  }
}

class MergeableCommand implements EditCommand<TestDoc> {
  readonly type = "test.mergeable";
  readonly mergeKey: string;

  constructor(
    readonly from: number,
    readonly target: number,
    mergeKey = "merge",
    readonly byteSize?: number,
  ) {
    this.mergeKey = mergeKey;
  }

  apply(doc: TestDoc): TestDoc {
    void doc;
    return { value: this.target };
  }

  invert(): EditCommand<TestDoc> {
    return new MergeableCommand(this.target, this.from, this.mergeKey, this.byteSize);
  }
}

describe("DocumentEditStack", () => {
  it("rejects an unretainable inverse before applying and preserves earlier undo and redo", () => {
    const stack = new DocumentEditStack<TestDoc>({ maxEntries: 10, maxBytes: 99 });
    let doc = stack.apply({ value: 0 }, new IncrementCommand(1, 10)).doc;
    doc = stack.apply(doc, new IncrementCommand(2, 10)).doc;
    doc = stack.undo(doc)!.doc;
    const rejected: EditCommand<TestDoc> = {
      type: "test.rejected", byteSize: 50,
      apply: () => { throw new Error("Must not apply an unretainable edit"); },
      invert: () => new IncrementCommand(-100, 50),
    };
    expect(stack.applyWithHistoryAdmission(doc, rejected)).toEqual({
      ok: false, reason: "history-budget", requiredBytes: 100, maxBytes: 99,
    });
    expect(doc).toEqual({ value: 1 });
    expect(stack.undoDepth).toBe(1);
    expect(stack.historyBytes).toBe(20);
    expect(stack.redo(doc)?.doc).toEqual({ value: 3 });
    expect(stack.undo({ value: 3 })?.doc).toEqual({ value: 1 });
    expect(stack.undo({ value: 1 })?.doc).toEqual({ value: 0 });
  });

  it("retains an admitted entry while evicting only the ordinary oldest history", () => {
    const stack = new DocumentEditStack<TestDoc>({ maxEntries: 2, maxBytes: 50 });
    let doc = stack.apply({ value: 0 }, new IncrementCommand(1, 20)).doc;
    doc = stack.apply(doc, new IncrementCommand(2, 10)).doc;
    const applied = stack.applyWithHistoryAdmission(doc, new IncrementCommand(4, 20));
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error("Expected admission");
    expect(applied.doc).toEqual({ value: 7 });
    expect(stack.historyBytes).toBe(50);
    doc = stack.undo(applied.doc)!.doc;
    expect(doc).toEqual({ value: 3 });
    expect(stack.undo(doc)?.doc).toEqual({ value: 1 });
    expect(stack.canUndo).toBe(false);
    expect(stack.redo({ value: 1 })?.doc).toEqual({ value: 3 });
    expect(stack.redo({ value: 3 })?.doc).toEqual({ value: 7 });
  });

  it.each([undefined, -1, NaN, Infinity, 1.5])("refuses unaccounted bytes %s without changing history", (bytes) => {
    const stack = new DocumentEditStack<TestDoc>({ maxEntries: 10, maxBytes: 100 });
    const doc = stack.apply({ value: 0 }, new IncrementCommand(1, 10)).doc;
    expect(stack.applyWithHistoryAdmission(doc, new IncrementCommand(3, bytes))).toMatchObject({
      ok: false, reason: "invalid-byte-size",
    });
    expect(stack.undo(doc)?.doc).toEqual({ value: 0 });
  });

  it("keeps redo when an admitted command throws or returns its unchanged document", () => {
    const stack = new DocumentEditStack<TestDoc>({ maxEntries: 10, maxBytes: 100 });
    let doc = stack.apply({ value: 0 }, new IncrementCommand(1, 10)).doc;
    doc = stack.undo(doc)!.doc;
    const command: EditCommand<TestDoc> = {
      type: "test.fail", byteSize: 10,
      apply: () => { throw new Error("Conflicting document revision"); },
      invert: () => new IncrementCommand(-1, 10),
    };
    expect(() => stack.applyWithHistoryAdmission(doc, command)).toThrow("Conflicting document revision");
    expect(stack.applyWithHistoryAdmission(doc, { ...command, apply: (current) => current })).toMatchObject({
      ok: true, status: "unchanged", doc,
    });
    expect(stack.undoDepth).toBe(0);
    expect(stack.redo(doc)?.doc).toEqual({ value: 1 });
  });

  it("keeps the first inverse of a merged gesture across Undo, Redo and another Undo", () => {
    const stack = new DocumentEditStack<TestDoc>({ maxEntries: 10, maxBytes: 1000 });
    let doc = stack.apply({ value: 0 }, new MergeableCommand(0, 1)).doc;
    doc = stack.apply(doc, new MergeableCommand(1, 2)).doc;
    doc = stack.undo(doc)!.doc;
    expect(doc.value).toBe(0);
    doc = stack.redo(doc)!.doc;
    expect(doc.value).toBe(2);
    expect(stack.undo(doc)!.doc.value).toBe(0);
  });

  it("applies an edit larger than the budget, clears history once and records nothing more of that gesture", () => {
    const stack = new DocumentEditStack<TestDoc>({ maxEntries: 10, maxBytes: 100 });
    let doc = stack.apply({ value: 0 }, new IncrementCommand(1, 10)).doc;
    const oversized = stack.apply(doc, new MergeableCommand(1, 5, "scrub", 200));
    expect(oversized).toMatchObject({ doc: { value: 5 }, history: "cleared" });
    expect(stack.canUndo).toBe(false);
    // Later steps of the same gesture fit, but Undo must not stop mid-gesture.
    const continued = stack.apply(oversized.doc, new MergeableCommand(5, 6, "scrub", 10));
    expect(continued).toMatchObject({ doc: { value: 6 }, history: "cleared-gesture" });
    expect(stack.canUndo).toBe(false);
    stack.endGesture();
    doc = stack.apply(continued.doc, new IncrementCommand(1, 10)).doc;
    expect(stack.undo(doc)?.doc).toEqual({ value: 6 });
    expect(stack.canUndo).toBe(false);
  });

  it("keeps a merged snapshot gesture undoable when only its first and last snapshots fit the budget", () => {
    const snapshot = (value: string) => ({ value: value.repeat(100) });
    const first = new SetAssetDocumentCommand(snapshot("a"), snapshot("b"), "scrub");
    // One step holds two 100-character snapshots; the budget fits that, not four.
    const stack = new DocumentEditStack<Record<string, unknown>>({ maxEntries: 10, maxBytes: 300 });
    let doc = stack.apply(snapshot("a"), first).doc;
    doc = stack.apply(doc, new SetAssetDocumentCommand(snapshot("b"), snapshot("c"), "scrub")).doc;
    const last = stack.apply(doc, new SetAssetDocumentCommand(snapshot("c"), snapshot("d"), "scrub"));
    expect(last.history).toBe("recorded");
    doc = stack.undo(last.doc)!.doc;
    expect(doc).toEqual(snapshot("a"));
    expect(stack.canUndo).toBe(false);
    expect(stack.redo(doc)?.doc).toEqual(snapshot("d"));
  });

  it("evicts the oldest history when its byte budget is lowered", () => {
    const stack = new DocumentEditStack<TestDoc>({ maxEntries: 10, maxBytes: 1000 });
    let doc = stack.apply({ value: 0 }, new IncrementCommand(1, 100)).doc;
    doc = stack.apply(doc, new IncrementCommand(2, 100)).doc;
    stack.configure({ maxBytes: 150 });
    expect(stack.undo(doc)?.doc).toEqual({ value: 1 });
    expect(stack.canUndo).toBe(false);
  });

  it("starts a new gesture after Undo even when the exposed older command shares a merge key", () => {
    const stack = new DocumentEditStack<TestDoc>({ maxEntries: 10, maxBytes: 1000 });
    let doc = stack.apply({ value: 0 }, new MergeableCommand(0, 1)).doc;
    doc = stack.apply(doc, new MergeableCommand(1, 2, "other")).doc;
    doc = stack.undo(doc)!.doc;
    doc = stack.apply(doc, new MergeableCommand(1, 3)).doc;
    expect(stack.undo(doc)!.doc.value).toBe(1);
  });
  it("applies commands and supports undo/redo", () => {
    const stack = new DocumentEditStack<TestDoc>({
      maxEntries: 10,
      maxBytes: 1000,
    });
    let doc: TestDoc = { value: 0 };

    ({ doc } = stack.apply(doc, new IncrementCommand(2)));
    expect(doc.value).toBe(2);
    expect(stack.canUndo).toBe(true);
    expect(stack.canRedo).toBe(false);

    const undone = stack.undo(doc);
    expect(undone?.doc.value).toBe(0);
    doc = undone!.doc;
    expect(stack.canRedo).toBe(true);

    const redone = stack.redo(doc);
    expect(redone?.doc.value).toBe(2);
    doc = redone!.doc;
    expect(stack.canUndo).toBe(true);
  });

  it("clears redo when a new command is applied after undo", () => {
    const stack = new DocumentEditStack<TestDoc>({
      maxEntries: 10,
      maxBytes: 1000,
    });
    let doc: TestDoc = { value: 0 };

    ({ doc } = stack.apply(doc, new IncrementCommand(1)));
    ({ doc } = stack.undo(doc)!);
    ({ doc } = stack.apply(doc, new IncrementCommand(5)));

    expect(stack.canRedo).toBe(false);
    expect(doc.value).toBe(5);
  });

  it("coalesces commands with the same merge key", () => {
    const stack = new DocumentEditStack<TestDoc>({
      maxEntries: 10,
      maxBytes: 1000,
    });
    let doc: TestDoc = { value: 0 };

    ({ doc } = stack.apply(doc, new MergeableCommand(0, 1)));
    ({ doc } = stack.apply(doc, new MergeableCommand(1, 2)));
    ({ doc } = stack.apply(doc, new MergeableCommand(2, 3)));

    expect(doc.value).toBe(3);
    expect(stack.canUndo).toBe(true);

    const undone = stack.undo(doc);
    // Inverse of the first gesture event restores the pre-gesture value.
    expect(undone?.doc.value).toBe(0);
  });

  it("requires two undos when merge keys differ across gestures", () => {
    const stack = new DocumentEditStack<TestDoc>({
      maxEntries: 10,
      maxBytes: 1000,
    });
    let doc: TestDoc = { value: 0 };

    ({ doc } = stack.apply(
      doc,
      new MergeableCommand(0, 1, "material-node-move:drag-1"),
    ));
    ({ doc } = stack.apply(
      doc,
      new MergeableCommand(1, 2, "material-node-move:drag-2"),
    ));

    expect(doc.value).toBe(2);
    ({ doc } = stack.undo(doc)!);
    expect(doc.value).toBe(1);
    expect(stack.canUndo).toBe(true);
    ({ doc } = stack.undo(doc)!);
    expect(doc.value).toBe(0);
    expect(stack.canUndo).toBe(false);
  });

  it("drops oldest entries when entry count exceeds maxEntries", () => {
    const stack = new DocumentEditStack<TestDoc>({
      maxEntries: 2,
      maxBytes: 10_000,
    });
    let doc: TestDoc = { value: 0 };

    ({ doc } = stack.apply(doc, new IncrementCommand(1)));
    ({ doc } = stack.apply(doc, new IncrementCommand(1)));
    ({ doc } = stack.apply(doc, new IncrementCommand(1)));

    expect(doc.value).toBe(3);
    expect(stack.canUndo).toBe(true);

    ({ doc } = stack.undo(doc)!);
    expect(doc.value).toBe(2);
    expect(stack.canUndo).toBe(true);

    ({ doc } = stack.undo(doc)!);
    expect(doc.value).toBe(1);
    expect(stack.canUndo).toBe(false);
  });

  it("drops oldest entries when byte budget is exceeded", () => {
    const stack = new DocumentEditStack<TestDoc>({
      maxEntries: 100,
      maxBytes: 150,
    });
    let doc: TestDoc = { value: 0 };

    ({ doc } = stack.apply(doc, new IncrementCommand(1, 100)));
    ({ doc } = stack.apply(doc, new IncrementCommand(1, 100)));

    expect(doc.value).toBe(2);
    expect(stack.canUndo).toBe(true);

    ({ doc } = stack.undo(doc)!);
    expect(doc.value).toBe(1);
    expect(stack.canUndo).toBe(false);
  });

  it("clears both stacks", () => {
    const stack = new DocumentEditStack<TestDoc>({
      maxEntries: 10,
      maxBytes: 1000,
    });
    let doc: TestDoc = { value: 0 };

    ({ doc } = stack.apply(doc, new IncrementCommand(1)));
    ({ doc } = stack.undo(doc)!);

    stack.clear();
    expect(stack.canUndo).toBe(false);
    expect(stack.canRedo).toBe(false);
  });
});
