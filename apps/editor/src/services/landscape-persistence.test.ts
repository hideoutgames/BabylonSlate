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
  type SerializedGraph,
  type SerializedScene,
} from "@haptic/core";
import {
  collectLandscapeChunksForPlay,
  createDefaultMigrationRegistry,
  decodeAssetDocument,
  encodeAssetDocument,
  LANDSCAPE_CHUNK_KIND,
  LANDSCAPE_CHUNK_MIME,
  readAssetDocumentHeader,
} from "@haptic/assets";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { ProjectService } from "./project-service";
import { loadExportDocuments } from "./export-game-inputs";
import { prefabAssetTemplateKey, prefabAssetTemplates, syncSceneActorsFromPrefabs } from "../lib/prefab-instance-sync";

/** Serialized Landscape properties for a 4 x 4 cell field with `height` at its centre sample. */
function peak(height: number) {
  const heights = new Float32Array(25);
  heights[12] = height;
  return serializeLandscapeProperties(parseLandscapeProperties({ width: 8, depth: 8, subdivisions: 4, heights, collisionsEnabled: true }));
}

async function openProject(prepare?: (storage: MemoryStorageAdapter) => Promise<void>) {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("LandscapeTest.hproject");
  await installMinimalProject(storage);
  await prepare?.(storage);
  const service = new ProjectService(storage);
  await service.loadCurrentProject();
  return { storage, service };
}

function exportInputs(service: ProjectService) {
  return loadExportDocuments({
    assets: service.registry!.list(),
    loadDocument: (kind, path) => service.loadDocument(kind as never, path),
    loadDocumentWithChunks: (kind, path, chunks) => service.loadDocumentWithChunks(kind as never, path, chunks),
    readAssetChunk: (path, chunkId) => service.readAssetChunk(path, chunkId),
  });
}

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
    const expectedChunkId = landscapeChunkId("actor-land/comp-land");
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

  it("keeps Prefab and Class terrain in their documents, so every reader and every placed instance gets it", async () => {
    const { storage, service } = await openProject();
    const classPath = "assets/Island.class.hasset";
    const prefabPath = "assets/Hill.prefab.hasset";
    const islandGraph = { nodes: [], edges: [], members: [], components: [{ id: "island-land", classId: "LandscapeComponent", properties: { ...peak(2.5) } }] };
    await service.saveDocument("graph", classPath, islandGraph, { parentClass: "Actor" });
    await service.saveDocument("prefab", prefabPath, { components: [{ id: "hill-land", classId: "LandscapeComponent", properties: { ...peak(4.5) } }] });

    // Play compiles Classes from the stored document it already read, without the editor's chunk hydration.
    for (const [kind, path, height] of [["graph", classPath, 2.5], ["prefab", prefabPath, 4.5]] as const) {
      const raw = await storage.readBinary(path);
      expect(readAssetDocumentHeader(raw).chunks.some((chunk) => chunk.id.startsWith("landscape:"))).toBe(false);
      const stored = await decodeAssetDocument(raw);
      const content = service.documentContentFromStored(kind, stored) as { components: Array<{ properties: Record<string, unknown> }> };
      expect(parseLandscapeProperties(content.components[0]!.properties).heights[12]).toBeCloseTo(height, 5);
    }

    // A Scene placing the Prefab takes the instance's terrain from the Prefab and saves it as its own chunk.
    const prefabGuid = service.guidForPath(prefabPath)!;
    const templates = prefabAssetTemplates({ assets: service.registry!.list(), openDocuments: [] });
    expect(templates[prefabAssetTemplateKey(prefabGuid)]).toBeDefined();
    const placed = syncSceneActorsFromPrefabs({
      ...createDefaultScene(),
      actors: [{ ...createActor("hill", "Hill", {}), prefabGuid }],
    }, templates);
    await service.saveDocument("scene", MAIN_SCENE_FILE, placed);

    const sceneGuid = service.guidForPath(MAIN_SCENE_FILE)!;
    const classGuid = service.guidForPath(classPath)!;
    const inputs = await exportInputs(service);
    const sceneChunks = inputs.componentChunksByGuid(sceneGuid);
    expect(sceneChunks).toHaveLength(1);
    expect(decodeLandscapeChunk(sceneChunks[0]!.bytes)!.heights[12]).toBeCloseTo(4.5, 5);
    const exportedClass = inputs.graphByGuid(classGuid) as SerializedGraph;
    expect(parseLandscapeProperties(exportedClass.components![0]!.properties).heights[12]).toBeCloseTo(2.5, 5);
  });

  it("opens, saves, plays and exports a Scene with a damaged landscape chunk, warning once and keeping the stored bytes", async () => {
    const damaged = new Uint8Array([66, 83, 76, 68, 1, 0, 0, 0, 4, 0]);
    const chunkId = landscapeChunkId("land");
    const { service } = await openProject(async (storage) => {
      const scene = {
        ...createDefaultScene(),
        actors: [createActor("island", "Island", {
          components: [{ id: "land", classId: "LandscapeComponent", properties: { width: 8, depth: 8, subdivisions: 4, chunkId, materialGuid: null, collisionsEnabled: true } }],
        })],
      };
      const existing = await decodeAssetDocument(await storage.readBinary(MAIN_SCENE_FILE));
      await storage.writeBinary(MAIN_SCENE_FILE, await encodeAssetDocument({
        type: "Scene", name: "Main", guid: existing.guid, version: createDefaultMigrationRegistry().currentVersion("Scene"),
        payload: scene as unknown as Record<string, unknown>,
      }, { extraChunks: [{ id: chunkId, kind: LANDSCAPE_CHUNK_KIND, mime: LANDSCAPE_CHUNK_MIME, data: damaged }] }));
    });

    const opened = (await service.loadDocument("scene", MAIN_SCENE_FILE)) as SerializedScene;
    const props = opened.actors[0]!.components[0]!.properties;
    expect(props.chunkId).toBe(chunkId);
    expect(parseLandscapeProperties(props).heights.every((height) => height === 0)).toBe(true);
    await service.loadDocument("scene", MAIN_SCENE_FILE);
    const warnings = service.sessionDiagnostics.filter((line) => line.includes("terrain data"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(MAIN_SCENE_FILE);
    expect(warnings[0]).toContain("\"Island\"");

    // Saving another edit keeps the damaged chunk exactly as stored instead of writing flat terrain over it.
    await service.saveDocument("scene", MAIN_SCENE_FILE, { ...opened, actors: [{ ...opened.actors[0]!, name: "Renamed" }] });
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, chunkId)).toEqual(damaged);

    // Play and Export gather the Scene without the damaged chunk; the runtime then warns and plays it flat.
    const play = collectLandscapeChunksForPlay(opened, new Map([[chunkId, damaged]]));
    expect(play.chunks.size).toBe(0);
    const inputs = await exportInputs(service);
    expect(inputs.componentChunksByGuid(service.guidForPath(MAIN_SCENE_FILE)!)).toEqual([]);
    expect(inputs.bytesByGuid(service.guidForPath(MAIN_SCENE_FILE)!)).not.toBeNull();
  });
});
