import { describe, expect, it } from "vitest";
import { SetAssetDocumentCommand } from "./asset-document";

describe("SetAssetDocumentCommand", () => {
  it("replaces and inverts the payload", () => {
    const from = { name: "A" };
    const to = { name: "B" };
    const command = new SetAssetDocumentCommand(from, to);
    expect(command.apply(from)).toEqual({ name: "B" });
    expect(command.invert().apply(to)).toEqual({ name: "A" });
  });
});
