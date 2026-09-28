import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { encodeAssetDocument } from "./asset-document";
import { decodeBabasset, encodeBabasset } from "./babasset";
import { sha256Hex } from "./bytes";
import { projectContentRoot, type ContentRoot } from "./content-root";
import { EncodeQueue, type EncodeJobResult } from "./encode-queue";
import { sniffSourceImageSize } from "./image-size";
import { sniffKtx2Size } from "./ktx2-info";
import { AssetRegistry } from "./registry";
import { resolveGpuTexture, textureEncodeSettingsFor } from "./resolve-gpu-texture";
import { DEFAULT_TEXTURE_ENCODE_SETTINGS, textureEncodeChunkId, textureEncodeSize, type TextureEncodeSettings } from "./texture-compression";
import { createDefaultTilesetPayload } from "./tileset-payload";
import { webpHeader } from "./test-support/image-headers";

/** PNG signature + IHDR size (enough for size sniffing). */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** KTX2 identifier plus pixelWidth / pixelHeight. */
function ktx2(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  return bytes;
}

// Chunk ids today's registry commits, by encode settings (uastc, quality 2, mips).
const KEY_MAX_1 = "ktx2:30d6ee4fb9bf2d2e";
const KEY_MAX_64 = "ktx2:e733358fdabe67c2";
const KEY_MAX_2048 = "ktx2:34dad383eac5f9b6";

/** The id a 1x1 Particle encode commits under (its `blockAlign` is keyed). */
function particleKeyMax1(): Promise<string> {
  return textureEncodeChunkId(
    textureEncodeSettingsFor({ usage: "particle", width: 1, height: 1 }, DEFAULT_TEXTURE_ENCODE_SETTINGS, "particle"),
    "particle",
  );
}

async function writeTexture(
  storage: MemoryStorageAdapter,
  path: string,
  guid: string,
  options: {
    usage?: string;
    source: [number, number];
    sized?: boolean;
    pixels?: boolean;
    committed: { id: string; size: [number, number] };
    /**
     * What a commit recorded: `ktx2Width` / `ktx2Height`, `ktx2BlockAlign`,
     * and `ktx2Sha256` of the committed chunk, or of the encode at `replaced`
     * size that a writer unaware of the record has since overwritten.
     */
    recorded?: { size: [number, number]; blockAlign?: number; replaced?: [number, number] };
  },
): Promise<void> {
  const [width, height] = options.source;
  const recorded = options.recorded;
  const payload: Record<string, unknown> = {
    usage: options.usage ?? "albedo",
    compressionState: "compressed",
    ktx2ChunkId: options.committed.id,
    ...(options.sized === false ? {} : { width, height }),
    ...(recorded
      ? {
          ktx2Width: recorded.size[0],
          ktx2Height: recorded.size[1],
          ...(recorded.blockAlign ? { ktx2BlockAlign: recorded.blockAlign } : {}),
          ktx2Sha256: await sha256Hex(ktx2(...(recorded.replaced ?? options.committed.size))),
        }
      : {}),
  };
  await storage.writeBinary(path, await encodeBabasset({
    header: { guid, type: "Texture", name: guid, engineVersion: "0.0.0", version: 1, mode: "thin", dependencies: [], parentClass: null, payload },
    chunks: [
      ...(options.pixels === false ? [] : [{ id: "pixels", kind: "pixels", mime: "image/png", data: png(width, height) }]),
      { id: options.committed.id, kind: "ktx2", mime: "image/ktx2", data: ktx2(...options.committed.size) },
    ],
  }));
}

async function mount(
  storage: MemoryStorageAdapter,
  extraRoots: ContentRoot[] = [],
  projectSettings: TextureEncodeSettings = DEFAULT_TEXTURE_ENCODE_SETTINGS,
  onEncode: (sourceSize: { width: number; height: number }) => void = () => {},
) {
  const registry = new AssetRegistry(storage);
  const jobs: EncodeJobResult[] = [];
  const queue = new EncodeQueue({
    // Stand-in encoder: a KTX2 header at the size the real encoders produce.
    encode: async (source, settings) => {
      const sourceSize = sniffSourceImageSize(source)!;
      onEncode(sourceSize);
      const size = textureEncodeSize(sourceSize.width, sourceSize.height, settings);
      return { ktx2: ktx2(size.width, size.height), wallMs: 0 };
    },
    onComplete: async (result) => {
      jobs.push(result);
      await registry.commitCompressedTexture(result);
    },
  });
  registry.setEncodePipeline(queue, projectSettings);
  await registry.mountRoot(projectContentRoot());
  for (const root of extraRoots) await registry.mountRoot(root);
  return { registry, jobs, queue };
}

