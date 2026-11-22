import { installMinimalProject } from "../../../../packages/assets/src/test-support/minimal-project";
import { describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  decodeLandscapeChunk,
  landscapeChunkId,
  MAIN_SCENE_FILE,
  parseLandscapeProperties,
  serializeLandscapeProperties,
  type SerializedScene,
} from "@haptic/core";
import {
  decodeAssetDocument,
  readAssetDocumentHeader,
} from "@haptic/assets";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { ProjectService } from "./project-service";
import { loadExportDocuments } from "./export-game-inputs";

describe("Landscape binary .hasset persistence and export sidecars", () => {
  it("stores sculpted terrain as raw HPLD chunks on disk, hydrates on reload, drops orphans on delete, and exports raw sidecars", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("LandscapeTest.hproject");
    await installMinimalProject(storage);
    const service = new ProjectService(storage);
    await service.loadCurrentProject();
    const scenePath = MAIN_SCENE_FILE;

    const heights = new Float32Array(25);
    heights[12] = 5.75;
    const weights = new Uint8Array(25 * 4);
    for (let i = 0; i < 25; i++) weights[i * 4] = 255;
    weights[12 * 4] = 80;
    weights[12 * 4 + 2] = 175;

    const props = serializeLandscapeProperties({
      width: 48,
      depth: 48,
      subdivisions: 4,
      heights,
      weights,
      materialGuid: null,
      collisionsEnabled: true,
    });

    const scene: SerializedScene = {
      ...createDefaultScene(),
      actors: [
        createActor("actor-land", "Island", {
          components: [
            { id: "comp-land", classId: "LandscapeComponent", properties: { ...props } },
          ],
        }),
      ],
    };

    await service.saveDocument("scene", scenePath, scene);

    // 1. Inspect raw .hasset on disk: JSON document chunk must contain `chunkId` and ZERO base64 `data` / `heights` / `weights`.
    const rawBytes = await storage.readBinary(scenePath);
    const header = readAssetDocumentHeader(rawBytes);
    const expectedChunkId = landscapeChunkId("comp-land");
    expect(header.chunks.some((chunk) => chunk.id === expectedChunkId)).toBe(true);
    const diskDoc = await decodeAssetDocument(rawBytes);
    const diskProps = (diskDoc.payload as unknown as SerializedScene).actors[0]!.components[0]!.properties;
    expect(diskProps.chunkId).toBe(expectedChunkId);
    expect(diskProps.data).toBeUndefined();
    expect(diskProps.heights).toBeUndefined();
    expect(diskProps.weights).toBeUndefined();

    // 2. Reload through ProjectService: Editor receives hydrated `data` with exact heights & RGBA8 weights.
    const reloaded = (await service.loadDocument("scene", scenePath)) as SerializedScene;
    const reloadedProps = reloaded.actors[0]!.components[0]!.properties;
    expect(reloadedProps.chunkId).toBeUndefined();
    expect(typeof reloadedProps.data).toBe("string");
    const parsed = parseLandscapeProperties(reloadedProps);
    expect(parsed.heights[12]).toBeCloseTo(5.75, 5);
    expect(parsed.weights[12 * 4]).toBe(80);
    expect(parsed.weights[12 * 4 + 2]).toBe(175);

    // 3. Export loader collects raw HPLD sidecar bytes and keeps Scene JSON free of base64.
    const registry = service.registry!;
    const sceneGuid = service.guidForPath(scenePath)!;
    const exportInputs = await loadExportDocuments({
      assets: registry.list(),
      loadDocument: (kind, path) => service.loadDocument(kind as never, path),
      loadDocumentWithChunks: (kind, path, chunks) => service.loadDocumentWithChunks(kind as never, path, chunks),
      readAssetChunk: (path, chunkId) => service.readAssetChunk(path, chunkId),
    });
    const exportedChunks = exportInputs.componentChunksByGuid(sceneGuid);
    expect(exportedChunks).toHaveLength(1);
    expect(exportedChunks[0]!.chunkId).toBe(expectedChunkId);
    expect(decodeLandscapeChunk(exportedChunks[0]!.bytes)?.heights[12]).toBeCloseTo(5.75, 5);
    const exportedSceneJson = new TextDecoder().decode(exportInputs.bytesByGuid(sceneGuid)!);
    expect(exportedSceneJson).toContain(expectedChunkId);
    expect(exportedSceneJson).not.toContain(props.data!);

    // 4. Removing the LandscapeComponent and saving drops the orphaned landscape:* chunk from disk.
    await service.saveDocument("scene", scenePath, { ...reloaded, actors: [] });
    const afterDeleteHeader = readAssetDocumentHeader(await storage.readBinary(scenePath));
    expect(afterDeleteHeader.chunks.some((chunk) => chunk.id === expectedChunkId)).toBe(false);
  });
});
