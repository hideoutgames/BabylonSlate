import { describe, expect, it, vi } from "vitest";
import { createActor, createDefaultScene, createMeshComponent, MAIN_SCENE_FILE, type SerializedScene } from "@haptic/core";
import {
  AUDIO_REVERB_CHUNK_ID,
  BLOBS_DIR,
  createVfsBlobStore,
  decodeAssetDocument,
  decodeHasset,
  DEFAULT_BLOB_THRESHOLD,
  encodeHasset,
  readAssetDocumentHeader,
  sha256Hex,
  type ChunkInput,
} from "@haptic/assets";
import { NAVMESH_CHUNK_ID } from "@haptic/navigation";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { installMinimalProject } from "../../../../packages/assets/src/test-support/minimal-project";
import { ProjectService } from "./project-service";

async function scaffolded() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("Carry.hproject");
  await installMinimalProject(storage);
  const service = new ProjectService(storage);
  await service.loadCurrentProject();
  return { storage, service };
}

/** Large enough to live in the blob store, as an imported image or a bake does. */
const bigBytes = (seed: number) => new Uint8Array(DEFAULT_BLOB_THRESHOLD + 11).map((_, index) => (index + seed) % 251);
const blobPath = async (bytes: Uint8Array) => `${BLOBS_DIR}/${await sha256Hex(bytes)}`;
const asRecord = (scene: unknown) => scene as Record<string, unknown>;

const TEXTURE_PATH = "assets/hero.hasset";
const PIXELS = bigBytes(1);
const ENCODE = new Uint8Array([2, 3, 4]);

