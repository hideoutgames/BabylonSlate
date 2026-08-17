import { describe, expect, it } from "vitest";
import { shouldApplyAssetDocumentChange } from "./asset-document-change";

describe("shouldApplyAssetDocumentChange", () => {
  it("skips a structurally identical payload so a canvas remount cannot re-dirty", () => {
    const payload = { name: "Rock", nodes: [{ id: "a", position: { x: 1, y: 2 } }] };
    expect(shouldApplyAssetDocumentChange(payload, structuredClone(payload))).toBe(
      false,
    );
  });

  it("applies when any field actually changes", () => {
    expect(
      shouldApplyAssetDocumentChange({ name: "A" }, { name: "B" }),
    ).toBe(true);
  });
});
