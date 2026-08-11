import { describe, expect, it } from "vitest";
import type { EditCommand } from "./command";
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
  readonly mergeKey = "merge";

  constructor(
    readonly from: number,
    readonly target: number,
  ) {}

  apply(doc: TestDoc): TestDoc {
    void doc;
    return { value: this.target };
  }

  invert(): EditCommand<TestDoc> {
    return new MergeableCommand(this.target, this.from);
  }
}

describe("DocumentEditStack", () => {
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