/** A compressed Texture whose source pixels are a blob and whose encode is inline. */
async function writeTexture(storage: MemoryStorageAdapter): Promise<void> {
  const blobs = createVfsBlobStore(storage);
  await storage.writeBinary(TEXTURE_PATH, await encodeHasset({
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
  const path = "assets/Hero.class.hasset";
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
    expect((await decodeHasset(await storage.readBinary(path))).header.parentClass).toBe("Pawn");
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
    const saved = await decodeHasset(await storage.readBinary(TEXTURE_PATH), (sha256) => createVfsBlobStore(storage).readBlob(sha256));
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
  const path = "assets/Hero.class.hasset";
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
    await expect(decodeHasset(await storage.readBinary(path))).resolves.toBeDefined();
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

/** A Scene saved with a wall, read back as a bake sees it (its geometry fingerprint matches the file's). */
async function savedScene(service: ProjectService): Promise<SerializedScene> {
  const wall = createActor("wall", "Wall", { components: [createMeshComponent("wall-mesh", "box")] });
  await service.saveDocument("scene", MAIN_SCENE_FILE, { ...createDefaultScene(), actors: [wall] });
  return (await service.loadDocument("scene", MAIN_SCENE_FILE)) as SerializedScene;
}

describe("a Scene's reverb bake", () => {
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

const chunkOf = (id: string, data: Uint8Array, kind = "bin", mime = "application/octet-stream"): ChunkInput => ({ id, kind, mime, data });
const chunkIds = async (storage: MemoryStorageAdapter, path: string) =>
  readAssetDocumentHeader(await storage.readBinary(path)).chunks.map((entry) => entry.id);

/**
 * The same write on two copies of a project: one whose large chunks sit in the
 * blob store, which the write carries over, and one whose large chunks sit
 * inline, which it cannot copy, so it decodes and re-encodes every chunk (and
 * moves them to the blob store). Both must end with the same bytes.
 */
async function bothPaths<T>(
  path: string,
  setup: (storage: MemoryStorageAdapter, inline: boolean) => Promise<T>,
  write: (service: ProjectService, prepared: T) => Promise<void>,
) {
  const run = async (inline: boolean) => {
    const { storage, service } = await scaffolded();
    const prepared = await setup(storage, inline);
    await service.remountRegistry();
    const reads = vi.spyOn(storage, "readBinary");
    await write(service, prepared);
    const wholeFileRead = reads.mock.calls.some(([readPath]) => readPath === path);
    reads.mockRestore();
    return { bytes: await storage.readBinary(path), wholeFileRead };
  };
  return { carried: await run(false), full: await run(true) };
}

describe("a Scene's navmesh bake", () => {
  const OLD_NAVMESH = bigBytes(5);
  const SIDECAR = bigBytes(8);
  const NOTE = new Uint8Array([4, 5, 6, 7]);
  const FRESH = bigBytes(6);

  /** The main Scene rewritten to hold, after its document, an old `navmesh`, a blob-sized `sidecar` and a small `note`. Resolves to its payload. */
  async function withSceneExtras(storage: MemoryStorageAdapter, inline = false): Promise<Record<string, unknown>> {
    const blobs = createVfsBlobStore(storage);
    const decoded = await decodeHasset(await storage.readBinary(MAIN_SCENE_FILE));
    const document = decoded.header.chunks.find((entry) => entry.id === "document")!;
    const body = decoded.chunks.get("document")!;
    await storage.writeBinary(MAIN_SCENE_FILE, await encodeHasset({
      header: decoded.header,
      chunks: [
        chunkOf("document", body, document.kind, document.mime),
        chunkOf("navmesh", OLD_NAVMESH, "navmesh"),
        chunkOf("sidecar", SIDECAR),
        chunkOf("note", NOTE),
      ],
      writeBlob: inline ? undefined : (sha256, data) => blobs.writeBlob(sha256, data),
    }));
    return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  }

  async function opened() {
    const { service, storage } = await scaffolded();
    const payload = await withSceneExtras(storage);
    await service.remountRegistry();
    return { service, storage, payload };
  }

  it("is written without reading the chunks it keeps or the navmesh it replaces", async () => {
    const { service, storage, payload } = await opened();
    const reads = vi.spyOn(storage, "readBinary");
    // Control: reading a chunk's blob is seen through this spy.
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, "sidecar")).toEqual(SIDECAR);
    expect(reads.mock.calls.map(([readPath]) => readPath)).toContain(await blobPath(SIDECAR));
    reads.mockClear();

    await service.writeSceneNavmeshChunk(MAIN_SCENE_FILE, FRESH, payload);

    const read = reads.mock.calls.map(([readPath]) => readPath);
    expect(read).not.toContain(await blobPath(SIDECAR));
    expect(read).not.toContain(await blobPath(OLD_NAVMESH));
    reads.mockRestore();
    // The replaced navmesh moves to the end, as a full re-encode puts it.
    expect(await chunkIds(storage, MAIN_SCENE_FILE)).toEqual(["document", "sidecar", "note", "navmesh"]);
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, "navmesh")).toEqual(FRESH);
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, "sidecar")).toEqual(SIDECAR);
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, "note")).toEqual(NOTE);
    expect(await service.loadDocument("scene", MAIN_SCENE_FILE)).toMatchObject({ name: payload.name });
  });

  it("writes the bytes a full decode and re-encode of every chunk would", async () => {
    const { carried, full } = await bothPaths(MAIN_SCENE_FILE, withSceneExtras,
      (service, payload) => service.writeSceneNavmeshChunk(MAIN_SCENE_FILE, FRESH, payload));

    // The control is the full path, which reads the whole file; the carried write does not.
    expect(full.wholeFileRead).toBe(true);
    expect(carried.wholeFileRead).toBe(false);
    expect(carried.bytes).toEqual(full.bytes);
  });

  it("keeps a stored reverb chunk for unchanged geometry without reading it, and drops it for changed geometry", async () => {
    const { service, storage } = await scaffolded();
    const scene = await savedScene(service);
    const reverb = bigBytes(4);
    await service.writeSceneAudioReverbChunk(MAIN_SCENE_FILE, reverb, asRecord(scene));
    // A later session has no bake in memory, so the stored chunk is what a bake keeps.
    const reopened = new ProjectService(storage);
    await reopened.loadCurrentProject();
    const reads = vi.spyOn(storage, "readBinary");

    await reopened.writeSceneNavmeshChunk(MAIN_SCENE_FILE, FRESH, asRecord(scene));

    expect(reads.mock.calls.map(([readPath]) => readPath)).not.toContain(await blobPath(reverb));
    reads.mockRestore();
    expect(await reopened.readAssetChunk(MAIN_SCENE_FILE, AUDIO_REVERB_CHUNK_ID)).toEqual(reverb);
    expect(await reopened.readAssetChunk(MAIN_SCENE_FILE, NAVMESH_CHUNK_ID)).toEqual(FRESH);

    const edited = structuredClone(scene);
    edited.actors[0]!.transform.position[0] = 50;
    await reopened.writeSceneNavmeshChunk(MAIN_SCENE_FILE, bigBytes(9), asRecord(edited));
    expect(await reopened.readAssetChunk(MAIN_SCENE_FILE, AUDIO_REVERB_CHUNK_ID)).toBeNull();
    expect(await reopened.readAssetChunk(MAIN_SCENE_FILE, NAVMESH_CHUNK_ID)).toEqual(bigBytes(9));
  });

  const damages: Record<string, (storage: MemoryStorageAdapter) => Promise<void>> = {
    "a kept chunk's blob is missing": async (storage) => storage.remove(await blobPath(SIDECAR)),
    "a kept chunk's blob is short": async (storage) => storage.writeBinary(await blobPath(SIDECAR), SIDECAR.subarray(0, 100)),
    "a kept inline chunk no longer matches its digest": async (storage) => {
      const damaged = (await storage.readBinary(MAIN_SCENE_FILE)).slice();
      // The note is the last inline chunk, at the end of the file.
      damaged[damaged.length - 1] ^= 0xff;
      await storage.writeBinary(MAIN_SCENE_FILE, damaged);
    },
  };

  it.each(Object.keys(damages))("is not written over a Scene when %s", async (what) => {
    const { service, storage, payload } = await opened();
    await damages[what]!(storage);
    const before = await storage.readBinary(MAIN_SCENE_FILE);

    await expect(service.writeSceneNavmeshChunk(MAIN_SCENE_FILE, FRESH, payload)).rejects.toThrow(/could not be read/);

    expect(await storage.readBinary(MAIN_SCENE_FILE)).toEqual(before);
  });

  it("is not written when a kept blob is deleted after the carry confirmed it", async () => {
    const { service, storage, payload } = await opened();
    const sidecar = await blobPath(SIDECAR);
    const before = await storage.readBinary(MAIN_SCENE_FILE);
    const stat = storage.stat.bind(storage);
    let deleted = false;
    vi.spyOn(storage, "stat").mockImplementation(async (statPath) => {
      const result = await stat(statPath);
      // The carry has just confirmed the blob's size; now it disappears.
      if (!deleted && statPath === sidecar) {
        deleted = true;
        await storage.remove(sidecar);
      }
      return result;
    });

    await expect(service.writeSceneNavmeshChunk(MAIN_SCENE_FILE, FRESH, payload)).rejects.toThrow(/could not be read/);

    expect(deleted).toBe(true);
    expect(await storage.readBinary(MAIN_SCENE_FILE)).toEqual(before);
  });

  it("writes nothing when the bake and the Scene are the ones already stored", async () => {
    const { service, storage, payload } = await opened();
    await service.writeSceneNavmeshChunk(MAIN_SCENE_FILE, FRESH, payload);
    const stored = await storage.readBinary(MAIN_SCENE_FILE);
    const generation = service.registry!.generation;
    const writes = vi.spyOn(storage, "writeBinary");

    await service.writeSceneNavmeshChunk(MAIN_SCENE_FILE, FRESH.slice(), structuredClone(payload));

    expect(writes).not.toHaveBeenCalled();
    writes.mockRestore();
    expect(await storage.readBinary(MAIN_SCENE_FILE)).toEqual(stored);
    expect(service.registry!.generation).toBe(generation);
    // A different bake is still written.
    await service.writeSceneNavmeshChunk(MAIN_SCENE_FILE, bigBytes(9), payload);
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, NAVMESH_CHUNK_ID)).toEqual(bigBytes(9));
  });

  it("refuses an identical bake over its own blob damaged at the same length, yet saves a changed one", async () => {
    const { service, storage, payload } = await opened();
    await service.writeSceneNavmeshChunk(MAIN_SCENE_FILE, FRESH, payload);
    const blob = await blobPath(FRESH);
    const damaged = (await storage.readBinary(blob)).slice();
    damaged[0] ^= 0xff;
    await storage.writeBinary(blob, damaged);
    const before = await storage.readBinary(MAIN_SCENE_FILE);

    // A blob store keeps an existing blob of the right size, so this write could not repair it.
    await expect(service.writeSceneNavmeshChunk(MAIN_SCENE_FILE, FRESH.slice(), payload)).rejects.toThrow(/could not be read/);

    expect(await storage.readBinary(MAIN_SCENE_FILE)).toEqual(before);
    await service.writeSceneNavmeshChunk(MAIN_SCENE_FILE, bigBytes(9), payload);
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, NAVMESH_CHUNK_ID)).toEqual(bigBytes(9));
  });
});

