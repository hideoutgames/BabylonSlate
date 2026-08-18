import { describe, expect, it } from "vitest";
import { meshAssetFingerprint } from "./mesh-assets";

describe("meshAssetFingerprint", () => {
  it("is empty when assets are omitted", () => {
    expect(meshAssetFingerprint(undefined)).toBe("");
  });

  it("ignores Map identity so equivalent payloads do not rebuild", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const first = meshAssetFingerprint({
      textureBytes: new Map([["tex", bytes]]),
      spritePayloads: new Map(),
      spriteAnimations: new Map(),
    });
    const second = meshAssetFingerprint({
      textureBytes: new Map([["tex", bytes]]),
      spritePayloads: new Map(),
      spriteAnimations: new Map(),
    });
    expect(first).toBe(second);
  });

  it("changes when a Sprite Animation guid is added", () => {
    const without = meshAssetFingerprint({
      spritePayloads: new Map([["hero", { textureGuid: null, pixelsPerUnit: 100, frames: [], clips: [] }]]),
    });
    const withAnim = meshAssetFingerprint({
      spritePayloads: new Map([["hero", { textureGuid: null, pixelsPerUnit: 100, frames: [], clips: [] }]]),
      spriteAnimations: new Map([["walk", { frames: [] }]]),
    });
    expect(withAnim).not.toBe(without);
    expect(withAnim).toContain("spriteAnims:walk");
  });

  it("changes when texture byte length changes even if the guid is the same", () => {
    const small = meshAssetFingerprint({
      textureBytes: new Map([["tex", new Uint8Array([1, 2])]]),
    });
    const large = meshAssetFingerprint({
      textureBytes: new Map([["tex", new Uint8Array([1, 2, 3, 4])]]),
    });
    expect(small).not.toBe(large);
  });
});
