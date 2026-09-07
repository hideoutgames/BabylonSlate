import { createDefaultMigrationRegistry } from "../migration";
import {
  createActor,
  createDefaultScene,
  createEmptyProject,
  createMeshComponent,
  MAIN_CLASS_FILE,
  MAIN_SCENE_FILE,
  PROJECT_FILE,
  type ProjectStorage,
} from "@babylonslate/core";
import { encodeAssetDocument } from "../asset-document";

/** Small deterministic authored project. It intentionally does not exercise New Project scaffolding. */
export async function minimalProjectFiles(
  name = "TestProject",
): Promise<Map<string, Uint8Array>> {
  const migrations = createDefaultMigrationRegistry();
  const sceneGuid = "00000000-0000-4000-8000-000000000001";
  const classGuid = "00000000-0000-4000-8000-000000000002";
  const project = createEmptyProject(name);
  project.metadata.createdAt = project.metadata.updatedAt =
    "2026-01-01T00:00:00.000Z";
  project.settings.startupSceneGuid = sceneGuid;
  const scene = createDefaultScene();
  scene.actors = [
    createActor("actor-1", "Actor", {
      classId: "Main",
      components: [createMeshComponent("mesh-1", "box")],
    }),
    ...scene.actors.filter(
      (actor) => actor.id === scene.settings.mainCameraActorId,
    ),
  ];
  const graph = {
    nodes: [],
    edges: [],
    members: [],
    components: [createMeshComponent("prefab-mesh", "box")],
  };
  return new Map([
    [PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project))],
    [
      MAIN_SCENE_FILE,
      await encodeAssetDocument(
        {
          guid: sceneGuid,
          type: "Scene",
          name: "Main",
          version: migrations.currentVersion("Scene"),
          payload: scene as unknown as Record<string, unknown>,
        },
        { dependencies: [classGuid] },
      ),
    ],
    [
      MAIN_CLASS_FILE,
      await encodeAssetDocument(
        {
          guid: classGuid,
          type: "Class",
          name: "Main",
          version: migrations.currentVersion("Class"),
          payload: graph,
        },
        { parentClass: "Actor" },
      ),
    ],
  ]);
}

export async function installMinimalProject(
  storage: ProjectStorage,
): Promise<void> {
  await storage.mkdir("assets/.blobs", true);
  for (const [path, bytes] of await minimalProjectFiles())
    await storage.writeBinary(path, bytes);
}
