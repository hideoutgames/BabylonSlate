import { describe, expect, it } from "vitest";
import type { EditCommand } from "./command";
import { EditSession } from "./session";

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
