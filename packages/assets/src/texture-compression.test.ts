import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { EncodeQueue } from "./encode-queue";
import {
  buildDownsampleCap,
  clampDimension,
  effectiveTextureMaxDimension,
  encodeSettingsHash,
  editorLodMaxDimension,
  isBuildDownsampleTier,
  isEditorTextureLod,
  ktx2ChunkId,
  shouldCompressTexture,
  sniffImageSize,
  stubEncodeKtx2,
  textureEffectiveLodCap,
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
    expect(shouldCompressTexture("skybox")).toBe(false);
  });

  it("clamps dimensions to the project max", () => {
    expect(clampDimension(4096, 2048, 2048)).toEqual({
      width: 2048,
      height: 1024,
      clamped: true,
    });
    expect(clampDimension(1024, 512, 2048).clamped).toBe(false);
  });

  it("takes the min of source, asset max, and project max", () => {
    expect(effectiveTextureMaxDimension(undefined, 2048)).toBe(2048);
    expect(effectiveTextureMaxDimension(1024, 2048)).toBe(1024);
    expect(effectiveTextureMaxDimension(4096, 2048)).toBe(2048);
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

  it("fails a hung encode on timeout and pumps the next job", async () => {
    const states: string[] = [];
    const completed: string[] = [];
    const errors: string[] = [];
    const queue = new EncodeQueue({
      jobTimeoutMs: 20,
      encode: async (source, settings) => {
        if (source[0] === 1) {
          await new Promise(() => undefined);
        }
        return stubEncodeKtx2(source, settings);
      },
      onState: (guid, state) => states.push(`${guid}:${state}`),
      onComplete: (result) => {
        completed.push(result.assetGuid);
      },
      onError: (guid) => {
        errors.push(guid);
      },
    });
    queue.enqueue({
      assetGuid: "hang",
      source: new Uint8Array([1]),
      settings: {
        format: "uastc",
        quality: 2,
        maxDimension: 2048,
        generateMipmaps: true,
      },
    });
    queue.enqueue({
      assetGuid: "ok",
      source: new Uint8Array([2]),
      settings: {
        format: "uastc",
        quality: 2,
        maxDimension: 2048,
        generateMipmaps: true,
      },
    });
    await vi.waitFor(() => {
      expect(errors).toEqual(["hang"]);
      expect(completed).toEqual(["ok"]);
    });
    expect(states).toContain("hang:encoding");
    expect(states).toContain("hang:encode_failed");
    expect(states).toContain("ok:compressed");
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

  it("retries pending and interrupted encoding textures", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("pending.babproject");
    await storage.mkdir("assets", true);
    for (const [guid, name, state] of [
      ["pend-tex", "Pend", "pending"],
      ["enc-tex", "Enc", "encoding"],
    ] as const) {
      const bytes = await encodeBabasset({
        header: {
          guid,
          type: "Texture",
          name,
          engineVersion: "0.0.0",
          version: 1,
          mode: "thin",
          dependencies: [],
          parentClass: null,
          payload: { compressionState: state, usage: "albedo" },
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
      await storage.writeBinary(`assets/${name.toLowerCase()}.babasset`, bytes);
    }

    const registry = new AssetRegistry(storage);
    const queue = new EncodeQueue({
      onComplete: async (result) => {
        await registry.commitCompressedTexture(result);
      },
    });
    registry.setEncodePipeline(queue);
    await registry.mountRoot(projectContentRoot());

    expect(
      await registry.retryTextureEncoding("pend-tex"),
    ).toBe(true);
    expect(
      await registry.retryTextureEncoding("enc-tex"),
    ).toBe(true);
    await vi.waitFor(() => {
      expect(
        registry.getByGuid("pend-tex")!.header.payload.compressionState,
      ).toBe("compressed");
      expect(
        registry.getByGuid("enc-tex")!.header.payload.compressionState,
      ).toBe("compressed");
    });
  });

  it("requeues pending and encoding textures on remount", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("requeue.babproject");
    await storage.mkdir("assets", true);
    const bytes = await encodeBabasset({
      header: {
        guid: "stuck-tex",
        type: "Texture",
        name: "Stuck",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        parentClass: null,
        payload: { compressionState: "encoding", usage: "albedo" },
      },
      chunks: [
        {
          id: "pixels",
          kind: "pixels",
          mime: "image/png",
          data: new Uint8Array([3, 2, 1]),
        },
      ],
    });
    await storage.writeBinary("assets/stuck.babasset", bytes);

    const registry = new AssetRegistry(storage);
    const queue = new EncodeQueue({
      onComplete: async (result) => {
        await registry.commitCompressedTexture(result);
      },
    });
    registry.setEncodePipeline(queue);
    await registry.mountRoot(projectContentRoot());
    const count = await registry.requeueUncompressedTextures();
    expect(count).toBe(1);
    await vi.waitFor(() => {
      expect(
        registry.getByGuid("stuck-tex")!.header.payload.compressionState,
      ).toBe("compressed");
    });
  });

  it("keeps source pixels when encode_failed is recorded with an error", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("pixels.babproject");
    await storage.mkdir("assets", true);
    const bytes = await encodeBabasset({
      header: {
        guid: "keep-tex",
        type: "Texture",
        name: "Keep",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        parentClass: null,
        payload: { compressionState: "encoding", usage: "albedo" },
      },
      chunks: [
        {
          id: "pixels",
          kind: "pixels",
          mime: "image/png",
          data: new Uint8Array([9, 8, 7, 6]),
        },
      ],
    });
    await storage.writeBinary("assets/keep.babasset", bytes);
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());

    await registry.setCompressionState("keep-tex", "encode_failed", {
      error: "BasisEncoder.encode returned 0",
    });
    const updated = registry.getByGuid("keep-tex")!;
    expect(updated.header.payload.compressionState).toBe("encode_failed");
    expect(updated.header.payload.encodeError).toBe(
      "BasisEncoder.encode returned 0",
    );
    expect(
      updated.header.chunks.some(
        (chunk) => chunk.kind === "pixels" || chunk.id === "pixels",
      ),
    ).toBe(true);
    const selected = selectTextureChunk(updated.header);
    expect(selected.kind).toBe("source");
    const fileBytes = await storage.readBinary("assets/keep.babasset");
    const pixels = updated.header.chunks.find((chunk) => chunk.kind === "pixels")!;
    const loaded = await registry.payloadLoader.loadChunk(fileBytes, pixels);
    expect(loaded).toEqual(new Uint8Array([9, 8, 7, 6]));
  });

  it("clears encodeError when a later encode commits KTX2", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("clear-err.babproject");
    await storage.mkdir("assets", true);
    const bytes = await encodeBabasset({
      header: {
        guid: "clear-tex",
        type: "Texture",
        name: "Clear",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        parentClass: null,
        payload: {
          compressionState: "encode_failed",
          usage: "albedo",
          encodeError: "old failure",
        },
      },
      chunks: [
        {
          id: "pixels",
          kind: "pixels",
          mime: "image/png",
          data: new Uint8Array([1]),
        },
      ],
    });
    await storage.writeBinary("assets/clear.babasset", bytes);
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    await registry.commitCompressedTexture({
      assetGuid: "clear-tex",
      ktx2: new Uint8Array([2, 3]),
      wallMs: 4,
      settings: {
        format: "uastc",
        quality: 2,
        maxDimension: 2048,
        generateMipmaps: true,
      },
    });
    const updated = registry.getByGuid("clear-tex")!;
    expect(updated.header.payload.compressionState).toBe("compressed");
    expect(updated.header.payload.encodeError).toBeUndefined();
    expect(
      updated.header.chunks.some((chunk) => chunk.kind === "pixels"),
    ).toBe(true);
  });

  it("does not let a slow encoding write clobber encode_failed", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("race.babproject");
    await storage.mkdir("assets", true);
    const bytes = await encodeBabasset({
      header: {
        guid: "race-tex",
        type: "Texture",
        name: "Race",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        parentClass: null,
        payload: { compressionState: "pending", usage: "albedo" },
      },
      chunks: [
        {
          id: "pixels",
          kind: "pixels",
          mime: "image/png",
          data: new Uint8Array([1]),
        },
      ],
    });
    await storage.writeBinary("assets/race.babasset", bytes);
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());

    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const originalWrite = storage.writeBinary.bind(storage);
    let writes = 0;
    storage.writeBinary = async (path, data) => {
      writes += 1;
      if (writes === 1) await firstGate;
      return originalWrite(path, data);
    };

    const encoding = registry.setCompressionState("race-tex", "encoding");
    const failed = registry.setCompressionState("race-tex", "encode_failed");
    await Promise.resolve();
    releaseFirst();
    await Promise.all([encoding, failed]);
    expect(
      registry.getByGuid("race-tex")!.header.payload.compressionState,
    ).toBe("encode_failed");
  });
});

