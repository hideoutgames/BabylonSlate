import { installMinimalProject } from "@haptic/assets/test-support/minimal-project";
import { describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  decodeFoliageChunk,
  foliageChunkId,
  MAIN_SCENE_FILE,
  parseFoliageProperties,
  serializeFoliageProperties,
  type SerializedScene,
} from "@haptic/core";
import { decodeAssetDocument, encodeAssetDocument, readAssetDocumentHeader } from "@haptic/assets";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { ProjectService } from "./project-service";
import { loadExportDocuments } from "./export-game-inputs";

describe("Foliage binary .hasset persistence and export sidecars", () => {
  it("stores painted instances as a raw HPFG chunk, hydrates on reload, drops the orphan on delete, and exports the raw chunk", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("FoliageTest.hproject");
    await installMinimalProject(storage);
    const service = new ProjectService(storage);
    await service.loadCurrentProject();

    // Two instances: (1.5, 0, -2) unrotated at scale 1, and (7, 0.25, 3) at scale 2.
    const transforms = new Float32Array([1.5, 0, -2, 0, 0, 0, 1, 1, 1, 1, 7, 0.25, 3, 0, 0.5, 0, 0.75, 2, 2, 2]);
    const props = serializeFoliageProperties({ groupId: "trees", batches: [
      { modelGuid: "oak", materialGuid: null, cullDistance: 120, fadeRange: 15, shadowDistance: 45, transforms },
    ] });
    const scene: SerializedScene = {
      ...createDefaultScene(),
      actors: [createActor("actor-trees", "Trees", { components: [{ id: "comp-trees", classId: "FoliageComponent", properties: { ...props } }] })],
    };
    await service.saveDocument("scene", MAIN_SCENE_FILE, scene);

    // On disk the document names the chunk and holds no instance in any form.
    const rawBytes = await storage.readBinary(MAIN_SCENE_FILE);
    const expectedChunkId = foliageChunkId("actor-trees/comp-trees");
    expect(readAssetDocumentHeader(rawBytes).chunks.find((chunk) => chunk.id === expectedChunkId)?.byteLength).toBe(8 + 4 + 2 * 10 * 4);
    const diskProps = ((await decodeAssetDocument(rawBytes)).payload as unknown as SerializedScene).actors[0]!.components[0]!.properties;
    expect(diskProps).toEqual({ groupId: "trees", batches: props.batches, chunkId: expectedChunkId });

    // Reloading gives the editor its base64 data back, with the same floats.
    const reloaded = (await service.loadDocument("scene", MAIN_SCENE_FILE)) as SerializedScene;
    const reloadedProps = reloaded.actors[0]!.components[0]!.properties;
    expect(reloadedProps.chunkId).toBeUndefined();
    expect(reloadedProps.data).toBe(props.data);
    expect(Array.from(parseFoliageProperties(reloadedProps).batches[0]!.transforms)).toEqual(Array.from(transforms));

    // Export carries the raw chunk beside a Scene JSON free of base64.
    const sceneGuid = service.guidForPath(MAIN_SCENE_FILE)!;
    const exportInputs = await loadExportDocuments({
      assets: service.registry!.list(),
      loadDocument: (kind, path) => service.loadDocument(kind as never, path),
      loadDocumentWithChunks: (kind, path, chunks) => service.loadDocumentWithChunks(kind as never, path, chunks),
      readAssetChunk: (path, chunkId) => service.readAssetChunk(path, chunkId),
    });
    const exported = exportInputs.componentChunksByGuid(sceneGuid);
    expect(exported.map((chunk) => chunk.chunkId)).toEqual([expectedChunkId]);
    expect(Array.from(decodeFoliageChunk(exported[0]!.bytes)[0]!)).toEqual(Array.from(transforms));
    const exportedSceneJson = new TextDecoder().decode(exportInputs.bytesByGuid(sceneGuid)!);
    expect(exportedSceneJson).toContain(expectedChunkId);
    expect(exportedSceneJson).not.toContain(props.data!);

    // Deleting the component and saving drops the orphaned chunk.
    await service.saveDocument("scene", MAIN_SCENE_FILE, { ...reloaded, actors: [] });
    expect(readAssetDocumentHeader(await storage.readBinary(MAIN_SCENE_FILE)).chunks.some((chunk) => chunk.id === expectedChunkId)).toBe(false);
  });

  async function openProject(name: string) {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject(`${name}.hproject`);
    await installMinimalProject(storage);
    const service = new ProjectService(storage);
    await service.loadCurrentProject();
    return { storage, service };
  }
  const batchAt = (x: number) => ({ modelGuid: "oak", materialGuid: null, cullDistance: 120, fadeRange: 15, shadowDistance: 45,
    transforms: new Float32Array([x, 0, 0, 0, 0, 0, 1, 1, 1, 1]) });

  it("keeps each of several instances of one Prefab in a Scene its own instances through save, reload and Play preparation", async () => {
    const { storage, service } = await openProject("PrefabFoliage");
    // Both instances carry the Prefab's component id, as synced Prefab instances do.
    const instance = (actorId: string, x: number) => createActor(actorId, actorId, { prefabGuid: "grove", components: [
      { id: "trees", classId: "FoliageComponent", properties: { ...serializeFoliageProperties({ groupId: "g", batches: [batchAt(x)] }) } },
    ] });
    await service.saveDocument("scene", MAIN_SCENE_FILE, { ...createDefaultScene(), actors: [instance("first", 1), instance("second", 2)] });
    const reloaded = (await service.loadDocument("scene", MAIN_SCENE_FILE)) as SerializedScene;
    expect(reloaded.actors.map((actor) => parseFoliageProperties(actor.components[0]!.properties).batches[0]!.transforms[0])).toEqual([1, 2]);
    const exportInputs = await loadExportDocuments({
      assets: service.registry!.list(),
      loadDocument: (kind, path) => service.loadDocument(kind as never, path),
      loadDocumentWithChunks: (kind, path, chunks) => service.loadDocumentWithChunks(kind as never, path, chunks),
      readAssetChunk: (path, chunkId) => service.readAssetChunk(path, chunkId),
    });
    const sceneGuid = service.guidForPath(MAIN_SCENE_FILE)!;
    const exported = exportInputs.componentChunksByGuid(sceneGuid);
    expect(exported.map((chunk) => [chunk.chunkId, decodeFoliageChunk(chunk.bytes)[0]![0]])).toEqual([["foliage:first/trees", 1], ["foliage:second/trees", 2]]);
    const scene = JSON.parse(new TextDecoder().decode(exportInputs.bytesByGuid(sceneGuid)!)) as SerializedScene;
    expect(scene.actors.map((actor) => actor.components[0]!.properties.chunkId)).toEqual(["foliage:first/trees", "foliage:second/trees"]);
    void storage;
  });

  it("keeps a Prefab's Foliage inline, so placed instances and runtime spawns need no chunk of the Prefab", async () => {
    const { storage, service } = await openProject("PrefabInline");
    const props = serializeFoliageProperties({ groupId: "g", batches: [batchAt(3)] });
    const path = "assets/Grove.prefab.hasset";
    await service.saveDocument("prefab", path, { name: "Grove", components: [{ id: "trees", classId: "FoliageComponent", properties: { ...props } }] });
    const bytes = await storage.readBinary(path);
    expect(readAssetDocumentHeader(bytes).chunks.map((chunk) => chunk.id)).toEqual(["document"]);
    const stored = (await decodeAssetDocument(bytes)).payload as { components: Array<{ properties: Record<string, unknown> }> };
    expect(stored.components[0]!.properties.data).toBe(props.data);
  });

  it("reports a Scene chunk that cannot be decoded and carries it unchanged through the next save", async () => {
    const { storage, service } = await openProject("BrokenFoliage");
    const chunkId = foliageChunkId("a/trees");
    const broken = new Uint8Array([0x48, 0x50, 0x46, 0x47, 9, 0, 1, 0]);
    await storage.writeBinary(MAIN_SCENE_FILE, await encodeAssetDocument({ type: "Scene", name: "Main", guid: "scene", version: 1, payload: {
      ...createDefaultScene(), actors: [createActor("a", "Trees", { components: [
        { id: "trees", classId: "FoliageComponent", properties: { groupId: "g", batches: [{ modelGuid: "oak" }], chunkId } },
      ] })],
    } as unknown as Record<string, unknown> }, { extraChunks: [{ id: chunkId, kind: "foliage", mime: "application/octet-stream", data: broken }] }));
    await service.registry!.reindexPath(MAIN_SCENE_FILE);
    const lines: string[] = [];
    const stop = service.onDiagnostic((line) => lines.push(line));
    const loaded = (await service.loadDocument("scene", MAIN_SCENE_FILE)) as SerializedScene;
    stop();
    expect(lines.some((line) => line.includes("the instance data of the Foliage on \"Trees\" is missing or damaged"))).toBe(true);
    expect(parseFoliageProperties(loaded.actors[0]!.components[0]!.properties)).toMatchObject({ batches: [], unreadable: true });
    await service.saveDocument("scene", MAIN_SCENE_FILE, { ...loaded, name: "Renamed" });
    const after = await storage.readBinary(MAIN_SCENE_FILE);
    expect(readAssetDocumentHeader(after).chunks.find((chunk) => chunk.id === chunkId)?.byteLength).toBe(broken.byteLength);
    const props = ((await decodeAssetDocument(after)).payload as unknown as SerializedScene).actors[0]!.components[0]!.properties;
    expect(props.chunkId).toBe(chunkId);
  });
});
