import { describe, expect, it, vi } from "vitest";
import { createActor, createDefaultScene, createMeshComponent, MAIN_SCENE_FILE, type SerializedScene } from "@babylonslate/core";
import {
  AUDIO_REVERB_CHUNK_ID,
  BLOBS_DIR,
  createVfsBlobStore,
  decodeAssetDocument,
  decodeBabasset,
  DEFAULT_BLOB_THRESHOLD,
  encodeBabasset,
  readAssetDocumentHeader,
  sha256Hex,
} from "@babylonslate/assets";
import { NAVMESH_CHUNK_ID } from "@babylonslate/navigation";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { installMinimalProject } from "../../../../packages/assets/src/test-support/minimal-project";
import { ProjectService } from "./project-service";

async function scaffolded() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("Carry.babproject");
  await installMinimalProject(storage);
  const service = new ProjectService(storage);
  await service.loadCurrentProject();
  return { storage, service };
}

/** Large enough to live in the blob store, as an imported image or a bake does. */
const bigBytes = (seed: number) => new Uint8Array(DEFAULT_BLOB_THRESHOLD + 11).map((_, index) => (index + seed) % 251);
const blobPath = async (bytes: Uint8Array) => `${BLOBS_DIR}/${await sha256Hex(bytes)}`;
const asRecord = (scene: unknown) => scene as Record<string, unknown>;

const TEXTURE_PATH = "assets/hero.babasset";
const PIXELS = bigBytes(1);
const ENCODE = new Uint8Array([2, 3, 4]);

/** A compressed Texture whose source pixels are a blob and whose encode is inline. */
async function writeTexture(storage: MemoryStorageAdapter): Promise<void> {
  const blobs = createVfsBlobStore(storage);
  await storage.writeBinary(TEXTURE_PATH, await encodeBabasset({
    header: {
      dependencyMetadataVersion: 1, requiredDependencies: [], dependencies: [],
      guid: "tex-hero", type: "Texture", name: "hero", engineVersion: "0.0.0", version: 1, mode: "thin", parentClass: null,
      payload: { usage: "albedo", compressionState: "compressed", ktx2ChunkId: "ktx2:abc", ktx2Sha256: await sha256Hex(ENCODE) },
    },
    chunks: [
      { id: "pixels", kind: "pixels", mime: "image/png", data: PIXELS },
      { id: "ktx2:abc", kind: "ktx2", mime: "image/ktx2", data: ENCODE },
    ],
    writeBlob: (sha256, data) => blobs.writeBlob(sha256, data),
  }));
}