describe("editor texture LOD levels", () => {
  it("graduates caps by level and exempts small sources outside tiny", () => {
    // off never scales
    expect(editorLodMaxDimension(4096, "off")).toBe(4096);
    expect(editorLodMaxDimension(100, "off")).toBe(100);
    // balanced: large drops hard, mid-size untouched
    expect(editorLodMaxDimension(4096, "balanced")).toBe(1024);
    expect(editorLodMaxDimension(1236, "balanced")).toBe(1024);
    expect(editorLodMaxDimension(1024, "balanced")).toBe(1024);
    // aggressive / minimal
    expect(editorLodMaxDimension(2048, "aggressive")).toBe(512);
    expect(editorLodMaxDimension(600, "aggressive")).toBe(512);
    expect(editorLodMaxDimension(300, "minimal")).toBe(256);
    // <256px sources are exempt at every level except tiny
    expect(editorLodMaxDimension(255, "balanced")).toBe(255);
    expect(editorLodMaxDimension(128, "aggressive")).toBe(128);
    expect(editorLodMaxDimension(200, "minimal")).toBe(200);
    // tiny scales everything up to the 128 cap
    expect(editorLodMaxDimension(4096, "tiny")).toBe(128);
    expect(editorLodMaxDimension(240, "tiny")).toBe(128);
    expect(editorLodMaxDimension(64, "tiny")).toBe(64);
  });

  it("guards the level union", () => {
    expect(isEditorTextureLod("balanced")).toBe(true);
    expect(isEditorTextureLod("tiny")).toBe(true);
    expect(isEditorTextureLod("huge")).toBe(false);
    expect(isEditorTextureLod(2)).toBe(false);
  });

  it("scales non-square sources proportionally via clampDimension", () => {
    // plan example: 1236x2390 -> 530x1024 at balanced (one uniform factor)
    expect(clampDimension(1236, 2390, editorLodMaxDimension(2390, "balanced"))).toEqual({
      width: 530,
      height: 1024,
      clamped: true,
    });
    expect(clampDimension(1236, 2390, editorLodMaxDimension(2390, "aggressive"))).toEqual({
      width: 265,
      height: 512,
      clamped: true,
    });
    // tiny: everything lands <=128 longest edge
    expect(clampDimension(1236, 2390, editorLodMaxDimension(2390, "tiny"))).toEqual({
      width: 66,
      height: 128,
      clamped: true,
    });
    // untouched textures keep exact dimensions
    expect(clampDimension(640, 480, editorLodMaxDimension(640, "balanced")).clamped).toBe(false);
  });
});

