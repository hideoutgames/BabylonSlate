import { describe, expect, it } from "vitest";
import type { IndexedAsset } from "@haptic/assets";
import { compressionBadgeLabel, textureCompressionState } from "./content-browser-helpers";
import { shownCompressionState, unfinishedTextureEncodePaths } from "./texture-encode-state";

function indexed(guid: string, type: string, payload: Record<string, unknown>): IndexedAsset {
  return {
    rootId: "project",
    path: `assets/${guid}.hasset`,
    header: {
      dependencyMetadataVersion: 1, requiredDependencies: [],
      guid, type, name: guid, engineVersion: "0.0.0", version: 1, mode: "thin", dependencies: [], parentClass: null,
      payload, chunks: [],
    },
  };
}

describe("shownCompressionState", () => {
  it("shows a running encode over the saved state, which stays pending until the encode commits", () => {
    expect(shownCompressionState("pending", true)).toBe("encoding");
    expect(shownCompressionState("compressed", true)).toBe("encoding");
    expect(shownCompressionState("encode_failed", false)).toBe("encode_failed");
    expect(shownCompressionState(undefined, false)).toBeNull();
  });
});

describe("Content Browser compression badge", () => {
  it("badges a Texture whose encode is running as Encoding, whatever its file says", () => {
    const compressed = indexed("a", "Texture", { compressionState: "compressed" });
    expect(textureCompressionState(compressed)).toBeNull();
    expect(textureCompressionState(compressed, true)).toBe("encoding");
    expect(textureCompressionState(indexed("b", "Texture", { compressionState: "pending" }))).toBe("pending");
    expect(compressionBadgeLabel("encoding")).toBe("Encoding");
    expect(textureCompressionState(indexed("c", "Model", {}), true)).toBeNull();
  });
});

describe("unfinishedTextureEncodePaths", () => {
  it("lists Textures still waiting for or running an encode, including a re-encode of a compressed one", () => {
    const assets = [
      indexed("queued", "Texture", { compressionState: "pending" }),
      indexed("interrupted", "Texture", { compressionState: "encoding" }),
      indexed("reencoding", "Texture", { compressionState: "compressed" }),
      indexed("done", "Texture", { compressionState: "compressed" }),
      indexed("failed", "Texture", { compressionState: "encode_failed" }),
      indexed("plain", "Texture", {}),
      indexed("model", "Model", { compressionState: "pending" }),
    ];
    expect(unfinishedTextureEncodePaths(assets, new Set(["reencoding"]))).toEqual([
      "assets/queued.hasset",
      "assets/interrupted.hasset",
      "assets/reencoding.hasset",
    ]);
  });
});
