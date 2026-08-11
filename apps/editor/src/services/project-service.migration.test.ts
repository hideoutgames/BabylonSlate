import { describe, expect, it } from "vitest";
import { MAIN_SCENE_FILE, PROJECT_FILE } from "@babylonslate/core";
import { encodeAssetDocument, readAssetDocumentHeader } from "@babylonslate/assets";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { ProjectService } from "./project-service";

async function projectWithOldScene(sceneVersion: number) {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("Migrate.babproject");
  const service = new ProjectService(storage);
  await service.loadCurrentProject();

  await storage.writeBinary(
    MAIN_SCENE_FILE,
    await encodeAssetDocument({
      type: "Scene",
      name: "main.scene",
      guid: "scene-guid",
      version: sceneVersion,
      payload: { name: "Old" },
    }),
  );
  return { storage, service };
}

describe("migrate-on-load and migrate-on-save approval", () => {
  it("migrates on load without rewriting the file", async () => {
    const { storage, service } = await projectWithOldScene(0);
    const before = await storage.readBinary(MAIN_SCENE_FILE);

    const scene = await service.loadDocument("scene", MAIN_SCENE_FILE);
    expect(scene).toEqual({ name: "Old", meshes: [] });
    expect(service.pendingMigrations).toEqual([
      { type: "Scene", fromVersion: 0, toVersion: 1, path: MAIN_SCENE_FILE },
    ]);
    expect(await storage.readBinary(MAIN_SCENE_FILE)).toEqual(before);
  });

  it("refuses to save a migrated asset before the user approves", async () => {
    const { service } = await projectWithOldScene(0);
    const scene = await service.loadDocument("scene", MAIN_SCENE_FILE);

    await expect(
      service.saveDocument("scene", MAIN_SCENE_FILE, scene),
    ).rejects.toThrow(/requires user approval/);
  });

  it("writes the current schema once migration is approved", async () => {
    const { storage, service } = await projectWithOldScene(0);
    const scene = await service.loadDocument("scene", MAIN_SCENE_FILE);

    service.approveMigrateOnSave();
    await service.saveDocument("scene", MAIN_SCENE_FILE, scene);

    const header = readAssetDocumentHeader(
      await storage.readBinary(MAIN_SCENE_FILE),
    );
    expect(header.version).toBe(1);
    expect(header.guid).toBe("scene-guid");
    expect(service.pendingMigrations).toEqual([]);
  });

  it("clears approval when a project closes", async () => {
    const { service } = await projectWithOldScene(0);
    await service.loadDocument("scene", MAIN_SCENE_FILE);
    service.approveMigrateOnSave();
    await service.closeProject();
    expect(service.pendingMigrations).toEqual([]);
  });

  it("refuses assets written by a newer engine", async () => {
    const { service } = await projectWithOldScene(99);
    await expect(
      service.loadDocument("scene", MAIN_SCENE_FILE),
    ).rejects.toThrow(/newer engine version/);
  });

  it("gates project manifest saves on the same approval", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("ManifestMigrate.babproject");
    const service = new ProjectService(storage);
    const { document, layouts } = await service.loadCurrentProject();

    const manifest = JSON.parse(await storage.readText(PROJECT_FILE));
    manifest.version = 0;
    await storage.writeText(PROJECT_FILE, JSON.stringify(manifest));

    const reloaded = await service.loadCurrentProject();
    expect(reloaded.migrationPending.map((p) => p.path)).toEqual([PROJECT_FILE]);

    await expect(service.saveProject(document, layouts)).rejects.toThrow(
      /requires user approval/,
    );

    service.approveMigrateOnSave();
    await service.saveProject(document, layouts);
    expect(JSON.parse(await storage.readText(PROJECT_FILE)).version).toBe(1);
  });
});