describe("sniffImageSize", () => {
  function pngBytes(width: number, height: number): Uint8Array {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return bytes;
  }
  function jpegBytes(width: number, height: number): Uint8Array {
    const bytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 3,
    ]);
    const view = new DataView(bytes.buffer);
    view.setUint16(7, height);
    view.setUint16(9, width);
    return bytes;
  }
  function ktx2Bytes(width: number, height: number): Uint8Array {
    const bytes = new Uint8Array(28);
    bytes.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x32, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const view = new DataView(bytes.buffer);
    view.setUint32(20, width, true);
    view.setUint32(24, height, true);
    return bytes;
  }

  it("reads PNG IHDR dimensions", () => {
    expect(sniffImageSize(pngBytes(1236, 2390))).toEqual({ width: 1236, height: 2390 });
  });
  it("scans JPEG markers for SOF dimensions", () => {
    expect(sniffImageSize(jpegBytes(800, 600))).toEqual({ width: 800, height: 600 });
  });
  it("reads KTX2 pixelWidth/pixelHeight", () => {
    expect(sniffImageSize(ktx2Bytes(530, 1024))).toEqual({ width: 530, height: 1024 });
  });
  it("returns null for unknown or malformed bytes", () => {
    expect(sniffImageSize(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(sniffImageSize(pngBytes(0, 10))).toBeNull();
  });
});

