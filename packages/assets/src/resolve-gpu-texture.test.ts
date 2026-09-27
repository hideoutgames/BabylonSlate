import { describe, expect, it } from "vitest";
import type { BabassetHeader } from "./babasset";
import { resolveGpuTexture } from "./resolve-gpu-texture";

function ktx2Header(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  return bytes;
}

function chunk(id: string, kind: string): BabassetHeader["chunks"][number] {
  return { id, kind, mime: kind === "ktx2" ? "image/ktx2" : "image/png", sha256: id, locator: { inline: { offset: 0, length: 1 } } };
}

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

    // The retained encode must stop being used when the author changes Usage.
    asset.payload.usage = "pixelArt";
    const pixelArt = await resolveGpuTexture({
      header: asset,
      readChunk: async (id) => byId[id] ?? null,
      editorLod: { enabled: true, quality: 0.5 },
    });
    expect(pixelArt?.kind).toBe("source");
    expect(pixelArt?.bytes).toBe(png);
    expect(pixelArt?.targetEdge).toBe(4);
    expect(pixelArt?.missingPreferred).toBe(false);
  });

  it("never binds a block-misaligned KTX2 for a Particle Texture", async () => {
    const pixels = new Uint8Array([1, 2, 3, 4]);
    const byId: Record<string, Uint8Array> = {
      pixels,
      "ktx2:albedo": ktx2Header(1, 1),
    };
    const particle = header([chunk("pixels", "pixels"), chunk("ktx2:albedo", "ktx2")], {
      usage: "particle",
      width: 1,
      height: 1,
      ktx2ChunkId: "ktx2:albedo",
    });
    const readChunk = async (id: string) => byId[id] ?? null;

    // Only the retained encode from the earlier Albedo Usage exists.
    const stale = await resolveGpuTexture({ header: particle, readChunk, editorLod: { enabled: false, quality: 1 } });
    expect(stale?.kind).toBe("source");
    expect(stale?.bytes).toBe(pixels);
    expect(stale?.missingPreferred).toBe(true);

    // The Particle re-encode lands under the preferred id and is bound.
    const preferred = stale!.preferredChunkId!;
    byId[preferred] = ktx2Header(4, 4);
    particle.chunks.push(chunk(preferred, "ktx2"));
    const aligned = await resolveGpuTexture({ header: particle, readChunk, editorLod: { enabled: true, quality: 0.5 } });
    expect(aligned?.kind).toBe("ktx2");
    expect(aligned?.chunkId).toBe(preferred);
    expect(aligned?.missingPreferred).toBe(false);
  });

  it("falls back to the committed Particle encode when the preferred id drifts", async () => {
    // e.g. a project max dimension other than the default: the preferred id
    // misses, and the oldest (misaligned) KTX2 would otherwise be selected.
    const byId: Record<string, Uint8Array> = {
      pixels: new Uint8Array([1]),
      "ktx2:albedo": ktx2Header(1000, 750),
      "ktx2:particle": ktx2Header(1000, 752),
    };
    const particle = header(
      [chunk("pixels", "pixels"), chunk("ktx2:albedo", "ktx2"), chunk("ktx2:particle", "ktx2")],
      { usage: "particle", width: 1000, height: 750, ktx2ChunkId: "ktx2:particle" },
    );
    const resolved = await resolveGpuTexture({
      header: particle,
      readChunk: async (id) => byId[id] ?? null,
      editorLod: { enabled: false, quality: 1 },
    });
    expect(resolved?.kind).toBe("ktx2");
    expect(resolved?.chunkId).toBe("ktx2:particle");
    expect(resolved?.missingPreferred).toBe(true);
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
});
