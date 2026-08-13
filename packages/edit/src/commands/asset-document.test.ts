import { describe, expect, it } from "vitest";
import { DocumentEditStack } from "../stack";
import { SetAssetDocumentCommand, createSetAssetDocumentCommandFromJson } from "./asset-document";

describe("SetAssetDocumentCommand", () => {
  it("replaces and inverts the payload", () => {
    const from = { name: "A" };
    const to = { name: "B" };
    const command = new SetAssetDocumentCommand(from, to);
    expect(command.apply(from)).toEqual({ name: "B" });
    expect(command.invert().apply(to)).toEqual({ name: "A" });
  });

  it("keeps an optional merge key so a paint stroke is one undo", () => {
    const command = new SetAssetDocumentCommand(
      { n: 1 },
      { n: 2 },
      "tilemap-stroke:abc",
    );
    expect(command.mergeKey).toBe("tilemap-stroke:abc");
    expect(command.invert().mergeKey).toBeUndefined();
    expect(createSetAssetDocumentCommandFromJson({
      from: { n: 1 },
      to: { n: 2 },
      mergeKey: "tilemap-stroke:abc",
    }).mergeKey).toBe("tilemap-stroke:abc");
  });

  it("one undo restores the pre-stroke payload when merge keys match", () => {
    const stack = new DocumentEditStack<Record<string, unknown>>({
      maxEntries: 10,
      maxBytes: 10_000,
    });
    let doc: Record<string, unknown> = { n: 0 };
    ({ doc } = stack.apply(
      doc,
      new SetAssetDocumentCommand({ n: 0 }, { n: 1 }, "tilemap-stroke:s"),
    ));
    ({ doc } = stack.apply(
      doc,
      new SetAssetDocumentCommand({ n: 1 }, { n: 2 }, "tilemap-stroke:s"),
    ));
    expect(doc).toEqual({ n: 2 });
    expect(stack.undo(doc)?.doc).toEqual({ n: 0 });
  });
});