describe("build downsample tiers", () => {
  it("parses the authored tier list and rejects junk", () => {
    expect(isBuildDownsampleTier("source")).toBe(true);
    expect(isBuildDownsampleTier("1/3")).toBe(true);
    expect(isBuildDownsampleTier("1/16")).toBe(true);
    expect(isBuildDownsampleTier("1/5")).toBe(false);
    expect(isBuildDownsampleTier(0.5)).toBe(false);
  });

  it("computes fractional longest-edge caps (ceiling, min 1)", () => {
    expect(buildDownsampleCap(2390, "1/2")).toBe(1195);
    expect(buildDownsampleCap(1000, "1/3")).toBe(334);
    expect(buildDownsampleCap(10, "1/16")).toBe(1);
    expect(buildDownsampleCap(1236, "source")).toBe(1236);
  });
});

describe("textureEffectiveLodCap precedence", () => {
  it("authored tier beats legacy cap beats editor LOD", () => {
    const base = { longestEdge: 4096 };
    // Tier wins even when LOD would say 1024 and legacy says 2048.
    expect(
      textureEffectiveLodCap({
        ...base,
        buildDownsample: "1/8",
        legacyMaxDimension: 2048,
        lod: "balanced",
      }),
    ).toBe(512);
    // Source tier defers: legacy numeric cap honored next.
    expect(
      textureEffectiveLodCap({
        longestEdge: 4096,
        buildDownsample: "source",
        legacyMaxDimension: 1024,
        lod: "aggressive",
      }),
    ).toBe(1024);
    // No tier, no legacy -> editor LOD applies.
    expect(textureEffectiveLodCap({ longestEdge: 4096, lod: "balanced" })).toBe(
      1024,
    );
    // No LOD at all (export path) -> source edge.
    expect(textureEffectiveLodCap({ longestEdge: 4096 })).toBe(4096);
    // Invalid tier values are ignored, not thrown.
    expect(
      textureEffectiveLodCap({ longestEdge: 2048, buildDownsample: "9/5", lod: "off" }),
    ).toBe(2048);
  });

  it("clamps every branch to the project ceiling", () => {
    expect(
      textureEffectiveLodCap({
        longestEdge: 6000,
        buildDownsample: "1/2",
        projectMaxDimension: 2048,
      }),
    ).toBe(2048);
    expect(
      textureEffectiveLodCap({
        longestEdge: 3000,
        legacyMaxDimension: 4096,
        projectMaxDimension: 2048,
      }),
    ).toBe(2048);
  });

  it("keeps small textures exempt through the LOD branch only", () => {
    // LOD never touches <256 sources; tiers still apply (explicit author intent).
    expect(textureEffectiveLodCap({ longestEdge: 128, lod: "tiny" })).toBe(128);
    expect(
      textureEffectiveLodCap({ longestEdge: 128, buildDownsample: "1/4", lod: "tiny" }),
    ).toBe(32);
  });
});
