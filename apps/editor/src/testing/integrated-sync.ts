import { DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS } from "@haptic/core";
import { GITATTRIBUTES_LFS_RULE, type FileLock } from "@haptic/source-control";
import { FakeRemote, FakeSync } from "@haptic/source-control/fake-sync";
import { MemoryStorageAdapter } from "@haptic/vfs";
import type { ChangeLookup } from "../lib/source-control-changes";
import { SourceControlSyncService, type SyncLocks } from "../services/source-control-sync";

export const INTEGRATED_REPOSITORY = "https://github.com/team/game.git";

/** Forest (a Scene) and Rock (a Texture), as the registry would describe them. */
export const INTEGRATED_LOOKUP: ChangeLookup = (path) =>
  path === "assets/Forest.scene.hasset" ? { name: "Forest", type: "Scene", blobs: [] }
    : path === "assets/Rock.texture.hasset" ? { name: "Rock", type: "Texture", blobs: [] }
      : null;

/**
 * A real `SourceControlSyncService` in Integrated mode over `FakeSync`: a
 * working copy in memory storage of a `FakeRemote` seeded with Forest and
 * Rock, so editor tests drive the same service the editor runs.
 */
export async function integratedSync(options: { locks?: Partial<SyncLocks>; lfsRule?: boolean } = {}) {
  const remote = new FakeRemote();
  remote.commit({
    ...(options.lfsRule === false ? {} : { ".gitattributes": `${GITATTRIBUTES_LFS_RULE}\n` }),
    "assets/Forest.scene.hasset": "F",
    "assets/Rock.texture.hasset": "R",
  }, "Seed");
  const storage = new MemoryStorageAdapter("documents");
  const folder = await storage.openDocumentsProject("Game");
  const port = await FakeSync.clone({ storage, remote, branch: "main" });
  const service = new SourceControlSyncService();
  const locks: SyncLocks = {
    theirs: async (): Promise<FileLock[]> => [],
    releaseOwn: async () => {},
    ...options.locks,
  };
  await service.configure({
    settings: { ...DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS, mode: "integrated", repositoryUrl: INTEGRATED_REPOSITORY, branch: "main" },
    folder,
    storage,
    platform: "web",
    testMode: true,
    lookup: INTEGRATED_LOOKUP,
    locks,
    factory: {
      open: async () => port,
      init: async () => port,
      author: async () => ({ name: "ada", email: "" }),
    },
  });
  return { service, remote, storage, port };
}