describe("a document save reuses what it stores", () => {
  const path = "assets/Hero.class.babasset";
  const content = { nodes: [], edges: [], properties: { label: "Hero" } };

  it("leaves the file, its index entry and the registry alone when nothing changed", async () => {
    const { service, storage } = await scaffolded();
    await service.saveDocument("graph", path, content, { parentClass: "Actor" });
    const stored = await storage.readBinary(path);
    const generation = service.registry!.generation;
    const writes = vi.spyOn(storage, "writeBinary");
    const wholeReads = vi.spyOn(storage, "readBinary");

    await service.saveDocument("graph", path, { ...content }, { parentClass: "Actor" });

    expect(writes).not.toHaveBeenCalled();
    // Only the header is read to see what the file holds.
    expect(wholeReads.mock.calls.map(([readPath]) => readPath)).not.toContain(path);
    expect(service.registry!.generation).toBe(generation);
    writes.mockRestore();
    wholeReads.mockRestore();
    expect(await storage.readBinary(path)).toEqual(stored);
  });

  it("still writes when the document or the header metadata changed", async () => {
    const { service, storage } = await scaffolded();
    await service.saveDocument("graph", path, content, { parentClass: "Actor" });
    const writes = vi.spyOn(storage, "writeBinary");

    await service.saveDocument("graph", path, { ...content, properties: { label: "Champion" } }, { parentClass: "Actor" });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(await service.loadDocument("graph", path)).toMatchObject({ properties: { label: "Champion" } });

    await service.saveDocument("graph", path, { ...content, properties: { label: "Champion" } }, { parentClass: "Pawn" });
    expect(writes).toHaveBeenCalledTimes(2);
    expect((await decodeBabasset(await storage.readBinary(path))).header.parentClass).toBe("Pawn");
  });

  it("saves a Texture's settings without reading its source pixels or encodes again", async () => {
    const { service, storage } = await scaffolded();
    await writeTexture(storage);
    const opened = (await service.loadDocument("texture", TEXTURE_PATH)) as Record<string, unknown>;
    const pixelsBlob = await blobPath(PIXELS);
    const reads = vi.spyOn(storage, "readBinary");
    // Control: reading the chunk is seen through this spy.
    await service.readAssetChunk(TEXTURE_PATH, "pixels");
    expect(reads.mock.calls.map(([readPath]) => readPath)).toContain(pixelsBlob);
    reads.mockClear();

    await service.saveDocument("texture", TEXTURE_PATH, { ...opened, usage: "pixelArt" });

    expect(reads.mock.calls.map(([readPath]) => readPath)).not.toContain(pixelsBlob);
    reads.mockRestore();
    const saved = await decodeBabasset(await storage.readBinary(TEXTURE_PATH), (sha256) => createVfsBlobStore(storage).readBlob(sha256));
    expect(saved.header.payload).toMatchObject({ usage: "pixelArt", ktx2ChunkId: "ktx2:abc", ktx2Sha256: await sha256Hex(ENCODE) });
    expect(saved.header.chunks.map((entry) => entry.id)).toEqual(["pixels", "ktx2:abc"]);
    expect(saved.chunks.get("pixels")).toEqual(PIXELS);
    expect(saved.chunks.get("ktx2:abc")).toEqual(ENCODE);
  });

  it("refuses to save over an asset whose blob is missing, as before", async () => {
    const { service, storage } = await scaffolded();
    await writeTexture(storage);
    const opened = (await service.loadDocument("texture", TEXTURE_PATH)) as Record<string, unknown>;
    await storage.remove(await blobPath(PIXELS));
    const before = await storage.readBinary(TEXTURE_PATH);

    await expect(service.saveDocument("texture", TEXTURE_PATH, { ...opened, usage: "pixelArt" })).rejects.toThrow(/could not be read/);

    expect(await storage.readBinary(TEXTURE_PATH)).toEqual(before);
  });
});

