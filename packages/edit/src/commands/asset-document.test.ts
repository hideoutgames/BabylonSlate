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

  it("two node-move merge keys require two undos", () => {
    const stack = new DocumentEditStack<Record<string, unknown>>({
      maxEntries: 10,
      maxBytes: 10_000,
    });
    let doc: Record<string, unknown> = { x: 0 };
    ({ doc } = stack.apply(
      doc,
      new SetAssetDocumentCommand({ x: 0 }, { x: 10 }, "material-node-move:a"),
    ));
    ({ doc } = stack.apply(
      doc,
      new SetAssetDocumentCommand({ x: 10 }, { x: 20 }, "material-node-move:b"),
    ));
    expect(doc).toEqual({ x: 20 });
    ({ doc } = stack.undo(doc)!);
    expect(doc).toEqual({ x: 10 });
    expect(stack.canUndo).toBe(true);
    ({ doc } = stack.undo(doc)!);
    expect(doc).toEqual({ x: 0 });
    expect(stack.canUndo).toBe(false);
  });
});
