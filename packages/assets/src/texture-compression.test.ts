import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { EncodeQueue } from "./encode-queue";
import {
  clampDimension,
  encodeSettingsHash,
  ktx2ChunkId,
  shouldCompressTexture,
  stubEncodeKtx2,
} from "./texture-compression";
import { selectTextureChunk } from "./texture-loader";
import { encodeBabasset, readBabassetHeader } from "./babasset";
import { projectContentRoot } from "./content-root";
import { AssetRegistry } from "./registry";

describe("texture compression policy", () => {
  it("leaves pixel art, sprites, UI and fonts uncompressed", () => {
    expect(shouldCompressTexture("albedo")).toBe(true);
    expect(shouldCompressTexture("normal")).toBe(true);
    expect(shouldCompressTexture("pixelArt")).toBe(false);
    expect(shouldCompressTexture("sprite")).toBe(false);
    expect(shouldCompressTexture("ui")).toBe(false);
    expect(shouldCompressTexture("font")).toBe(false);
  });

  it("clamps dimensions to the project max", () => {
    expect(clampDimension(4096, 2048, 2048)).toEqual({
      width: 2048,
      height: 1024,
      clamped: true,
    });
    expect(clampDimension(1024, 512, 2048).clamped).toBe(false);
  });
});

describe("EncodeQueue", () => {
  it("runs one job at a time and reports compressed state", async () => {
    const states: string[] = [];
    const completed: string[] = [];
    const queue = new EncodeQueue({
      recycleAfter: 2,
      onState: (guid, state) => states.push(`${guid}:${state}`),
      onComplete: (result) => {
        completed.push(result.assetGuid);
      },
    });

    queue.enqueue({
      assetGuid: "a",
      source: new Uint8Array([1, 2, 3]),
      settings: {
        format: "uastc",
        quality: 2,
        maxDimension: 2048,
        generateMipmaps: true,
      },
    });
    queue.enqueue({
      assetGuid: "b",
      source: new Uint8Array([4]),
      settings: {
        format: "uastc",
        quality: 2,
        maxDimension: 2048,
        generateMipmaps: true,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completed).toEqual(["a", "b"]);
    expect(states).toContain("a:encoding");
    expect(states).toContain("a:compressed");
    expect(queue.recycleCount).toBe(1);
  });

  it("pauses during Preview/background and resumes later", async () => {
    const completed: string[] = [];
    const queue = new EncodeQueue({
      onComplete: (result) => {
        completed.push(result.assetGuid);
      },
    });
    queue.pause();
    queue.enqueue({
      assetGuid: "paused",
      source: new Uint8Array([9]),
      settings: {
        format: "uastc",
        quality: 2,
        maxDimension: 2048,
        generateMipmaps: true,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(completed).toEqual([]);
    queue.resume();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completed).toEqual(["paused"]);
  });
});

describe("selectTextureChunk", () => {
  it("prefers KTX2 when transcoder is available", async () => {
    const bytes = await encodeBabasset({
      header: {
        guid: "t1",
        type: "Texture",
        name: "t",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        parentClass: null,
        payload: { compressionState: "compressed" },
      },
      chunks: [
        {
          id: "pixels",
          kind: "pixels",
          mime: "image/png",
          data: new Uint8Array([1]),
        },
        {
          id: ktx2ChunkId("abc"),
          kind: "ktx2",
          mime: "image/ktx2",
          data: new Uint8Array([2]),
        },
      ],
    });
    const header = readBabassetHeader(bytes);
    expect(selectTextureChunk(header).kind).toBe("ktx2");
    expect(
      selectTextureChunk(header, { transcoderAvailable: false }).kind,
    ).toBe("source");
    expect(
      selectTextureChunk(header, { supportedFormatsEmpty: true }).reason,
    ).toBe("supported-formats-empty");
  });
});

describe("stubEncodeKtx2", () => {
  it("produces settings-keyed output", async () => {
    const hash = await encodeSettingsHash({
      format: "uastc",
      quality: 2,
      maxDimension: 2048,
      generateMipmaps: true,
    });
    expect(hash.length).toBe(16);
    const { ktx2 } = await stubEncodeKtx2(new Uint8Array([1, 2]), {
      format: "uastc",
      quality: 2,
      maxDimension: 2048,
      generateMipmaps: true,
    });
    expect(new TextDecoder().decode(ktx2.subarray(0, 12))).toContain("BABS-KTX2");
  });
});

describe("registry encode pipeline", () => {
  it("enqueues compressible imports and commits a KTX2 chunk", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("encode.babproject");
    await storage.mkdir("assets", true);

    const registry = new AssetRegistry(storage);
    const queue = new EncodeQueue({
      onComplete: async (result) => {
        await registry.commitCompressedTexture(result);
      },
    });
    registry.setEncodePipeline(queue);
    await registry.mountRoot(projectContentRoot());

    const [texture] = await registry.importFile(
      "project",
      "",
      "albedo.png",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
    );
    expect(texture!.header.payload.compressionState).toBe("pending");

    await vi.waitFor(() => {
      const updated = registry.getByGuid(texture!.header.guid)!;
      expect(updated.header.payload.compressionState).toBe("compressed");
      expect(updated.header.chunks.some((chunk) => chunk.kind === "ktx2")).toBe(
        true,
      );
    });
  });

  it("retries encode_failed textures", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("retry.babproject");
    await storage.mkdir("assets", true);
    const bytes = await encodeBabasset({
      header: {
        guid: "fail-tex",
        type: "Texture",
        name: "Fail",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        parentClass: null,
        payload: { compressionState: "encode_failed", usage: "albedo" },
      },
      chunks: [
        {
          id: "pixels",
          kind: "pixels",
          mime: "image/png",
          data: new Uint8Array([9, 8, 7]),
        },
      ],
    });
    await storage.writeBinary("assets/fail.babasset", bytes);

    const registry = new AssetRegistry(storage);
    let attempts = 0;
    const queue = new EncodeQueue({
      encode: async (source, settings) => {
        attempts += 1;
        if (attempts === 1) throw new Error("boom");
        return stubEncodeKtx2(source, settings);
      },
      onComplete: async (result) => {
        await registry.commitCompressedTexture(result);
      },
      onError: async (guid) => {
        await registry.setCompressionState(guid, "encode_failed");
      },
    });
    registry.setEncodePipeline(queue);
    await registry.mountRoot(projectContentRoot());

    queue.enqueue({
      assetGuid: "fail-tex",
      source: new Uint8Array([9, 8, 7]),
      settings: {
        format: "uastc",
        quality: 2,
        maxDimension: 2048,
        generateMipmaps: true,
      },
    });
    await vi.waitFor(() => {
      expect(
        registry.getByGuid("fail-tex")!.header.payload.compressionState,
      ).toBe("encode_failed");
    });

    await registry.retryTextureEncoding("fail-tex");
    await vi.waitFor(() => {
      expect(
        registry.getByGuid("fail-tex")!.header.payload.compressionState,
      ).toBe("compressed");
    });
    expect(attempts).toBe(2);
  });
});
