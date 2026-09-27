import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { EncodeQueue } from "./encode-queue";
import {
  clampDimension,
  DEFAULT_TEXTURE_ENCODE_SETTINGS,
  effectiveTextureMaxDimension,
  encodeSettingsHash,
  ktx2ChunkId,
  shouldCompressTexture,
  stubEncodeKtx2,
  textureEncodeBlockAlign,
  textureEncodeSize,
  type TextureEncodeSettings,
} from "./texture-compression";
import { selectTextureChunk } from "./texture-loader";
import { encodeBabasset, readBabassetHeader } from "./babasset";
import { resolveGpuTexture } from "./resolve-gpu-texture";
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
    expect(shouldCompressTexture("particle")).toBe(true);
  });

  it("block-aligns Particle encode sizes after the max-dimension clamp", () => {
    const particle = (width: number, height: number, maxDimension = 2048) =>
      textureEncodeSize(width, height, {
        maxDimension,
        blockAlign: textureEncodeBlockAlign("particle"),
      });
    expect(particle(1, 1)).toEqual({ width: 4, height: 4, clamped: false });
    expect(particle(1000, 750)).toEqual({ width: 1000, height: 752, clamped: false });
    expect(particle(512, 384)).toEqual({ width: 512, height: 384, clamped: false });
    // 3000x1001 clamps to 2048x683, then aligns; the aligned edge may exceed a
    // tiny clamp (1x1 clamped to 1 still encodes at 4x4).
    expect(particle(3000, 1001)).toEqual({ width: 2048, height: 684, clamped: true });
    expect(particle(1000, 750, 250)).toEqual({ width: 252, height: 188, clamped: true });
    // Every other Usage keeps its unaligned clamp.
    expect(
      textureEncodeSize(1000, 750, {
        maxDimension: 250,
        blockAlign: textureEncodeBlockAlign("albedo"),
      }),
    ).toEqual({ width: 250, height: 188, clamped: true });
  });

  it("keys block alignment into the KTX2 chunk id only when set", async () => {
    // Existing chunk ids on disk must not change for unaligned encodes.
    expect(await encodeSettingsHash(DEFAULT_TEXTURE_ENCODE_SETTINGS)).toBe(
      "34dad383eac5f9b6",
    );
    const unaligned: TextureEncodeSettings = {
      ...DEFAULT_TEXTURE_ENCODE_SETTINGS,
      blockAlign: undefined,
    };
    expect(await encodeSettingsHash(unaligned)).toBe("34dad383eac5f9b6");
    expect(
      await encodeSettingsHash({ ...DEFAULT_TEXTURE_ENCODE_SETTINGS, blockAlign: 4 }),
    ).not.toBe("34dad383eac5f9b6");
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
  it("runs one job at a time and reports compressed state", async ({
    onTestFinished,
  }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
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

    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toEqual(["a", "b"]);
    expect(states).toContain("a:encoding");
    expect(states).toContain("a:compressed");
    expect(queue.recycleCount).toBe(1);
  });

  it("pauses during Preview/background and resumes later", async ({
    onTestFinished,
  }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
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
    await vi.advanceTimersByTimeAsync(10);
    expect(completed).toEqual([]);
    queue.resume();
    await vi.advanceTimersByTimeAsync(0);
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
    expect(new TextDecoder().decode(ktx2.subarray(0, 12))).toContain(
      "BABS-KTX2",
    );
  });
});

/** Minimal KTX2 header: identifier plus pixelWidth / pixelHeight. */
function ktx2Header(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  return bytes;
}

/** PNG signature + IHDR size of a 1x1 image (enough for size sniffing). */
function onePixelPng(): Uint8Array {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  png[19] = 1;
  png[23] = 1;
  return png;
}