describe("a document save over damaged or changing storage", () => {
  const path = "assets/Hero.class.babasset";
  const content = { nodes: [], edges: [], properties: { label: "Hero" } };
  const bigLabel = (letter: string) => letter.repeat(DEFAULT_BLOB_THRESHOLD + 10);

  it("rewrites an identical save over a document chunk damaged at the same length, never reporting a clean no-op", async () => {
    const { service, storage } = await scaffolded();
    await service.saveDocument("graph", path, content, { parentClass: "Actor" });
    const good = await storage.readBinary(path);
    const damaged = good.slice();
    // The document is the file's only chunk, stored inline at its end.
    damaged[damaged.length - 1] ^= 0xff;
    await storage.writeBinary(path, damaged);
    const writes = vi.spyOn(storage, "writeBinary");

    await service.saveDocument("graph", path, { ...content }, { parentClass: "Actor" });

    expect(writes).toHaveBeenCalledTimes(1);
    writes.mockRestore();
    expect(await storage.readBinary(path)).toEqual(good);
    await expect(decodeBabasset(await storage.readBinary(path))).resolves.toBeDefined();
  });

  it("refuses an identical save over a document blob damaged at the same length, yet still saves changed content", async () => {
    const { service, storage } = await scaffolded();
    const big = { ...content, properties: { label: bigLabel("x") } };
    await service.saveDocument("graph", path, big, { parentClass: "Actor" });
    const entry = readAssetDocumentHeader(await storage.readBinary(path)).chunks.find((chunk) => chunk.id === "document")!;
    expect("blob" in entry.locator).toBe(true);
    const blob = `${BLOBS_DIR}/${entry.sha256}`;
    const damaged = (await storage.readBinary(blob)).slice();
    damaged[0] ^= 0xff;
    await storage.writeBinary(blob, damaged);
    const before = await storage.readBinary(path);
    const writes = vi.spyOn(storage, "writeBinary");

    await expect(service.saveDocument("graph", path, { ...big }, { parentClass: "Actor" })).rejects.toThrow(/could not be read/);

    expect(writes).not.toHaveBeenCalled();
    writes.mockRestore();
    expect(await storage.readBinary(path)).toEqual(before);
    // The unsaved copy is not lost: changed content goes to a blob of its own.
    await service.saveDocument("graph", path, { ...content, properties: { label: bigLabel("y") } }, { parentClass: "Actor" });
    expect(await service.loadDocument("graph", path)).toMatchObject({ properties: { label: bigLabel("y") } });
  });

  it("refuses a save whose carried blob was deleted after the carry confirmed it", async () => {
    const { service, storage } = await scaffolded();
    await writeTexture(storage);
    const opened = (await service.loadDocument("texture", TEXTURE_PATH)) as Record<string, unknown>;
    const pixelsBlob = await blobPath(PIXELS);
    const before = await storage.readBinary(TEXTURE_PATH);
    const stat = storage.stat.bind(storage);
    let deleted = false;
    vi.spyOn(storage, "stat").mockImplementation(async (statPath) => {
      const result = await stat(statPath);
      // The carry has just confirmed the blob's size; now it disappears.
      if (!deleted && statPath === pixelsBlob) {
        deleted = true;
        await storage.remove(pixelsBlob);
      }
      return result;
    });

    await expect(service.saveDocument("texture", TEXTURE_PATH, { ...opened, usage: "pixelArt" })).rejects.toThrow(/could not be read/);

    expect(deleted).toBe(true);
    expect(await storage.readBinary(TEXTURE_PATH)).toEqual(before);
  });

  it("refreshes the index when the file already holds the saved content but the registry describes another version", async () => {
    const { service, storage } = await scaffolded();
    await service.saveDocument("graph", path, content, { parentClass: "Actor" });
    // Another session saves the same content under another parent Class; this registry has not rescanned.
    const other = new ProjectService(storage);
    await other.loadCurrentProject();
    await other.saveDocument("graph", path, content, { parentClass: "Pawn" });
    expect(service.registry!.getByPath(path)!.header.parentClass).toBe("Actor");
    const writes = vi.spyOn(storage, "writeBinary");

    await service.saveDocument("graph", path, { ...content }, { parentClass: "Pawn" });

    expect(writes).not.toHaveBeenCalled();
    expect(service.registry!.getByPath(path)!.header.parentClass).toBe("Pawn");
  });

  it("writes rather than skips when another writer changed the file after its header was read", async () => {
    const { service, storage } = await scaffolded();
    await service.saveDocument("graph", path, content, { parentClass: "Actor" });
    const other = new ProjectService(storage);
    await other.loadCurrentProject();
    const read = storage.readBinaryRange.bind(storage);
    let changed = false;
    vi.spyOn(storage, "readBinaryRange").mockImplementation(async (...args) => {
      // The first zero-length read checks that the header read is still the file.
      if (!changed && args[0] === path && args[2] === 0) {
        changed = true;
        await other.saveDocument("graph", path, { ...content, properties: { label: "Outside" } }, { parentClass: "Actor" });
      }
      return read(...args);
    });

    await service.saveDocument("graph", path, { ...content }, { parentClass: "Actor" });

    expect(changed).toBe(true);
    // Skipping against the stale snapshot would have left the outside version in place.
    expect((await decodeAssetDocument(await storage.readBinary(path))).payload).toMatchObject({ properties: { label: "Hero" } });
  });
});