async function storageWithProject(name: string): Promise<MemoryStorageAdapter> {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject(`${name}.babproject`);
  await storage.mkdir("assets", true);
  return storage;
}

describe("texture encode alignment", () => {
  it("pads an odd import at today's chunk id and records what it committed", async () => {
    const storage = await storageWithProject("import");
    const { registry } = await mount(storage);
    const [odd] = await registry.importFile("project", "", "odd.png", png(1, 1));
    const [even] = await registry.importFile("project", "", "even.png", png(64, 32));
    await vi.waitFor(() => {
      expect(registry.getByGuid(odd!.header.guid)!.header.payload.compressionState).toBe("compressed");
      expect(registry.getByGuid(even!.header.guid)!.header.payload.compressionState).toBe("compressed");
    });
    expect(registry.getByGuid(odd!.header.guid)!.header.payload).toMatchObject({
      ktx2ChunkId: KEY_MAX_1,
      ktx2Width: 4,
      ktx2Height: 4,
      ktx2BlockAlign: 4,
    });
    const aligned = registry.getByGuid(even!.header.guid)!.header.payload;
    expect(aligned).toMatchObject({ ktx2ChunkId: KEY_MAX_64, ktx2Width: 64, ktx2Height: 32 });
    expect(aligned).not.toHaveProperty("ktx2BlockAlign");
  });

  it("requeues on open only compressed textures committed off the grid that are not atlases", async () => {
    const storage = await storageWithProject("open");
    await writeTexture(storage, "assets/legacy-odd.babasset", "legacy-odd", { source: [1, 1], committed: { id: KEY_MAX_1, size: [1, 1] } });
    await writeTexture(storage, "assets/aligned.babasset", "aligned", { source: [64, 32], committed: { id: KEY_MAX_64, size: [64, 32] } });
    await writeTexture(storage, "assets/atlas-odd.babasset", "atlas-odd", { source: [1, 1], committed: { id: KEY_MAX_1, size: [1, 1] } });
    await writeTexture(storage, "assets/locked-odd.babasset", "locked-odd", { source: [1, 1], committed: { id: KEY_MAX_1, size: [1, 1] } });
    // A Particle encode from before sizes were recorded, under its real id: its
    // clamped source size is off the grid, but Particle always pads.
    await writeTexture(storage, "assets/particle-odd.babasset", "particle-odd", {
      usage: "particle", source: [1, 1], committed: { id: await particleKeyMax1(), size: [4, 4] },
    });
    // No recorded source size (WebP, GIF or Model textures imported before sizes were recorded): the committed KTX2 header decides.
    await writeTexture(storage, "assets/unsized-odd.babasset", "unsized-odd", {
      source: [30, 30], sized: false, committed: { id: KEY_MAX_2048, size: [30, 30] },
    });
    await writeTexture(storage, "assets/unsized-even.babasset", "unsized-even", {
      source: [32, 32], sized: false, committed: { id: KEY_MAX_2048, size: [32, 32] },
    });
    // Its payload size is on the grid, so a re-encode would land off it again: never requeued.
    await writeTexture(storage, "assets/mismatched.babasset", "mismatched", {
      source: [64, 32], committed: { id: KEY_MAX_64, size: [30, 30] }, recorded: { size: [30, 30] },
    });
    // Nothing to re-encode from: it keeps drawing its committed encode.
    await writeTexture(storage, "assets/sourceless-odd.babasset", "sourceless-odd", {
      source: [1, 1], pixels: false, committed: { id: KEY_MAX_1, size: [1, 1] },
    });
    // A Tileset saved before atlas meta existed: only its document names the texture.
    await storage.writeBinary("assets/ground.tileset.babasset", await encodeAssetDocument({
      guid: "ground", type: "Tileset", name: "Ground", version: 1,
      payload: { ...createDefaultTilesetPayload(), textureGuid: "atlas-odd" } as unknown as Record<string, unknown>,
    }, { dependencies: ["atlas-odd"] }));
    const plugin = new MemoryStorageAdapter("opfs");
    await plugin.openDocumentsProject("engine-plugins");
    await writeTexture(plugin, "starter/assets/plugin-odd.babasset", "plugin-odd", { source: [1, 1], committed: { id: KEY_MAX_1, size: [1, 1] } });
    const { registry, jobs, queue } = await mount(storage, [
      { id: "plugin:starter", kind: "plugin", pathPrefix: "starter/assets", readOnly: true, storage: plugin },
    ]);

    const canWrite = (guid: string) => guid !== "locked-odd";
    expect((await registry.reconcileTextureAlignment({ canWrite })).sort()).toEqual(["legacy-odd", "unsized-odd"]);
    // Idempotent: the requeued textures are queued.
    expect(await registry.reconcileTextureAlignment({ canWrite })).toEqual([]);
    await vi.waitFor(() => {
      expect(queue.depth).toBe(0);
      expect(jobs).toHaveLength(2);
    });
    expect(jobs.map((job) => [job.assetGuid, job.settings.blockAlign]).sort()).toEqual([
      ["legacy-odd", 4],
      ["unsized-odd", 4],
    ]);
    expect(registry.getByGuid("legacy-odd")!.header.payload).toMatchObject({ ktx2ChunkId: KEY_MAX_1, ktx2Width: 4, ktx2Height: 4 });
    expect(registry.getByGuid("unsized-odd")!.header.payload).toMatchObject({ ktx2ChunkId: KEY_MAX_2048, ktx2Width: 32, ktx2Height: 32 });
    // Once committed, the recorded encode satisfies the check.
    expect(await registry.reconcileTextureAlignment({ canWrite })).toEqual([]);
    expect(registry.getByGuid("sourceless-odd")!.header.payload.compressionState).toBe("compressed");
  });

  it("ignores a commit's record once another writer replaced the encode it describes", async () => {
    const storage = await storageWithProject("replaced");
    // Padded to 4x4 and recorded, then re-encoded 1x1 under the same id by an
    // editor that keeps the fields without knowing them.
    await writeTexture(storage, "assets/replaced-odd.babasset", "replaced-odd", {
      source: [1, 1], committed: { id: KEY_MAX_1, size: [1, 1] }, recorded: { size: [4, 4], blockAlign: 4, replaced: [4, 4] },
    });
    await writeTexture(storage, "assets/replaced-atlas.babasset", "replaced-atlas", {
      source: [1, 1], committed: { id: KEY_MAX_1, size: [1, 1] }, recorded: { size: [4, 4], blockAlign: 4, replaced: [4, 4] },
    });
    // Its record still describes its committed bytes: a padded atlas.
    await writeTexture(storage, "assets/padded-atlas.babasset", "padded-atlas", {
      source: [1, 1], committed: { id: KEY_MAX_1, size: [4, 4] }, recorded: { size: [4, 4], blockAlign: 4 },
    });
    for (const texture of ["replaced-atlas", "padded-atlas"]) {
      await storage.writeBinary(`assets/${texture}.tileset.babasset`, await encodeAssetDocument({
        guid: `${texture}-tileset`, type: "Tileset", name: texture, version: 1,
        payload: { ...createDefaultTilesetPayload(), textureGuid: texture } as unknown as Record<string, unknown>,
      }, { dependencies: [texture] }));
    }
    const { registry, jobs, queue } = await mount(storage);

    expect((await registry.reconcileTextureAlignment()).sort()).toEqual(["padded-atlas", "replaced-odd"]);
    await vi.waitFor(() => {
      expect(queue.depth).toBe(0);
      expect(jobs).toHaveLength(2);
    });
    expect(registry.getByGuid("replaced-odd")!.header.payload).toMatchObject({ ktx2Width: 4, ktx2Height: 4, ktx2BlockAlign: 4 });
    expect(registry.getByGuid("padded-atlas")!.header.payload).toMatchObject({ ktx2Width: 1, ktx2Height: 1 });
    expect(registry.getByGuid("padded-atlas")!.header.payload).not.toHaveProperty("ktx2BlockAlign");
  });

  it("pads a size-less WebP only when its sniffed size is off the grid, so an atlas pick re-encodes only that one", async () => {
    const storage = await storageWithProject("webp");
    // Imported before WebP sizes were recorded, still waiting for its encode.
    for (const [guid, edge] of [["even-webp", 32], ["odd-webp", 30]] as const) {
      await storage.writeBinary(`assets/${guid}.babasset`, await encodeBabasset({
        header: {
          guid, type: "Texture", name: guid, engineVersion: "0.0.0", version: 1, mode: "thin", dependencies: [], parentClass: null,
          payload: { usage: "albedo", compressionState: "pending" },
        },
        chunks: [{ id: "pixels", kind: "pixels", mime: "image/webp", data: webpHeader("VP8L", edge, edge) }],
      }));
    }
    const { registry, jobs, queue } = await mount(storage);
    expect(await registry.requeueUncompressedTextures()).toBe(2);
    await vi.waitFor(() => {
      expect(queue.depth).toBe(0);
      expect(jobs).toHaveLength(2);
    });
    expect(registry.getByGuid("even-webp")!.header.payload).toMatchObject({ ktx2Width: 32, ktx2Height: 32 });
    expect(registry.getByGuid("even-webp")!.header.payload).not.toHaveProperty("ktx2BlockAlign");
    expect(registry.getByGuid("odd-webp")!.header.payload).toMatchObject({ ktx2Width: 32, ktx2Height: 32, ktx2BlockAlign: 4 });

    // Tilesets pick both: only the padded one must return to its own size.
    for (const texture of ["even-webp", "odd-webp"]) {
      const path = `assets/${texture}.tileset.babasset`;
      await storage.writeBinary(path, await encodeAssetDocument({
        guid: `${texture}-tileset`, type: "Tileset", name: texture, version: 1,
        payload: { ...createDefaultTilesetPayload(), textureGuid: texture } as unknown as Record<string, unknown>,
      }, { dependencies: [texture] }));
      await registry.reindexPath(path);
    }
    expect(await registry.reconcileTextureAlignment()).toEqual(["odd-webp"]);
  });

  it("drops an older encode off the grid once a Texture's encode is on it, so the resolver cannot bind the older one", async () => {
    const storage = await storageWithProject("retained");
    // Encoded at 30x20 under the default 2048 project max, then at 15x10 once the
    // project max became 15. The resolver keys ids with the default max, so it
    // prefers the older full-size encode, which is still in the file.
    const payload = { usage: "albedo", width: 30, height: 20 };
    const full = await textureEncodeChunkId(textureEncodeSettingsFor(payload, DEFAULT_TEXTURE_ENCODE_SETTINGS), "albedo");
    const projectSettings = { ...DEFAULT_TEXTURE_ENCODE_SETTINGS, maxDimension: 15 };
    const clamped = await textureEncodeChunkId(textureEncodeSettingsFor(payload, projectSettings), "albedo");
    await storage.writeBinary("assets/retained.babasset", await encodeBabasset({
      header: {
        guid: "retained", type: "Texture", name: "retained", engineVersion: "0.0.0", version: 1, mode: "thin", dependencies: [], parentClass: null,
        payload: { ...payload, compressionState: "compressed", ktx2ChunkId: clamped },
      },
      chunks: [
        { id: "pixels", kind: "pixels", mime: "image/png", data: png(30, 20) },
        { id: full, kind: "ktx2", mime: "image/ktx2", data: ktx2(30, 20) },
        { id: clamped, kind: "ktx2", mime: "image/ktx2", data: ktx2(15, 10) },
      ],
    }));
    const { registry, jobs, queue } = await mount(storage, [], projectSettings);

    expect(await registry.reconcileTextureAlignment()).toEqual(["retained"]);
    await vi.waitFor(() => {
      expect(queue.depth).toBe(0);
      expect(jobs).toHaveLength(1);
    });
    const { header } = registry.getByGuid("retained")!;
    const file = await decodeBabasset(await storage.readBinary("assets/retained.babasset"));
    const resolved = await resolveGpuTexture({
      header,
      readChunk: async (id) => file.chunks.get(id) ?? null,
      editorLod: { enabled: false, quality: 1 },
    });
    expect(resolved?.kind).toBe("ktx2");
    expect(sniffKtx2Size(resolved!.bytes)).toEqual({ width: 16, height: 12 });
  });

  it("keeps an atlas's own-size encode when a Particle Usage encode commits for it", async () => {
    const storage = await storageWithProject("atlas-particle");
    await writeTexture(storage, "assets/atlas.babasset", "atlas", { source: [1, 1], committed: { id: KEY_MAX_1, size: [1, 1] } });
    await storage.writeBinary("assets/ground.tileset.babasset", await encodeAssetDocument({
      guid: "ground", type: "Tileset", name: "Ground", version: 1,
      payload: { ...createDefaultTilesetPayload(), textureGuid: "atlas" } as unknown as Record<string, unknown>,
    }, { dependencies: ["atlas"] }));
    const { registry, jobs, queue } = await mount(storage);

    expect(await registry.retryTextureEncoding("atlas", { force: true, usage: "particle" })).toBe(true);
    await vi.waitFor(() => {
      expect(queue.depth).toBe(0);
      expect(jobs).toHaveLength(1);
    });
    const chunks = registry.getByGuid("atlas")!.header.chunks.map((chunk) => chunk.id);
    expect(chunks).toContain(await particleKeyMax1());
    // Switching the Usage back binds this 1x1 encode straight away.
    expect(chunks).toContain(KEY_MAX_1);
  });

  it("writes nothing until a requeued encode commits, and asks the guard again when it starts and commits", async () => {
    const storage = await storageWithProject("guarded-jobs");
    await writeTexture(storage, "assets/free.babasset", "free", { source: [1, 1], committed: { id: KEY_MAX_1, size: [1, 1] } });
    await writeTexture(storage, "assets/locked-queued.babasset", "locked-queued", { source: [1, 1], committed: { id: KEY_MAX_1, size: [1, 1] } });
    // Its own source size, so the encoder can tell its job apart.
    const key5 = await textureEncodeChunkId(textureEncodeSettingsFor({ usage: "albedo", width: 5, height: 5 }, DEFAULT_TEXTURE_ENCODE_SETTINGS), "albedo");
    await writeTexture(storage, "assets/locked-encoding.babasset", "locked-encoding", { source: [5, 5], committed: { id: key5, size: [5, 5] } });
    const locked = new Set<string>();
    const encoded: number[] = [];
    const { registry, queue } = await mount(storage, [], DEFAULT_TEXTURE_ENCODE_SETTINGS, (size) => {
      encoded.push(size.width);
      // A lock poll lands while this one encodes.
      if (size.width === 5) locked.add("locked-encoding");
    });
    const onDisk = async (guid: string) =>
      (await decodeBabasset(await storage.readBinary(`assets/${guid}.babasset`))).header.payload;

    queue.pause();
    const canWrite = (guid: string) => !locked.has(guid);
    expect((await registry.reconcileTextureAlignment({ canWrite })).sort()).toEqual(["free", "locked-encoding", "locked-queued"]);
    // Still `compressed` on disk: nothing is left for a later open to requeue without the guard.
    for (const guid of ["free", "locked-queued", "locked-encoding"]) {
      expect((await onDisk(guid)).compressionState).toBe("compressed");
    }
    const nextOpen = await mount(storage);
    expect(await nextOpen.registry.requeueUncompressedTextures()).toBe(0);

    // A lock poll lands while the jobs wait.
    locked.add("locked-queued");
    queue.resume();
    await vi.waitFor(() => expect(queue.depth).toBe(0));
    expect(encoded).toEqual(expect.arrayContaining([1, 5]));
    expect(encoded).toHaveLength(2);
    expect(await onDisk("free")).toMatchObject({ compressionState: "compressed", ktx2Width: 4, ktx2Height: 4 });
    for (const guid of ["locked-queued", "locked-encoding"]) {
      expect(await onDisk(guid)).toMatchObject({ compressionState: "compressed" });
      expect(await onDisk(guid)).not.toHaveProperty("ktx2Width");
    }
  });

  it("leaves a texture alone when its lock is learned while the pass reads its committed encode", async () => {
    const storage = await storageWithProject("lock-during-read");
    // No recorded size: the pass reads the committed KTX2 header from the file.
    await writeTexture(storage, "assets/unsized-odd.babasset", "unsized-odd", {
      source: [30, 30], sized: false, committed: { id: KEY_MAX_2048, size: [30, 30] },
    });
    const { registry, queue } = await mount(storage);
    let locked = false;
    const readBinary = storage.readBinary.bind(storage);
    vi.spyOn(storage, "readBinary").mockImplementation(async (path) => {
      if (path === "assets/unsized-odd.babasset") locked = true;
      return readBinary(path);
    });

    expect(await registry.reconcileTextureAlignment({ canWrite: () => !locked })).toEqual([]);
    expect(locked).toBe(true);
    expect(queue.depth).toBe(0);
    expect(registry.getByGuid("unsized-odd")!.header.payload.compressionState).toBe("compressed");
  });
});