async function mountSingleTexture(
  name: string,
  payload: Record<string, unknown>,
  extraChunks: { id: string; kind: string; mime: string; data: Uint8Array }[] = [],
) {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject(`${name}.babproject`);
  await storage.mkdir("assets", true);
  const path = `assets/${name}.babasset`;
  await storage.writeBinary(
    path,
    await encodeBabasset({
      header: {
        guid: `${name}-tex`,
        type: "Texture",
        name,
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        parentClass: null,
        payload,
      },
      chunks: [
        { id: "pixels", kind: "pixels", mime: "image/png", data: onePixelPng() },
        ...extraChunks,
      ],
    }),
  );
  const registry = new AssetRegistry(storage);
  const settings: TextureEncodeSettings[] = [];
  const queue = new EncodeQueue({
    // Stand-in encoder: a KTX2 header at the size the real encoders produce.
    encode: async (_source, encodeSettings) => {
      settings.push(encodeSettings);
      const size = textureEncodeSize(1, 1, encodeSettings);
      return { ktx2: ktx2Header(size.width, size.height), wallMs: 0 };
    },
    onComplete: async (result) => {
      await registry.commitCompressedTexture(result);
    },
  });
  registry.setEncodePipeline(queue);
  await registry.mountRoot(projectContentRoot());
  const readChunk = async (chunkId: string) => {
    const file = await storage.readBinary(path);
    const entry = registry.getByGuid(`${name}-tex`)!.header.chunks.find((chunk) => chunk.id === chunkId);
    return entry ? registry.payloadLoader.loadChunk(file, entry) : null;
  };
  return { registry, settings, readChunk, guid: `${name}-tex` };
}

describe("registry encode pipeline", () => {
  it("re-encodes an unsaved Usage change to Particle block-aligned, and that encode is bound", async () => {
    const { registry, settings, readChunk, guid } = await mountSingleTexture(
      "spark",
      { usage: "albedo", width: 1, height: 1, compressionState: "compressed", ktx2ChunkId: "ktx2:albedo" },
      [{ id: "ktx2:albedo", kind: "ktx2", mime: "image/ktx2", data: ktx2Header(1, 1) }],
    );
    // Details edits live in the open document, so the saved header still says Albedo.
    expect(await registry.retryTextureEncoding(guid, { force: true, usage: "particle" })).toBe(true);
    await vi.waitFor(() => {
      const payload = registry.getByGuid(guid)!.header.payload;
      expect(payload.compressionState).toBe("compressed");
      expect(payload.ktx2ChunkId).not.toBe("ktx2:albedo");
    });
    expect(settings.map((entry) => entry.blockAlign)).toEqual([4]);

    const saved = registry.getByGuid(guid)!.header;
    const resolved = await resolveGpuTexture({
      header: { ...saved, payload: { ...saved.payload, usage: "particle" } },
      readChunk,
      editorLod: { enabled: true, quality: 0.5 },
    });
    expect(resolved?.kind).toBe("ktx2");
    expect(resolved?.chunkId).toBe(saved.payload.ktx2ChunkId);
    expect(resolved?.missingPreferred).toBe(false);
    expect(Array.from(resolved!.bytes.subarray(20, 28))).toEqual([4, 0, 0, 0, 4, 0, 0, 0]);
  });

  it("lets an unsaved Particle Usage encode a Texture saved as uncompressed Pixel Art", async () => {
    const { registry, settings, guid } = await mountSingleTexture("ember", {
      usage: "pixelArt",
      width: 1,
      height: 1,
    });
    expect(await registry.retryTextureEncoding(guid, { force: true })).toBe(false);
    expect(await registry.retryTextureEncoding(guid, { force: true, usage: "particle" })).toBe(true);
    await vi.waitFor(() => {
      expect(registry.getByGuid(guid)!.header.payload.compressionState).toBe("compressed");
    });
    expect(settings.map((entry) => entry.blockAlign)).toEqual([4]);
  });

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

    expect(await registry.retryTextureEncoding("pend-tex")).toBe(true);
    expect(await registry.retryTextureEncoding("enc-tex")).toBe(true);
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
    const pixels = updated.header.chunks.find(
      (chunk) => chunk.kind === "pixels",
    )!;
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
    expect(updated.header.chunks.some((chunk) => chunk.kind === "pixels")).toBe(
      true,
    );
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
