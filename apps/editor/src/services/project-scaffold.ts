import {
  createDefaultInputAssets,
  createEmptyLayouts,
  MAIN_CLASS_FILE,
  MAIN_SCENE_FILE,
  type ProjectDocument,
  type ProjectFolderHandle,
  type ProjectStorage,
  type SerializedScene,
} from "@haptic/core";
import type { AssetRegistry } from "@haptic/assets";
import type { NavMeshGenerateInput } from "@haptic/navigation";
import { createAppSettingsStore } from "@haptic/vfs";
import { newAssetFileName } from "../lib/content-browser-helpers";
import { loadKenneyMannequinGlb } from "../lib/kenney-mannequin";
import {
  applyKenneyMannequinEmptyScaffold,
  MANNEQUIN_CLASS_FILE,
} from "../lib/scaffold-empty-3d";
import type { ProjectService } from "./project-service";

export type OwnedFolder = { handle: ProjectFolderHandle; createdHere: boolean };

const PROJECT_CREATION_MARKER = ".haptic-creating";
/** Entries that do not make a folder "non-empty": our own marker and OS file-browser metadata. */
const IGNORED_PROJECT_FOLDER_ENTRIES = new Set([PROJECT_CREATION_MARKER, ".DS_Store", "Thumbs.db", "desktop.ini"]);

/** True when the current folder holds nothing a scaffold could overwrite. */
export async function projectFolderIsEmpty(storage: ProjectStorage): Promise<boolean> {
  const entries = await storage.readdir(".");
  return entries.every((entry) => IGNORED_PROJECT_FOLDER_ENTRIES.has(entry.name));
}

/** New projects are scaffolded only into an empty folder, never over existing files. */
export async function assertEmptyProjectFolder(storage: ProjectStorage): Promise<void> {
  if (!(await projectFolderIsEmpty(storage))) {
    throw new Error("This folder already contains files but no project.json. Choose an empty folder or open an existing project.");
  }
}

/** Opens the Documents-tier folder for `name`, recording whether this call created it. */
export async function openOwnedDocumentsProject(storage: ProjectStorage, name: string): Promise<OwnedFolder> {
  const known = await storage.listProjects();
  const handle = await storage.openDocumentsProject(name);
  const registered = known.some((p) => p.id === handle.id);
  let empty = false;
  if (!registered) {
    try {
      empty = (await storage.readdir(".")).length === 0;
    } catch {
      empty = false;
    }
  }
  if (await storage.exists(PROJECT_CREATION_MARKER)) {
    // Only fresh app-owned folders receive the marker. A retry can use a
    // different template, so discard the interrupted scaffold's files.
    if (storage.deleteProject) {
      await storage.deleteProject(handle);
      return { handle: await storage.openDocumentsProject(name), createdHere: true };
    }
    for (const entry of await storage.readdir(".")) await storage.remove(entry.name);
    return { handle, createdHere: true };
  }
  return { handle, createdHere: !registered && empty };
}

export async function scaffoldOwnedProject<T>(
  storage: ProjectStorage,
  owned: OwnedFolder | null,
  scaffold: () => Promise<T>,
): Promise<T> {
  try {
    if (owned?.createdHere) await storage.writeText(PROJECT_CREATION_MARKER, "Project creation in progress\n");
    const result = await scaffold();
    if (owned?.createdHere && storage.getCurrentFolder()?.id === owned.handle.id) {
      await storage.remove(PROJECT_CREATION_MARKER);
    }
    return result;
  } catch (cause) {
    // A failed scaffold leaves a registered folder that never reaches the
    // recents list but still blocks the name via the project-file check.
    // Drop only folders this call created itself and still owns;
    // user-picked folders and pre-existing folders stay.
    if (
      owned?.createdHere &&
      storage.deleteProject &&
      storage.getCurrentFolder()?.id === owned.handle.id
    ) {
      try {
        await storage.deleteProject(owned.handle);
      } catch (cleanupError) {
        console.warn(
          `Could not remove partially created project "${owned.handle.name}"`,
          cleanupError,
        );
      }
    }
    throw cause;
  }
}

