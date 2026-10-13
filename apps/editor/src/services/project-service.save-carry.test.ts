import { describe, expect, it, vi } from "vitest";
import { createActor, createDefaultScene, createMeshComponent, MAIN_SCENE_FILE, type SerializedScene } from "@babylonslate/core";
import {
  AUDIO_REVERB_CHUNK_ID,
  BLOBS_DIR,
  createVfsBlobStore,
  decodeBabasset,
  DEFAULT_BLOB_THRESHOLD,
  encodeBabasset,
  sha256Hex,
} from "@babylonslate/assets";
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
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, AUDIO_REVERB_CHUNK_ID)).toEqual(stale);
    expect(await storage.exists(await blobPath(stale))).toBe(true);
    const edited = structuredClone(scene);
    edited.actors[0]!.transform.position[0] = 50;
    const fresh = new Uint8Array([1, 2, 3]);
    // Baked for the edited geometry; it reaches the file with the Scene's Save.
    await service.writeSceneAudioReverbChunk(MAIN_SCENE_FILE, fresh, asRecord(edited));
    const reads = vi.spyOn(storage, "readBinary");

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

    await reopened.saveDocument("scene", MAIN_SCENE_FILE, { ...scene, name: "Renamed" });

    expect(reads.mock.calls.map(([readPath]) => readPath)).not.toContain(await blobPath(reverb));
    reads.mockRestore();
    expect(await reopened.readAssetChunk(MAIN_SCENE_FILE, AUDIO_REVERB_CHUNK_ID)).toEqual(reverb);
    expect(await reopened.loadDocument("scene", MAIN_SCENE_FILE)).toMatchObject({ name: "Renamed" });
  });
});
