import { describe, expect, it } from "vitest";
import {
  MAIN_SCENE_FILE,
  PROJECT_FILE,
  SCENE_SCHEMA_VERSION,
  type SerializedScene,
} from "@haptic/core";
import {
  AssetFormatVersionError,
  encodeAssetDocument,
  readAssetDocumentHeader,
} from "@haptic/assets";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { ProjectService } from "./project-service";

async function projectWithScene(sceneVersion: number) {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("Formats.hproject");
  const service = new ProjectService(storage);
  const { document, layouts } = await service.loadCurrentProject();

  await storage.writeBinary(
    MAIN_SCENE_FILE,
    await encodeAssetDocument({
      type: "Scene",
      name: "main.scene",
      guid: "scene-guid",
      version: sceneVersion,
      payload: { name: "Stored" },
    }),
  );
  // Replacing a mounted fixture must update both the index and its references.
  await service.registry!.reindexPath(MAIN_SCENE_FILE);
  document.settings.startupSceneGuid = "scene-guid";
  await service.saveProject(document, layouts);
  return { storage, service };
}

describe("strict asset format versions", () => {
  it("fills additive scene settings for a current-version payload that omitted them", async () => {
    const { service } = await projectWithScene(SCENE_SCHEMA_VERSION);
    const scene = (await service.loadDocument(
      "scene",
      MAIN_SCENE_FILE,
    )) as SerializedScene;

    expect(scene.name).toBe("Stored");
    expect(scene.actors).toEqual([]);
    expect(scene.settings.environmentColor).toEqual([0.06, 0.07, 0.09]);
    expect(scene.settings.grid.snapTranslate).toBe(1);
    expect(scene.settings.grid.showGrid).toBe(true);
    expect(scene.settings.cameraBounds2D).toEqual({ width: 16, height: 9 });
  });

  it.each([
    ["an older", 0, /unsupported old format/],
    ["a newer", 2, /newer engine version/],
  ] as const)("refuses %s Scene format without rewriting it", async (_label, version, message) => {
    const { storage, service } = await projectWithScene(version);
    const before = await storage.readBinary(MAIN_SCENE_FILE);

    const load = service.loadDocument("scene", MAIN_SCENE_FILE);
    await expect(load).rejects.toBeInstanceOf(AssetFormatVersionError);
    await expect(load).rejects.toThrow(message);
    expect(await storage.readBinary(MAIN_SCENE_FILE)).toEqual(before);
  });

  it("saves an asset type with no special version at version 1", async () => {
    const { storage, service } = await projectWithScene(SCENE_SCHEMA_VERSION);
    const path = "assets/Level.tilemap.hasset";
    await service.saveDocument("tilemap", path, { tilesetGuid: null, layers: [] });
    expect(readAssetDocumentHeader(await storage.readBinary(path)).version).toBe(1);
  });

  it("refuses a project manifest from a newer engine", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Manifest.hproject");
    const service = new ProjectService(storage);
    await service.loadCurrentProject();

    const manifest = JSON.parse(await storage.readText(PROJECT_FILE));
    manifest.version = 2;
    await storage.writeText(PROJECT_FILE, JSON.stringify(manifest));

    await expect(service.loadCurrentProject()).rejects.toThrow(/"Project" version 2 was made with a newer engine version/);
  });
});