describe("an Audio asset's clip writes", () => {
  const PATH = "assets/Jump.hasset";
  const CLIP_1 = bigBytes(11);
  const CLIP_2 = bigBytes(12);
  const CLIP_3 = new Uint8Array([3, 3, 3]);
  const NEW_CLIP = new Uint8Array([9, 8, 7]);
  const settings = (weight: number, ids = ["source", "source:2", "source:3"]) => ({ clips: ids.map((chunkId) => ({ chunkId, weight })) });
  const wav = (id: string, data: Uint8Array) => chunkOf(id, data, "audio", "audio/wav");

  /** An imported Audio asset: three clips, two of them large enough for the blob store. */
  async function audioAsset(storage: MemoryStorageAdapter, inline = false): Promise<void> {
    const blobs = createVfsBlobStore(storage);
    await storage.writeBinary(PATH, await encodeHasset({
      header: {
        dependencyMetadataVersion: 1, requiredDependencies: [], dependencies: [],
        guid: "audio-guid", type: "Audio", name: "Jump", engineVersion: "0.0.0", version: 1, mode: "thin", parentClass: null,
        payload: settings(1),
      },
      chunks: [wav("source", CLIP_1), wav("source:2", CLIP_2), wav("source:3", CLIP_3)],
      writeBlob: inline ? undefined : (sha256, data) => blobs.writeBlob(sha256, data),
    }));
  }

  async function opened() {
    const { service, storage } = await scaffolded();
    await audioAsset(storage);
    await service.remountRegistry();
    return { service, storage };
  }

  const replaceClip = (service: ProjectService) => service.writeAudioClipChunk(PATH, "source:2", NEW_CLIP, "audio/ogg", settings(2));
  const removeClip = (service: ProjectService) => service.removeAudioClipChunk(PATH, "source:2", settings(2, ["source", "source:3"]));

  it("replaces a clip without reading the others, and puts it after them", async () => {
    const { service, storage } = await opened();
    const reads = vi.spyOn(storage, "readBinary");
    // Control: reading a clip is seen through this spy.
    expect(await service.readAssetChunk(PATH, "source")).toEqual(CLIP_1);
    expect(reads.mock.calls.map(([readPath]) => readPath)).toContain(await blobPath(CLIP_1));
    reads.mockClear();

    await replaceClip(service);

    const read = reads.mock.calls.map(([readPath]) => readPath);
    expect(read).not.toContain(await blobPath(CLIP_1));
    expect(read).not.toContain(await blobPath(CLIP_2));
    reads.mockRestore();
    const header = readAssetDocumentHeader(await storage.readBinary(PATH));
    expect(header.chunks.map(({ id, kind, mime }) => ({ id, kind, mime }))).toEqual([
      { id: "source", kind: "audio", mime: "audio/wav" },
      { id: "source:3", kind: "audio", mime: "audio/wav" },
      { id: "source:2", kind: "audio", mime: "audio/ogg" },
    ]);
    expect(header.payload).toMatchObject(settings(2));
    expect(await service.readAssetChunk(PATH, "source")).toEqual(CLIP_1);
    expect(await service.readAssetChunk(PATH, "source:3")).toEqual(CLIP_3);
    expect(await service.readAssetChunk(PATH, "source:2")).toEqual(NEW_CLIP);
  });

  it("removes a clip without reading the others, and never removes the default source", async () => {
    const { service, storage } = await opened();
    const reads = vi.spyOn(storage, "readBinary");

    await removeClip(service);

    const read = reads.mock.calls.map(([readPath]) => readPath);
    expect(read).not.toContain(await blobPath(CLIP_1));
    expect(read).not.toContain(await blobPath(CLIP_2));
    reads.mockRestore();
    expect(await chunkIds(storage, PATH)).toEqual(["source", "source:3"]);
    expect(await service.readAssetChunk(PATH, "source")).toEqual(CLIP_1);

    await service.removeAudioClipChunk(PATH, "source", settings(3, ["source", "source:3"]));
    expect(await chunkIds(storage, PATH)).toEqual(["source", "source:3"]);
    expect(await service.readAssetChunk(PATH, "source")).toEqual(CLIP_1);
    expect(readAssetDocumentHeader(await storage.readBinary(PATH)).payload).toMatchObject(settings(3, ["source", "source:3"]));
  });

  it.each([["replacing", replaceClip], ["removing", removeClip]] as const)(
    "writes the bytes a full decode and re-encode of every clip would when %s a clip",
    async (_operation, write) => {
      const { carried, full } = await bothPaths(PATH, audioAsset, (service) => write(service));

      expect(full.wholeFileRead).toBe(true);
      expect(carried.wholeFileRead).toBe(false);
      expect(carried.bytes).toEqual(full.bytes);
    },
  );

  it("is not replaced over an asset whose other clip's blob is missing", async () => {
    const { service, storage } = await opened();
    await storage.remove(await blobPath(CLIP_1));
    const before = await storage.readBinary(PATH);

    await expect(replaceClip(service)).rejects.toThrow(/could not be read/);

    expect(await storage.readBinary(PATH)).toEqual(before);
  });

  it("is not removed from an asset whose other inline clip no longer matches its digest", async () => {
    const { service, storage } = await opened();
    const damaged = (await storage.readBinary(PATH)).slice();
    // The small third clip is the file's last inline chunk.
    damaged[damaged.length - 1] ^= 0xff;
    await storage.writeBinary(PATH, damaged);

    await expect(removeClip(service)).rejects.toThrow(/could not be read/);

    expect(await storage.readBinary(PATH)).toEqual(damaged);
  });

  it("is not written when another clip's blob is deleted after the carry confirmed it", async () => {
    const { service, storage } = await opened();
    const clip = await blobPath(CLIP_1);
    const before = await storage.readBinary(PATH);
    const stat = storage.stat.bind(storage);
    let deleted = false;
    vi.spyOn(storage, "stat").mockImplementation(async (statPath) => {
      const result = await stat(statPath);
      if (!deleted && statPath === clip) {
        deleted = true;
        await storage.remove(clip);
      }
      return result;
    });

    await expect(replaceClip(service)).rejects.toThrow(/could not be read/);

    expect(deleted).toBe(true);
    expect(await storage.readBinary(PATH)).toEqual(before);
  });

  it("writes nothing when the clip and settings are the ones already stored, yet writes changed settings", async () => {
    const { service, storage } = await opened();
    await replaceClip(service);
    const stored = await storage.readBinary(PATH);
    const generation = service.registry!.generation;
    const writes = vi.spyOn(storage, "writeBinary");

    await service.writeAudioClipChunk(PATH, "source:2", NEW_CLIP.slice(), "audio/ogg", settings(2));

    expect(writes).not.toHaveBeenCalled();
    expect(await storage.readBinary(PATH)).toEqual(stored);
    expect(service.registry!.generation).toBe(generation);

    await service.writeAudioClipChunk(PATH, "source:2", NEW_CLIP.slice(), "audio/ogg", settings(3));
    expect(writes).toHaveBeenCalledTimes(1);
    writes.mockRestore();
    expect(readAssetDocumentHeader(await storage.readBinary(PATH)).payload).toMatchObject(settings(3));
  });
});
