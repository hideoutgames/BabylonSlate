import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { AssetRegistry } from "./registry";
import { EncodeQueue } from "./encode-queue";
import {
  encodeSettingsHash,
  ktx2ChunkId,
  sniffImageSize,
} from "./texture-compression";
import { encodeBabasset } from "./babasset";
import { projectContentRoot } from "./content-root";

/** Real KTX2 container bytes (valid magic + dimensions) for selection tests. */
function makeKtx2(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(28);
  bytes.set(
    [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x32, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a],
    0,
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  return bytes;
}

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

async function makeRegistryWithTexture(options?: {
  usage?: string;
}): Promise<{ registry: AssetRegistry; guid: string }> {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("chunks.babproject");
  await storage.mkdir("assets", true);
  const registry = new AssetRegistry(storage);
  const queue = new EncodeQueue({
    encode: async (source, settings) => ({
      ktx2: makeKtx2(settings.maxDimension, settings.maxDimension),
      wallMs: 1,
    }),
    onComplete: async (result) => {
      await registry.commitCompressedTexture(result);
    },
  });
  registry.setEncodePipeline(queue);
  await registry.mountRoot(projectContentRoot());
  const name = options?.usage ? `${options.usage}-tex.png` : "albedo.png";
  const [texture] = await registry.importFile(
    "project",
    "",
    name,
    pngBytes(1236, 2390),
  );
  return { registry, guid: texture!.header.guid };
}

describe("AssetRegistry.readBestTextureChunk", () => {
  it("returns the encoded KTX2 variant once compression lands", async () => {
    const { registry, guid } = await makeRegistryWithTexture();
    await vi.waitFor(() => {
      expect(registry.getByGuid(guid)!.header.payload.compressionState).toBe(
        "compressed",
      );
    });
    const best = await registry.readBestTextureChunk(guid, { lod: "off" });
    expect(best?.kind).toBe("ktx2");
    expect(best?.mime).toBe("image/ktx2");
    expect(sniffImageSize(best!.bytes)).toEqual({ width: 2048, height: 2048 });
    expect(best?.clampedByLod).toBe(false);
  });

  it("selects a smaller LOD variant and encodes it on demand", async () => {
    const { registry, guid } = await makeRegistryWithTexture();
    await vi.waitFor(() => {
      expect(registry.getByGuid(guid)!.header.payload.compressionState).toBe(
        "compressed",
      );
    });

    // First aggressive read: no 512 variant yet -> full variant + background encode.
    const first = await registry.readBestTextureChunk(guid, { lod: "aggressive" });
    expect(first?.kind).toBe("ktx2");
    expect(first?.clampedByLod).toBe(false);

    // The requested cap is min(512, project max) — hash must match the queued job.
    const expectedId = ktx2ChunkId(
      await encodeSettingsHash({
        format: "uastc",
        quality: 2,
        maxDimension: 512,
        generateMipmaps: true,
      }),
    );
    await vi.waitFor(() => {
      const header = registry.getByGuid(guid)!.header;
      expect(header.chunks.some((chunk) => chunk.id === expectedId)).toBe(true);
    });

    // Second read finds the LOD variant.
    const second = await registry.readBestTextureChunk(guid, { lod: "aggressive" });
    expect(second?.kind).toBe("ktx2");
    expect(second?.clampedByLod).toBe(true);
    expect(sniffImageSize(second!.bytes)).toEqual({ width: 512, height: 512 });
  });

  it("falls back to raw pixels for uncompressed-policy textures and pending states", async () => {
    const { registry, guid } = await makeRegistryWithTexture({ usage: "pixelArt" });
    const best = await registry.readBestTextureChunk(guid, { lod: "tiny" });
    expect(best?.kind).toBe("pixels");
    expect(sniffImageSize(best!.bytes)).toEqual({ width: 1236, height: 2390 });
    expect(await registry.readBestTextureChunk("missing-guid")).toBeNull();
  });

  it("still reads legacy assets written without the accessor (babasset round-trip)", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("legacy.babproject");
    await storage.mkdir("assets", true);
    const file = await encodeBabasset({
      header: {
        guid: "legacy-tex",
        type: "Texture",
        name: "Legacy",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        parentClass: null,
        payload: { usage: "albedo", compressionState: "fallback_uncompressed" },
      },
      chunks: [
        { id: "pixels", kind: "pixels", mime: "image/png", data: pngBytes(64, 64) },
      ],
      writeBlob: async () => "blob-hash",
    });
    await storage.writeBinary("assets/Legacy.babasset", file);
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const best = await registry.readBestTextureChunk("legacy-tex");
    expect(best?.kind).toBe("pixels");
    expect(best?.bytes.byteLength).toBe(24);
  });
});

describe("readBestTextureChunk tier precedence", () => {
  async function mountTextureWithVariants(options: {
    buildDownsample?: string;
    pngWidth?: number;
    pngHeight?: number;
  }): Promise<AssetRegistry> {
    const width = options.pngWidth ?? 1236;
    const height = options.pngHeight ?? 2390;
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("tiers.babproject");
    await storage.mkdir("assets", true);

    const settings = { format: "uastc" as const, quality: 2, generateMipmaps: true };
    const cap = (denominator: number) =>
      Math.ceil(Math.max(width, height) / denominator);
    const halfId = ktx2ChunkId(await encodeSettingsHash({ ...settings, maxDimension: cap(2) }));
    const tinyId = ktx2ChunkId(await encodeSettingsHash({ ...settings, maxDimension: 128 }));

    const payload: Record<string, unknown> = { usage: "albedo", compressionState: "compressed" };
    if (options.buildDownsample) payload.buildDownsample = options.buildDownsample;

    const file = await encodeBabasset({
      header: {
        guid: "tiered-tex",
        type: "Texture",
        name: "Tiered",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        parentClass: null,
        payload,
      },
      chunks: [
        { id: "pixels", kind: "pixels", mime: "image/png", data: pngBytes(width, height) },
        // Order matters: pointer-less fallback picks the LAST ktx2 entry.
        { id: tinyId, kind: "ktx2", mime: "image/ktx2", data: makeKtx2(128, 128) },
        { id: halfId, kind: "ktx2", mime: "image/ktx2", data: makeKtx2(cap(2), cap(2)) },
      ],
      writeBlob: async () => "blob-hash",
    });
    await storage.writeBinary("assets/Tiered.babasset", file);
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    return registry;
  }

  it("an authored non-source tier overrides the editor LOD level", async () => {
    const registry = await mountTextureWithVariants({ buildDownsample: "1/2" });
    // tiny LOD would want 128, but the authored 1/2 (cap 1195) wins.
    const best = await registry.readBestTextureChunk("tiered-tex", { lod: "tiny" });
    expect(best?.kind).toBe("ktx2");
    expect(sniffImageSize(best!.bytes)).toEqual({
      width: Math.ceil(2390 / 2),
      height: Math.ceil(2390 / 2),
    });
  });

  it("without a tier, the editor LOD level drives variant selection", async () => {
    const registry = await mountTextureWithVariants({});
    const best = await registry.readBestTextureChunk("tiered-tex", { lod: "tiny" });
    expect(best?.kind).toBe("ktx2");
    expect(sniffImageSize(best!.bytes)).toEqual({ width: 128, height: 128 });
  });
});
