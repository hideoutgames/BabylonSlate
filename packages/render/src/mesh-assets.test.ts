import { describe, expect, it } from "vitest";
import { meshAssetFingerprint } from "./mesh-assets";

describe("meshAssetFingerprint", () => {
  it("includes compiled CSS stack values so a fallback change rebuilds 2D text", () => {
    expect(meshAssetFingerprint({ fontCssStack: "A, sans-serif" })).not.toBe(
      meshAssetFingerprint({ fontCssStack: "B, sans-serif" }),
    );
    expect(
      meshAssetFingerprint({
        fontCssStackByGuid: new Map([["g", '"Display", sans-serif']]),
      }),
    ).not.toBe(
      meshAssetFingerprint({
        fontCssStackByGuid: new Map([["g", '"Other", sans-serif']]),
      }),
    );
  });
});