describe("a Scene's reverb bake", () => {
  /** A Scene saved with a wall, read back as the bake sees it (its geometry fingerprint matches the file's). */
  async function savedScene(service: ProjectService): Promise<SerializedScene> {
    const wall = createActor("wall", "Wall", { components: [createMeshComponent("wall-mesh", "box")] });
    await service.saveDocument("scene", MAIN_SCENE_FILE, { ...createDefaultScene(), actors: [wall] });
    return (await service.loadDocument("scene", MAIN_SCENE_FILE)) as SerializedScene;
  }

  it("is saved without reading the stored reverb chunk it replaces", async () => {
    const { service, storage } = await scaffolded();
    const scene = await savedScene(service);
    const stale = bigBytes(3);
    await service.writeSceneAudioReverbChunk(MAIN_SCENE_FILE, stale, asRecord(scene));
    const reads = vi.spyOn(storage, "readBinary");
    // Control: the stored chunk is there, and reading it is seen through this spy.
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, AUDIO_REVERB_CHUNK_ID)).toEqual(stale);
    expect(reads.mock.calls.map(([readPath]) => readPath)).toContain(await blobPath(stale));
    reads.mockClear();
    const edited = structuredClone(scene);
    edited.actors[0]!.transform.position[0] = 50;
    const fresh = new Uint8Array([1, 2, 3]);
    // Baked for the edited geometry; it reaches the file with the Scene's Save.
    await service.writeSceneAudioReverbChunk(MAIN_SCENE_FILE, fresh, asRecord(edited));

    await service.saveDocument("scene", MAIN_SCENE_FILE, edited);

    expect(reads.mock.calls.map(([readPath]) => readPath)).not.toContain(await blobPath(stale));
    reads.mockRestore();
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, AUDIO_REVERB_CHUNK_ID)).toEqual(fresh);
  });

  it("keeps a stored reverb chunk for unchanged geometry without reading it", async () => {
    const { service, storage } = await scaffolded();
    const scene = await savedScene(service);
    const reverb = bigBytes(4);
    await service.writeSceneAudioReverbChunk(MAIN_SCENE_FILE, reverb, asRecord(scene));
    // A later session has no bake in memory, so the stored chunk is what a Save keeps.
    const reopened = new ProjectService(storage);
    await reopened.loadCurrentProject();
    const reads = vi.spyOn(storage, "readBinary");
    // Control: reading the stored chunk is seen through this spy.
    expect(await reopened.readAssetChunk(MAIN_SCENE_FILE, AUDIO_REVERB_CHUNK_ID)).toEqual(reverb);
    expect(reads.mock.calls.map(([readPath]) => readPath)).toContain(await blobPath(reverb));
    reads.mockClear();

    await reopened.saveDocument("scene", MAIN_SCENE_FILE, { ...scene, name: "Renamed" });

    expect(reads.mock.calls.map(([readPath]) => readPath)).not.toContain(await blobPath(reverb));
    reads.mockRestore();
    expect(await reopened.readAssetChunk(MAIN_SCENE_FILE, AUDIO_REVERB_CHUNK_ID)).toEqual(reverb);
    expect(await reopened.loadDocument("scene", MAIN_SCENE_FILE)).toMatchObject({ name: "Renamed" });
  });

  it("is written reading only the Scene's document, and a repeated bake writes nothing", async () => {
    const { service, storage } = await scaffolded();
    const scene = await savedScene(service);
    const navmesh = bigBytes(5);
    await service.writeSceneNavmeshChunk(MAIN_SCENE_FILE, navmesh, asRecord(scene));
    const reverb = new Uint8Array([4, 5, 6]);
    const reads = vi.spyOn(storage, "readBinary");
    // Control: reading the navmesh is seen through this spy.
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, NAVMESH_CHUNK_ID)).toEqual(navmesh);
    expect(reads.mock.calls.map(([readPath]) => readPath)).toContain(await blobPath(navmesh));
    reads.mockClear();

    await service.writeSceneAudioReverbChunk(MAIN_SCENE_FILE, reverb, asRecord(scene));

    expect(reads.mock.calls.map(([readPath]) => readPath)).not.toContain(await blobPath(navmesh));
    reads.mockRestore();
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, NAVMESH_CHUNK_ID)).toEqual(navmesh);
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, AUDIO_REVERB_CHUNK_ID)).toEqual(reverb);
    expect(await service.loadDocument("scene", MAIN_SCENE_FILE)).toEqual(scene);

    const stored = await storage.readBinary(MAIN_SCENE_FILE);
    const writes = vi.spyOn(storage, "writeBinary");
    await service.writeSceneAudioReverbChunk(MAIN_SCENE_FILE, reverb.slice(), asRecord(scene));
    expect(writes).not.toHaveBeenCalled();
    writes.mockRestore();
    expect(await storage.readBinary(MAIN_SCENE_FILE)).toEqual(stored);
  });

  it("is not written over a Scene whose other chunk's blob is missing", async () => {
    const { service, storage } = await scaffolded();
    const scene = await savedScene(service);
    const navmesh = bigBytes(7);
    await service.writeSceneNavmeshChunk(MAIN_SCENE_FILE, navmesh, asRecord(scene));
    await storage.remove(await blobPath(navmesh));
    const before = await storage.readBinary(MAIN_SCENE_FILE);

    await expect(service.writeSceneAudioReverbChunk(MAIN_SCENE_FILE, new Uint8Array([9]), asRecord(scene))).rejects.toThrow();

    expect(await storage.readBinary(MAIN_SCENE_FILE)).toEqual(before);
  });
});
