import { describe, expect, it } from "vitest";
import {
  MAIN_SCENE_FILE,
  PROJECT_FILE,
  SCENE_SCHEMA_VERSION,
  type SerializedScene,
} from "@babylonslate/core";
import {
  createDefaultMigrationRegistry,
  decodeAssetDocument,
  encodeAssetDocument,
  readAssetDocumentHeader,
  type MigrationRegistry,
} from "@babylonslate/assets";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { ProjectService } from "./project-service";

const OLD_SCENE_VERSION = SCENE_SCHEMA_VERSION - 1;

/**
 * The shipped registry has no migration steps, so these tests inject one per
 * type to keep exercising migrate-on-load and the approval flow. The Scene
 * step renames `title` to `name`, which shows it ran.
 */
function registryWithSteps(): MigrationRegistry {
  const registry = createDefaultMigrationRegistry();
  registry.register({
    type: "Scene",
    currentVersion: SCENE_SCHEMA_VERSION,
    migrations: [({ title, ...payload }) => ({ ...payload, name: title })],
  });
  registry.register({
    type: "Project",
    currentVersion: 1,
    migrations: [(payload) => ({ ...payload })],
  });
  return registry;
}

async function projectWithScene(
  sceneVersion: number,
  migrations?: MigrationRegistry,
) {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("Migrate.babproject");
  const service = new ProjectService(storage, { migrations });
  const { document, layouts } = await service.loadCurrentProject();

  await storage.writeBinary(
    MAIN_SCENE_FILE,
    await encodeAssetDocument({
      type: "Scene",
      name: "main.scene",
      guid: "scene-guid",
      version: sceneVersion,
      payload: sceneVersion === SCENE_SCHEMA_VERSION ? { name: "Old" } : { title: "Old" },
    }),
  );
  // Replacing a mounted fixture must update both the index and its references.
  await service.registry!.reindexPath(MAIN_SCENE_FILE);
  document.settings.startupSceneGuid = "scene-guid";
  await service.saveProject(document, layouts);
  return { storage, service };
}

const projectWithOldScene = () =>
  projectWithScene(OLD_SCENE_VERSION, registryWithSteps());

describe("migrate-on-load and migrate-on-save approval", () => {
  it("fills additive scene settings for a current-version payload that omitted them", async () => {
    const { service } = await projectWithScene(SCENE_SCHEMA_VERSION);
    const scene = (await service.loadDocument(
      "scene",
      MAIN_SCENE_FILE,
    )) as SerializedScene;

    expect(service.pendingMigrations).toEqual([]);
    expect(scene.name).toBe("Old");
    expect(scene.actors).toEqual([]);
    expect(scene.settings.environmentColor).toEqual([0.06, 0.07, 0.09]);
    expect(scene.settings.grid.snapTranslate).toBe(1);
    expect(scene.settings.grid.showGrid).toBe(true);
    expect(scene.settings.cameraBounds2D).toEqual({ width: 16, height: 9 });
  });

  it("refuses an older Scene format without upgrading or rewriting it", async () => {
    const { storage, service } = await projectWithScene(OLD_SCENE_VERSION);
    const before = await storage.readBinary(MAIN_SCENE_FILE);

    await expect(
      service.loadDocument("scene", MAIN_SCENE_FILE),
    ).rejects.toThrow(/unsupported old format/);
    expect(service.pendingMigrations).toEqual([]);
    expect(await storage.readBinary(MAIN_SCENE_FILE)).toEqual(before);
  });

  it("migrates on load without rewriting the file", async () => {
    const { storage, service } = await projectWithOldScene();
    const before = await storage.readBinary(MAIN_SCENE_FILE);

    const scene = await service.loadDocument("scene", MAIN_SCENE_FILE);
    expect(scene).toMatchObject({ name: "Old", actors: [], viewportMode: "3d" });
    expect(service.pendingMigrations).toEqual([
      {
        type: "Scene",
        fromVersion: OLD_SCENE_VERSION,
        toVersion: SCENE_SCHEMA_VERSION,
        path: MAIN_SCENE_FILE,
      },
    ]);
    expect(await storage.readBinary(MAIN_SCENE_FILE)).toEqual(before);
  });

  it("lists an unmigrated asset once however often it loads", async () => {
    const { service } = await projectWithOldScene();

    await service.loadDocument("scene", MAIN_SCENE_FILE);
    await service.loadDocument("scene", MAIN_SCENE_FILE);

    expect(service.pendingMigrations.map((pending) => pending.path)).toEqual([
      MAIN_SCENE_FILE,
    ]);
  });

  it.each(["save", "navmesh"] as const)("refuses a %s write of a migrated asset before the user approves", async (write) => {
    const { storage, service } = await projectWithOldScene();
    const before = await storage.readBinary(MAIN_SCENE_FILE);
    const scene = await service.loadDocument("scene", MAIN_SCENE_FILE);

    await expect(write === "save"
      ? service.saveDocument("scene", MAIN_SCENE_FILE, scene)
      : service.writeSceneNavmeshChunk(MAIN_SCENE_FILE, new Uint8Array([1]), scene as Record<string, unknown>),
    ).rejects.toThrow(/requires user approval/);
    expect(await storage.readBinary(MAIN_SCENE_FILE)).toEqual(before);
  });

  it("writes the current schema once migration is approved", async () => {
    const { storage, service } = await projectWithOldScene();
    const scene = await service.loadDocument("scene", MAIN_SCENE_FILE);

    service.approveMigrateOnSave();
    await service.saveDocument("scene", MAIN_SCENE_FILE, scene);

    const bytes = await storage.readBinary(MAIN_SCENE_FILE);
    const header = readAssetDocumentHeader(bytes);
    expect(header.version).toBe(SCENE_SCHEMA_VERSION);
    expect(header.guid).toBe("scene-guid");
    expect((await decodeAssetDocument(bytes)).payload).toMatchObject({ name: "Old" });
    expect(service.guidForPath(MAIN_SCENE_FILE)).toBe("scene-guid");
    expect(JSON.parse(await storage.readText(PROJECT_FILE)).settings.startupSceneGuid).toBe("scene-guid");
    expect(service.pendingMigrations).toEqual([]);
  });

  it("clears approval when a project closes", async () => {
    const { service } = await projectWithOldScene();
    await service.loadDocument("scene", MAIN_SCENE_FILE);
    service.approveMigrateOnSave();
    await service.closeProject();
    expect(service.pendingMigrations).toEqual([]);
  });

  it("refuses assets written by a newer engine", async () => {
    const { service } = await projectWithScene(99);
    await expect(
      service.loadDocument("scene", MAIN_SCENE_FILE),
    ).rejects.toThrow(/newer engine version/);
  });

  it("gates project manifest saves on the same approval", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("ManifestMigrate.babproject");
    const service = new ProjectService(storage, { migrations: registryWithSteps() });
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
