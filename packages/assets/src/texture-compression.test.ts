import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { EncodeQueue, type EncodeJob, type EncodeJobResult } from "./encode-queue";
import {
  clampDimension,
  DEFAULT_TEXTURE_ENCODE_SETTINGS,
  effectiveTextureMaxDimension,
  encodeSettingsHash,
  ktx2ChunkId,
  shouldCompressTexture,
  stubEncodeKtx2,
  textureEncodeChunkId,
  textureEncodePadding,
  textureEncodeSize,
  type TextureEncodeSettings,
} from "./texture-compression";
import { selectTextureChunk } from "./texture-loader";
import { encodeHasset, readHassetHeader } from "./hasset";
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

  it("rounds encode sizes up to the block after the max-dimension clamp", () => {
    const aligned = (width: number, height: number, maxDimension = 2048) =>
      textureEncodeSize(width, height, { maxDimension, blockAlign: 4 });
    expect(aligned(1, 1)).toEqual({ width: 4, height: 4, clamped: false });
    expect(aligned(1000, 750)).toEqual({ width: 1000, height: 752, clamped: false });
    expect(aligned(512, 384)).toEqual({ width: 512, height: 384, clamped: false });
    // 3000x1001 clamps to 2048x683, then aligns; the aligned edge may exceed a
    // tiny clamp (1x1 clamped to 1 still encodes at 4x4).
    expect(aligned(3000, 1001)).toEqual({ width: 2048, height: 684, clamped: true });
    expect(aligned(1000, 750, 250)).toEqual({ width: 252, height: 188, clamped: true });
    expect(textureEncodeSize(1000, 750, { maxDimension: 250 })).toEqual({ width: 250, height: 188, clamped: true });
  });

  it("pads compressed encodes off the 4-texel grid, except atlases, and always pads Particle", () => {
    const cases: Array<[string, boolean, { width: number; height: number } | null, number | undefined]> = [
      ["albedo", false, { width: 1, height: 1 }, 4],
      ["normal", false, { width: 30, height: 30 }, 4],
      ["orm", false, { width: 64, height: 30 }, 4],
      // Already on the grid: no resample.
      ["albedo", false, { width: 64, height: 32 }, undefined],
      ["emissive", false, { width: 252, height: 188 }, undefined],
      // Unknown size (a source no sniffer reads): padding a grid size is a no-op.
      ["albedo", false, null, 4],
      // Atlases keep their size so tile and frame UVs stay put.
      ["albedo", true, { width: 1, height: 1 }, undefined],
      ["normal", true, null, undefined],
      ["particle", true, { width: 1, height: 1 }, 4],
      ["particle", false, { width: 64, height: 32 }, 4],
      // Uncompressed Usages never encode.
      ["pixelArt", false, { width: 1, height: 1 }, undefined],
      ["sprite", false, { width: 1, height: 1 }, undefined],
      ["ui", false, { width: 30, height: 30 }, undefined],
    ];
    for (const [usage, atlas, clampedSize, want] of cases) {
      expect(textureEncodePadding(usage, { atlas, clampedSize }), `${usage} atlas=${atlas} ${JSON.stringify(clampedSize)}`).toBe(want);
    }
  });

  it("keys block alignment for Particle only, so a padded encode keeps today's chunk id", async () => {
    // Padding is encode-only: it never changes a Usage's chunk id, so ids on
    // disk and the resolver's preferred id stay valid.
    expect(await encodeSettingsHash(DEFAULT_TEXTURE_ENCODE_SETTINGS)).toBe("34dad383eac5f9b6");
    const unaligned: TextureEncodeSettings = { ...DEFAULT_TEXTURE_ENCODE_SETTINGS, blockAlign: undefined };
    expect(await encodeSettingsHash(unaligned)).toBe("34dad383eac5f9b6");
    const padded: TextureEncodeSettings = { ...DEFAULT_TEXTURE_ENCODE_SETTINGS, blockAlign: 4 };
    expect(await textureEncodeChunkId(padded, "albedo")).toBe("ktx2:34dad383eac5f9b6");
    expect(await textureEncodeChunkId(DEFAULT_TEXTURE_ENCODE_SETTINGS, "normal")).toBe("ktx2:34dad383eac5f9b6");
    // Particle encodes have always keyed blockAlign; their ids stay too.
    expect(await textureEncodeChunkId(padded, "particle")).toBe("ktx2:be8efeb598b80ecc");
    expect(await textureEncodeChunkId(DEFAULT_TEXTURE_ENCODE_SETTINGS, "particle")).toBe("ktx2:be8efeb598b80ecc");
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

  it("fails a hung encode on timeout, aborts its encoder and pumps the next job", async () => {
    const states: string[] = [];
    const completed: string[] = [];
    const errors: string[] = [];
    let hungSignal: AbortSignal | undefined;
    const queue = new EncodeQueue({
      jobTimeoutMs: 20,
      encode: async (source, settings, _mime, signal) => {
        if (source[0] === 1) {
          hungSignal = signal;
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
    expect(hungSignal?.aborted).toBe(true);
  });

  it("drops waiting jobs and the running encode's result on clear", async () => {
    const settings = { format: "uastc", quality: 2, maxDimension: 2048, generateMipmaps: true } as const;
    let finish: (() => void) | undefined;
    const encoded: number[] = [];
    const completed: string[] = [];
    const dropped: string[] = [];
    const queue = new EncodeQueue({
      encode: async (source, encodeSettings) => {
        encoded.push(source[0]!);
        if (source[0] === 1) await new Promise<void>((resolve) => { finish = resolve; });
        return stubEncodeKtx2(source, encodeSettings);
      },
      onComplete: (result) => { completed.push(result.assetGuid); },
      onDrop: (job) => { dropped.push(job.assetGuid); },
    });
    queue.enqueue({ assetGuid: "running", source: new Uint8Array([1]), settings });
    queue.enqueue({ assetGuid: "waiting", source: new Uint8Array([2]), settings });
    const derived = queue.enqueueDerived(async () => "derived");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    queue.clear();
    expect(queue.has("running")).toBe(false);
    await expect(derived).rejects.toThrow("cancelled");
    queue.enqueue({ assetGuid: "next", source: new Uint8Array([3]), settings });
    finish!();
    await vi.waitFor(() => expect(completed).toEqual(["next"]));
    expect(dropped).toEqual(["running"]);
    expect(encoded).toEqual([1, 3]);
  });
});

describe("EncodeQueue requests for one asset", () => {
  const job = (assetGuid: string, quality: number, extra: Partial<EncodeJob> = {}): EncodeJob => ({
    assetGuid,
    source: new Uint8Array([quality]),
    settings: { format: "uastc", quality, maxDimension: 2048, generateMipmaps: true },
    usage: "albedo",
    sourceSha256: `source-of-${assetGuid}`,
    ...extra,
  });
  const background = { canWrite: () => true };
  const reported = (result: EncodeJobResult) =>
    `${result.assetGuid}:${result.settings.quality}:${result.guard ? "background" : "user"}`;

  it("queues one job for a request the asset already has waiting or running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const encoded: number[] = [];
    const completed: string[] = [];
    const queue = new EncodeQueue({
      encode: async (source, settings) => {
        encoded.push(settings.quality);
        await gate;
        return stubEncodeKtx2(source, settings);
      },
      onComplete: (result) => { completed.push(reported(result)); },
    });

    expect(queue.enqueue(job("a", 1))).toBe("queued");
    await vi.waitFor(() => expect(encoded).toEqual([1]));
    expect(queue.enqueue(job("a", 1))).toBe("duplicate");
    expect(queue.enqueue(job("b", 1))).toBe("queued");
    expect(queue.enqueue(job("b", 1))).toBe("duplicate");
    release();
    await vi.waitFor(() => expect(completed).toEqual(["a:1:user", "b:1:user"]));
    expect(encoded).toEqual([1, 1]);
  });

  it("replaces a waiting job with a changed request, so only the newest runs", async () => {
    const encoded: number[] = [];
    const completed: string[] = [];
    const queue = new EncodeQueue({
      encode: async (source, settings) => {
        encoded.push(settings.quality);
        return stubEncodeKtx2(source, settings);
      },
      onComplete: (result) => { completed.push(reported(result)); },
    });
    queue.pause();

    expect(queue.enqueue(job("a", 1))).toBe("queued");
    expect(queue.enqueue(job("a", 2))).toBe("replaced");
    expect(queue.depth).toBe(1);
    queue.resume();
    await vi.waitFor(() => expect(completed).toEqual(["a:2:user"]));
    expect(encoded).toEqual([2]);
  });

  it.each(["result", "failure"] as const)("drops the %s of a running job that a changed request replaced", async (ending) => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const encoded: number[] = [];
    const states: string[] = [];
    const completed: string[] = [];
    const dropped: string[] = [];
    const errors: string[] = [];
    const queue = new EncodeQueue({
      encode: async (source, settings) => {
        encoded.push(settings.quality);
        if (settings.quality === 1) {
          await gate;
          if (ending === "failure") throw new Error("The encoder stopped.");
        }
        return stubEncodeKtx2(source, settings);
      },
      onState: (guid, state, running) => { states.push(`${guid}:${running.settings.quality}:${state}`); },
      onComplete: (result) => { completed.push(reported(result)); },
      onError: (guid) => { errors.push(guid); },
      onDrop: (dropping) => { dropped.push(`${dropping.assetGuid}:${dropping.settings.quality}`); },
    });
    queue.enqueue(job("a", 1));
    await vi.waitFor(() => expect(encoded).toEqual([1]));

    expect(queue.enqueue(job("a", 2))).toBe("replaced");
    finish();
    await vi.waitFor(() => expect(completed).toEqual(["a:2:user"]));
    // The older job reports no state of its own once replaced, and no failure.
    expect(dropped).toEqual(["a:1"]);
    expect(errors).toEqual([]);
    expect(states).toEqual(["a:1:encoding", "a:2:encoding", "a:2:compressed"]);
  });

  it("marks the job whose result is being reported as replaced when a changed request arrives", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const results: EncodeJobResult[] = [];
    const queue = new EncodeQueue({
      onComplete: async (result) => {
        results.push(result);
        if (results.length === 1) await gate;
      },
    });
    queue.enqueue(job("a", 1));
    await vi.waitFor(() => expect(results).toHaveLength(1));

    expect(results[0]!.superseded?.()).toBe(false);
    // The reported result answers the same request; a changed one outranks it.
    expect(queue.enqueue(job("a", 1))).toBe("duplicate");
    expect(queue.enqueue(job("a", 2))).toBe("replaced");
    expect(results[0]!.superseded?.()).toBe(true);
    release();
    await vi.waitFor(() => expect(results.map((result) => result.settings.quality)).toEqual([1, 2]));
  });

  it("lets a background job give way to the asset's job, and the user's request replace a background job", async () => {
    const completed: string[] = [];
    const queue = new EncodeQueue({ onComplete: (result) => { completed.push(reported(result)); } });
    queue.pause();

    expect(queue.enqueue(job("a", 1))).toBe("queued");
    expect(queue.enqueue(job("a", 1, { guard: background }))).toBe("yielded");
    expect(queue.enqueue(job("b", 1, { guard: background }))).toBe("queued");
    expect(queue.enqueue(job("b", 1, { guard: background }))).toBe("yielded");
    // The same settings, but a background job answers no request of the user's.
    expect(queue.enqueue(job("b", 1))).toBe("replaced");
    queue.resume();
    await vi.waitFor(() => expect(completed).toEqual(["a:1:user", "b:1:user"]));
  });

  it("lets the completion callback queue a background job for the asset it reports", async () => {
    const completed: string[] = [];
    const outcomes: string[] = [];
    const queue = new EncodeQueue({
      onComplete: (result) => {
        completed.push(reported(result));
        if (!result.guard) outcomes.push(queue.enqueue(job(result.assetGuid, 1, { guard: background })));
      },
    });
    queue.enqueue(job("a", 1));
    await vi.waitFor(() => expect(completed).toEqual(["a:1:user", "a:1:background"]));
    expect(outcomes).toEqual(["queued"]);
  });
});

describe("selectTextureChunk", () => {
  it("prefers KTX2 when transcoder is available", async () => {
    const bytes = await encodeHasset({
      header: {
        dependencyMetadataVersion: 1, requiredDependencies: [],
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
    const header = readHassetHeader(bytes);
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
  hooks: {
    /** Every encode waits for this. */
    gateEncode?: Promise<void>;
    /** Runs when a result is reported, before it is committed. */
    beforeCommit?: (result: EncodeJobResult) => Promise<void>;
  } = {},
) {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject(`${name}.hproject`);
  await storage.mkdir("assets", true);
  const path = `assets/${name}.hasset`;
  await storage.writeBinary(
    path,
    await encodeHasset({
      header: {
        dependencyMetadataVersion: 1, requiredDependencies: [],
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
  /** What each commit reported: whether it wrote the file. */
  const commits: boolean[] = [];
  const queue = new EncodeQueue({
    // Stand-in encoder: a KTX2 header at the size the real encoders produce.
    encode: async (_source, encodeSettings) => {
      settings.push(encodeSettings);
      await hooks.gateEncode;
      const size = textureEncodeSize(1, 1, encodeSettings);
      return { ktx2: ktx2Header(size.width, size.height), wallMs: 0 };
    },
    onComplete: async (result) => {
      await hooks.beforeCommit?.(result);
      commits.push(await registry.commitCompressedTexture(result));
    },
  });
  registry.setEncodePipeline(queue);
  await registry.mountRoot(projectContentRoot());
  const readChunk = async (chunkId: string) => {
    const entry = registry.getByGuid(`${name}-tex`)!.header.chunks.find((chunk) => chunk.id === chunkId);
    return entry ? registry.readChunk(`${name}-tex`, entry.id) : null;
  };
  return { registry, settings, commits, readChunk, guid: `${name}-tex` };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
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

  it("queues one encode for a retry of a Texture whose encode is already queued or running", async () => {
    const encoding = deferred();
    const { registry, settings, commits, guid } = await mountSingleTexture(
      "again",
      { usage: "albedo", width: 1, height: 1, compressionState: "pending" },
      [],
      { gateEncode: encoding.promise },
    );
    expect(await registry.retryTextureEncoding(guid)).toBe(true);
    await vi.waitFor(() => expect(settings).toHaveLength(1));

    expect(await registry.retryTextureEncoding(guid)).toBe(true);
    expect(await registry.retryTextureEncoding(guid, { force: true })).toBe(true);
    encoding.resolve();
    await vi.waitFor(() => expect(registry.getByGuid(guid)!.header.payload.compressionState).toBe("compressed"));
    expect(settings).toHaveLength(1);
    expect(commits).toEqual([true]);
  });

  it("lets a retry with changed settings replace the running encode, whose result is never committed", async () => {
    const encoding = deferred();
    const { registry, settings, commits, guid } = await mountSingleTexture(
      "changed",
      { usage: "albedo", width: 1, height: 1, compressionState: "pending" },
      [],
      { gateEncode: encoding.promise },
    );
    expect(await registry.retryTextureEncoding(guid)).toBe(true);
    await vi.waitFor(() => expect(settings).toHaveLength(1));

    expect(await registry.retryTextureEncoding(guid, { force: true, usage: "particle" })).toBe(true);
    encoding.resolve();
    await vi.waitFor(() => expect(registry.getByGuid(guid)!.header.payload.compressionState).toBe("compressed"));
    expect(settings).toHaveLength(2);
    expect(commits).toEqual([true]);
    expect(registry.getByGuid(guid)!.header.payload.ktx2ChunkId).toBe(await textureEncodeChunkId(settings[1]!, "particle"));
  });

  it("keeps the pending mark of a newer request when the older encode's result is reported late", async () => {
    const reports = [deferred(), deferred()];
    const gates = [deferred(), deferred()];
    let reported = 0;
    const { registry, commits, guid } = await mountSingleTexture(
      "late",
      { usage: "albedo", width: 1, height: 1, compressionState: "compressed", ktx2ChunkId: "ktx2:albedo" },
      [{ id: "ktx2:albedo", kind: "ktx2", mime: "image/ktx2", data: ktx2Header(1, 1) }],
      {
        beforeCommit: async () => {
          const report = reported++;
          reports[report]!.resolve();
          await gates[report]!.promise;
        },
      },
    );
    expect(await registry.retryTextureEncoding(guid, { force: true })).toBe(true);
    await reports[0]!.promise;

    // The first encode is done and waits to commit when the newer request arrives.
    expect(await registry.retryTextureEncoding(guid, { force: true, usage: "particle" })).toBe(true);
    gates[0]!.resolve();
    await reports[1]!.promise;
    expect(commits).toEqual([false]);
    expect(registry.getByGuid(guid)!.header.payload).toMatchObject({ compressionState: "pending", ktx2ChunkId: "ktx2:albedo" });

    gates[1]!.resolve();
    await vi.waitFor(() => expect(registry.getByGuid(guid)!.header.payload.compressionState).toBe("compressed"));
    expect(commits).toEqual([false, true]);
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
    await storage.openDocumentsProject("encode.hproject");
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
    await storage.openDocumentsProject("retry.hproject");
    await storage.mkdir("assets", true);
    const bytes = await encodeHasset({
      header: {
        dependencyMetadataVersion: 1, requiredDependencies: [],
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
    await storage.writeBinary("assets/fail.hasset", bytes);

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
    await storage.openDocumentsProject("pending.hproject");
    await storage.mkdir("assets", true);
    for (const [guid, name, state] of [
      ["pend-tex", "Pend", "pending"],
      ["enc-tex", "Enc", "encoding"],
    ] as const) {
      const bytes = await encodeHasset({
        header: {
          dependencyMetadataVersion: 1, requiredDependencies: [],
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
      await storage.writeBinary(`assets/${name.toLowerCase()}.hasset`, bytes);
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
    await storage.openDocumentsProject("requeue.hproject");
    await storage.mkdir("assets", true);
    const bytes = await encodeHasset({
      header: {
        dependencyMetadataVersion: 1, requiredDependencies: [],
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
    await storage.writeBinary("assets/stuck.hasset", bytes);

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
    await storage.openDocumentsProject("pixels.hproject");
    await storage.mkdir("assets", true);
    const bytes = await encodeHasset({
      header: {
        dependencyMetadataVersion: 1, requiredDependencies: [],
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
    await storage.writeBinary("assets/keep.hasset", bytes);
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
    const pixels = updated.header.chunks.find(
      (chunk) => chunk.kind === "pixels",
    )!;
    const loaded = await registry.readChunk(updated.header.guid, pixels.id);
    expect(loaded).toEqual(new Uint8Array([9, 8, 7, 6]));
  });

  it("clears encodeError when a later encode commits KTX2", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("clear-err.hproject");
    await storage.mkdir("assets", true);
    const bytes = await encodeHasset({
      header: {
        dependencyMetadataVersion: 1, requiredDependencies: [],
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
    await storage.writeBinary("assets/clear.hasset", bytes);
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
    await storage.openDocumentsProject("race.hproject");
    await storage.mkdir("assets", true);
    const bytes = await encodeHasset({
      header: {
        dependencyMetadataVersion: 1, requiredDependencies: [],
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
    await storage.writeBinary("assets/race.hasset", bytes);
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
