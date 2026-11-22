import { DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS, type ProjectStorage, type StorageTier } from "@haptic/core";
import { GITATTRIBUTES_LFS_RULE, type FileLock } from "@haptic/source-control";
import { FakeRemote, FakeSync } from "@haptic/source-control/fake-sync";
import { MemoryStorageAdapter } from "@haptic/vfs";
import type { ChangeLookup } from "../lib/source-control-changes";
import { SourceControlSyncService, type SyncConfigureInput, type SyncLocks, type SyncPortFactory } from "../services/source-control-sync";

export const INTEGRATED_REPOSITORY = "https://github.com/team/game.git";

/** A branch's committed `project.json` with these source control settings (Integrated with `INTEGRATED_REPOSITORY` by default). */
export function projectJsonWith(sourceControl: { mode: string; repositoryUrl: string } = { mode: "integrated", repositoryUrl: INTEGRATED_REPOSITORY }): string {
  return JSON.stringify({ settings: { sourceControl: { ...sourceControl, branch: "main" } } });
}

/**
 * A complete `project.json` the editor can open: Integrated with
 * `INTEGRATED_REPOSITORY` unless `settings.sourceControl` says otherwise,
 * with `settings` and `metadata` merged in.
 */
export function integratedProjectJson(settings: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}): string {
  return JSON.stringify({
    guid: "project-guid",
    kind: "project",
    version: 1,
    metadata: { name: "Game", version: "1.0.0", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...metadata },
    settings: { sourceControl: { mode: "integrated", repositoryUrl: INTEGRATED_REPOSITORY, branch: "main" }, ...settings },
    scenes: [],
    graphs: [],
  }, null, 2);
}

/** Forest (a Scene) and Rock (a Texture), as the registry would describe them. */
export const INTEGRATED_LOOKUP: ChangeLookup = (path) =>
  path === "assets/Forest.scene.hasset" ? { name: "Forest", type: "Scene", blobPaths: [] }
    : path === "assets/Rock.texture.hasset" ? { name: "Rock", type: "Texture", blobPaths: [] }
      : null;

/** `ProjectService.withExclusiveWrites` as tests see it: `storage` is the project folder's; `signal` ends the wait for other writers. */
export type TestExclusiveWrites = <T>(reason: string, work: (storage: ProjectStorage) => Promise<T>, storage: ProjectStorage, signal: AbortSignal) => Promise<T>;

/**
 * A real `SourceControlSyncService` in Integrated mode over `FakeSync`: a
 * working copy in memory storage of a `FakeRemote` seeded with Forest and
 * Rock (`files` adds, replaces or, with null, leaves out seed files), so
 * editor tests drive the same service the editor runs. The project's only
 * writer is the test itself unless `exclusiveWrites` says otherwise.
 */
export async function integratedSync(options: {
  locks?: Partial<SyncLocks>;
  lfsRule?: boolean;
  files?: Record<string, string | Uint8Array | null>;
  lookup?: ChangeLookup;
  exclusiveWrites?: TestExclusiveWrites;
} = {}) {
  const remote = new FakeRemote();
  remote.commit({
    ...(options.lfsRule === false ? {} : { ".gitattributes": `${GITATTRIBUTES_LFS_RULE}\n` }),
    "assets/Forest.scene.hasset": "F",
    "assets/Rock.texture.hasset": "R",
    ...options.files,
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
    lookup: options.lookup ?? INTEGRATED_LOOKUP,
    locks,
    exclusiveWrites: (reason, work, signal) => (options.exclusiveWrites ?? ((_reason, own, project) => own(project)))(reason, work, storage, signal),
    factory: {
      open: async () => port,
      init: async () => port,
      author: async () => ({ name: "ada", email: "" }),
      readAdoption: async () => {
        throw new Error("Test mode reads no adoption.");
      },
      setAdoption: async () => {},
    },
  });
  return { service, remote, storage, port };
}

/**
 * A real `SourceControlSyncService` for an Integrated project in a device's
 * working copy (`.git`, not test mode; desktop app storage unless `platform`
 * and `tier` say otherwise) over `FakeSync`, with its adoption answer in
 * memory: `adoption.adopted` is what the working copy's Git config holds.
 * `setAdoption` is the editor's action, bound to the project.
 */
export async function deviceIntegratedSync(options: { adopted: boolean; platform?: string; tier?: StorageTier }) {
  const remote = new FakeRemote();
  remote.commit({ ".gitattributes": `${GITATTRIBUTES_LFS_RULE}\n`, "assets/Forest.scene.hasset": "F" }, "Seed");
  const storage = new MemoryStorageAdapter("documents");
  const folder = await storage.openKnownFolder({ id: "device:Game", name: "Game", tier: options.tier ?? "documents" });
  const port = await FakeSync.clone({ storage, remote, branch: "main" });
  await storage.writeText(".git/HEAD", "ref: refs/heads/main\n");
  const adoption = { adopted: options.adopted };
  const service = new SourceControlSyncService();
  const factory: SyncPortFactory = {
    open: async () => port,
    init: async () => port,
    author: async () => ({ name: "ada", email: "" }),
    readAdoption: async () => adoption.adopted,
    setAdoption: async (_storage, adopted) => {
      adoption.adopted = adopted;
    },
  };
  const input: SyncConfigureInput = {
    settings: { ...DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS, mode: "integrated", repositoryUrl: INTEGRATED_REPOSITORY, branch: "main" },
    folder,
    storage,
    platform: options.platform ?? "electron",
    testMode: false,
    lookup: INTEGRATED_LOOKUP,
    locks: { theirs: async () => [], releaseOwn: async () => {} },
    exclusiveWrites: (_reason, work) => work(storage),
    factory,
  };
  await service.configure(input);
  return { service, adoption, factory, setAdoption: (adopted: boolean) => service.setAdopted(input, adopted) };
}