/** The project writes a starter scaffold makes after the empty project exists. */
export interface StarterScaffoldHost extends Pick<ProjectService, "saveDocument" | "loadDocument" | "saveProject" | "writeSceneNavmeshChunk"> {
  readonly storage: ProjectStorage;
  registry(): AssetRegistry | null;
  /** The identity a write of `path` keeps. */
  guidForAsset(path: string): Promise<string>;
  /** Guids a scaffold embedded in other documents before writing these paths. */
  readonly reservedAssetGuids: Map<string, string>;
}

/** Navmesh bake for scaffolds: the bake worker in the app, Recast directly in unit tests. */
async function generateFeatureTestNavMesh(input: NavMeshGenerateInput): Promise<Uint8Array> {
  if (typeof Worker === "function" && import.meta.env.MODE !== "test") {
    const { createNavBakeWorker } = await import("./nav-bake-worker-host");
    const worker = createNavBakeWorker();
    try {
      return await worker.generate(input);
    } finally {
      worker.terminate();
    }
  }
  const { generateNavMesh } = await import("@haptic/navigation");
  return generateNavMesh(input);
}

export async function createInputAssets(host: StarterScaffoldHost): Promise<void> {
  await host.storage.mkdir("assets/Input", true);
  for (const { type, name, ...payload } of createDefaultInputAssets()) {
    const path = `assets/Input/${newAssetFileName(type, name)}`;
    await host.saveDocument(type === "InputAction" ? "input-action" : "input-axis", path, payload);
  }
}

export async function scaffoldKenneyMannequinEmpty(
  host: StarterScaffoldHost,
  document: ProjectDocument,
  modelImportScale?: number,
): Promise<void> {
  const registry = host.registry();
  if (!registry) {
    throw new Error("Asset registry is not mounted.");
  }
  const scene = (await host.loadDocument(
    "scene",
    MAIN_SCENE_FILE,
  )) as SerializedScene;
  const next = await applyKenneyMannequinEmptyScaffold({
    registry,
    scene,
    mannequinBytes: await loadKenneyMannequinGlb(),
    modelImportScale: modelImportScale ?? (await createAppSettingsStore().load()).modelImportDefaultScale,
  });
  await host.saveDocument("scene", MAIN_SCENE_FILE, next);
  if (await host.storage.exists(MAIN_CLASS_FILE)) {
    await host.storage.remove(MAIN_CLASS_FILE);
  }
  const classPath = `assets/${MANNEQUIN_CLASS_FILE}`;
  document.graphs = [classPath];
  await host.saveProject(document, createEmptyLayouts());
}

/**
 * FeatureTest starter: every engine feature on top of Basic 3D. Lazily
 * loaded so its scaffold code stays out of the editor startup chunk.
 */
export async function scaffoldFeatureTest(host: StarterScaffoldHost, document: ProjectDocument): Promise<void> {
  const registry = host.registry();
  if (!registry) throw new Error("Asset registry is not mounted.");
  const [{ applyFeatureTestScaffold }, content] = await Promise.all([
    import("../lib/feature-test"),
    import("../lib/engine-content"),
  ]);
  let result: Awaited<ReturnType<typeof applyFeatureTestScaffold>>;
  try {
    result = await applyFeatureTestScaffold({
      mainScenePath: MAIN_SCENE_FILE,
      host: {
        registry,
        saveDocument: (kind, path, payload, options) => host.saveDocument(kind, path, payload, options),
        loadDocument: (kind, path) => host.loadDocument(kind, path),
        // References are written before their targets, so the guid must hold until the save.
        guidForAsset: async (path) => {
          const guid = await host.guidForAsset(path);
          if (!registry.getByPath(path)) host.reservedAssetGuids.set(path, guid);
          return guid;
        },
        writeSceneNavmeshChunk: (path, bytes, payload) => host.writeSceneNavmeshChunk(path, bytes, payload),
        loadBytes: content.loadEngineContentBytes,
        loadOptional: content.loadOptionalEngineContent,
        generateNavMesh: generateFeatureTestNavMesh,
        modelImportScale: 1,
      },
    });
  } finally {
    host.reservedAssetGuids.clear();
  }
  const paths = registry.listDocumentPaths({ rootId: "project" });
  document.scenes = paths.scenes;
  document.graphs = paths.graphs;
  document.settings = result.applySettings(document.settings);
  await host.saveProject(document, createEmptyLayouts());
}
