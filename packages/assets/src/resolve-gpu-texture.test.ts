import { describe, expect, it } from "vitest";
import type { BabassetHeader } from "./babasset";
import { resolveGpuTexture } from "./resolve-gpu-texture";

function header(chunks: BabassetHeader["chunks"], payload: Record<string, unknown> = {}): BabassetHeader {
  return {
    guid: "tex-1",
    type: "Texture",
    name: "Hero",
    engineVersion: "0.0.0",
    version: 1,
    mode: "thin",
    dependencies: [],
    payload,
    chunks,
  };
}

describe("resolveGpuTexture", () => {
  it("prefers the matching ktx2 chunk for authored downsample", async () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    png.set([0, 0, 0, 13], 8);
    png.set([0x49, 0x48, 0x44, 0x52], 12);
    png[19] = 4;
    png[23] = 4;
    const chunks = [
      {
        id: "pixels",
        kind: "pixels",
        mime: "image/png",
        sha256: "aa",
        locator: { inline: { offset: 0, length: 1 } },
      },
      {
        id: "ktx2:stale",
        kind: "ktx2",
        mime: "image/ktx2",
        sha256: "old",
        locator: { inline: { offset: 1, length: 1 } },
      },
    ];
    const asset = header(chunks, {
      usage: "albedo",
      downsample: 1,
      ktx2ChunkId: "ktx2:stale",
      width: 4,
      height: 4,
    });
    const byId: Record<string, Uint8Array> = {
      pixels: png,
      "ktx2:stale": new Uint8Array([2, 3, 4]),
    };
    const resolved = await resolveGpuTexture({
      header: asset,
      readChunk: async (id) => byId[id] ?? null,
      editorLod: { enabled: false, quality: 0.5 },
    });
    expect(resolved?.kind).toBe("ktx2");
    expect(resolved?.chunkId).toBe("ktx2:stale");
  });

  it("does not bind a full-size KTX2 when editor LOD wants a smaller variant", async () => {
    const pixels = new Uint8Array([1, 2, 3, 4]);
    const asset = header(
      [
        {
          id: "pixels",
          kind: "pixels",
          mime: "image/png",
          sha256: "aa",
          locator: { inline: { offset: 0, length: 4 } },
        },
        {
          id: "ktx2:full",
          kind: "ktx2",
          mime: "image/ktx2",
          sha256: "full",
          locator: { inline: { offset: 1, length: 1 } },
        },
      ],
      {
        usage: "albedo",
        downsample: 1,
        ktx2ChunkId: "ktx2:full",
        width: 4096,
        height: 4096,
      },
    );
    const byId: Record<string, Uint8Array> = {
      pixels,
      "ktx2:full": new Uint8Array([9, 9, 9]),
    };
    const resolved = await resolveGpuTexture({
      header: asset,
      readChunk: async (id) => byId[id] ?? null,
      editorLod: { enabled: true, quality: 0.5 },
    });
    expect(resolved?.kind).toBe("source");
    expect(resolved?.chunkId).toBe("pixels");
    expect(resolved?.targetEdge).toBe(2048);
    expect(resolved?.missingPreferred).toBe(true);
  });

  it("forcePixelArt uses source pixels and skips KTX2 and editor LOD", async () => {
    const pixels = new Uint8Array([1, 2, 3, 4]);
    const asset = header(
      [
        {
          id: "pixels",
          kind: "pixels",
          mime: "image/png",
          sha256: "aa",
          locator: { inline: { offset: 0, length: 4 } },
        },
        {
          id: "ktx2:full",
          kind: "ktx2",
          mime: "image/ktx2",
          sha256: "full",
          locator: { inline: { offset: 1, length: 1 } },
        },
      ],
      {
        usage: "albedo",
        downsample: 1,
        ktx2ChunkId: "ktx2:full",
        width: 4096,
        height: 4096,
      },
    );
    const byId: Record<string, Uint8Array> = {
      pixels,
      "ktx2:full": new Uint8Array([9, 9, 9]),
    };
    const resolved = await resolveGpuTexture({
      header: asset,
      readChunk: async (id) => byId[id] ?? null,
      editorLod: { enabled: true, quality: 0.5 },
      forcePixelArt: true,
    });
    expect(resolved?.kind).toBe("source");
    expect(resolved?.chunkId).toBe("pixels");
    expect(resolved?.bytes).toEqual(pixels);
    expect(resolved?.targetEdge).toBe(4096);
  });
});
