import { installMinimalProject } from "../../../../packages/assets/src/test-support/minimal-project";
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
import { decodeAssetDocument, readAssetDocumentHeader } from "@haptic/assets";
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
    const expectedChunkId = foliageChunkId("comp-trees");
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
});
