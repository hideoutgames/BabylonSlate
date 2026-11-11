import { describe, expect, it } from "vitest";
import type { IndexedAsset } from "@haptic/assets";
import { appIconTextureHint, appIconTextureProblem, readAppIconSource, type AppIconSourceHost } from "./app-icon";

type Chunk = { id: string; kind?: string; mime?: string };

function asset(type: string, chunks: Chunk[], payload: Record<string, unknown> = {}): IndexedAsset {
  return { header: { guid: "tex-icon", name: "T_Icon", type, payload, chunks, dependencies: [] }, path: "assets/T_Icon.hasset", rootId: "project" } as unknown as IndexedAsset;
}

function host(indexed: IndexedAsset | undefined, chunks: Record<string, Uint8Array> = {}): AppIconSourceHost & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    getByGuid: (guid) => (guid === "tex-icon" ? indexed : undefined),
    readAssetChunk: async (path, chunkId) => {
      reads.push(`${path}#${chunkId}`);
      return chunks[chunkId] ?? null;
    },
  };
}

describe("App Icon source", () => {
  it("reads the Texture's source pixels with their type, never its GPU encode", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const project = host(asset("Texture", [{ id: "ktx2-1", kind: "ktx2" }, { id: "src", kind: "pixels", mime: "image/webp" }]), { src: png, "ktx2-1": new Uint8Array([9]) });
    const blob = await readAppIconSource(project, "tex-icon");
    expect(blob.type).toBe("image/webp");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(png);
    expect(project.reads).toEqual(["assets/T_Icon.hasset#src"]);
  });

  it("names the problem when the Texture is gone, not a Texture, or has no readable source", async () => {
    await expect(readAppIconSource(host(undefined), "tex-icon"))
      .rejects.toThrow("The App Icon Texture is missing. Choose another in Project Settings > Export.");
    await expect(readAppIconSource(host(asset("Material", [{ id: "pixels", kind: "pixels" }])), "tex-icon")).rejects.toThrow("The App Icon Texture is missing.");
    await expect(readAppIconSource(host(asset("Texture", [{ id: "ktx2-1", kind: "ktx2" }])), "tex-icon"))
      .rejects.toThrow("The App Icon Texture T_Icon has no source image. Choose another in Project Settings > Export.");
    await expect(readAppIconSource(host(asset("Texture", [{ id: "pixels", kind: "pixels" }])), "tex-icon")).rejects.toThrow("has no source image");
  });

  it("refuses only a missing Texture, and notes one packaging crops or scales up", () => {
    expect(appIconTextureProblem(undefined)).toBe("The Texture is missing.");
    expect(appIconTextureProblem(asset("Material", []))).toBe("The Texture is missing.");
    expect(appIconTextureProblem(asset("Texture", [], { width: 640, height: 480 }))).toBeNull();
    expect(appIconTextureHint(asset("Texture", [], { width: 1024, height: 1024 }))).toBeNull();
    expect(appIconTextureHint(asset("Texture", [], { width: 640, height: 640 })))
      .toBe("This image is 640 × 640. Icons up to 1024 × 1024 are scaled up and may look soft.");
    expect(appIconTextureHint(asset("Texture", []))).toBeNull();
    expect(appIconTextureHint(undefined)).toBeNull();
  });
});
