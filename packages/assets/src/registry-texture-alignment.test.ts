import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { encodeAssetDocument } from "./asset-document";
import { encodeBabasset } from "./babasset";
import { projectContentRoot, type ContentRoot } from "./content-root";
import { EncodeQueue, type EncodeJobResult } from "./encode-queue";
import { sniffImageSize } from "./image-size";
import { AssetRegistry } from "./registry";
import { textureEncodeSize } from "./texture-compression";
import { createDefaultTilesetPayload } from "./tileset-payload";

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
const PARTICLE_KEY_MAX_1 = "ktx2:particle-max-1";

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
    /** `ktx2Width` / `ktx2Height` a commit recorded. */
    recorded?: [number, number];
  },
): Promise<void> {
  const [width, height] = options.source;
  const payload: Record<string, unknown> = {
    usage: options.usage ?? "albedo",
    compressionState: "compressed",
    ktx2ChunkId: options.committed.id,
    ...(options.sized === false ? {} : { width, height }),
    ...(options.recorded ? { ktx2Width: options.recorded[0], ktx2Height: options.recorded[1] } : {}),
  };
  await storage.writeBinary(path, await encodeBabasset({
    header: { guid, type: "Texture", name: guid, engineVersion: "0.0.0", version: 1, mode: "thin", dependencies: [], parentClass: null, payload },
    chunks: [
      ...(options.pixels === false ? [] : [{ id: "pixels", kind: "pixels", mime: "image/png", data: png(width, height) }]),
      { id: options.committed.id, kind: "ktx2", mime: "image/ktx2", data: ktx2(...options.committed.size) },
    ],
  }));
}

async function mount(storage: MemoryStorageAdapter, extraRoots: ContentRoot[] = []) {
  const registry = new AssetRegistry(storage);
  const jobs: EncodeJobResult[] = [];
  const queue = new EncodeQueue({
    // Stand-in encoder: a KTX2 header at the size the real encoders produce.
    encode: async (source, settings) => {
      const sourceSize = sniffImageSize(source)!;
      const size = textureEncodeSize(sourceSize.width, sourceSize.height, settings);
      return { ktx2: ktx2(size.width, size.height), wallMs: 0 };
    },
    onComplete: async (result) => {
      jobs.push(result);
      await registry.commitCompressedTexture(result);
    },
  });
  registry.setEncodePipeline(queue);
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
    await writeTexture(storage, "assets/particle-odd.babasset", "particle-odd", {
      usage: "particle", source: [1, 1], committed: { id: PARTICLE_KEY_MAX_1, size: [4, 4] },
    });
    // No recorded source size (Model textures, WebP): the committed KTX2 header decides.
    await writeTexture(storage, "assets/unsized-odd.babasset", "unsized-odd", {
      source: [30, 30], sized: false, committed: { id: KEY_MAX_2048, size: [30, 30] },
    });
    await writeTexture(storage, "assets/unsized-even.babasset", "unsized-even", {
      source: [32, 32], sized: false, committed: { id: KEY_MAX_2048, size: [32, 32] },
    });
    // Its payload size is on the grid, so a re-encode would land off it again: never requeued.
    await writeTexture(storage, "assets/mismatched.babasset", "mismatched", {
      source: [64, 32], committed: { id: KEY_MAX_64, size: [30, 30] }, recorded: [30, 30],
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
    // Idempotent: the requeued textures are pending now.
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
});
