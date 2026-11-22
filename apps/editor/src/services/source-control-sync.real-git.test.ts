import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS, type ProjectStorage, type SourceControlMode } from "@haptic/core";
import { GITATTRIBUTES_LFS_RULE, type SyncPort } from "@haptic/source-control";
import { cloneRepository, initRepository, openRepository } from "@haptic/source-control/git";
import { GitTestServer, REPOSITORY_URL } from "@haptic/source-control/git-test-server";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { testAsset } from "../testing/diff-assets";
import type { ChangeLookup } from "../lib/source-control-changes";
import { guardProjectStorage, ProjectWriteAdmission, withExclusiveWriter } from "./project-write-admission";
import { SourceControlSyncService, type SyncConfigureInput, type SyncPortFactory, type SyncPortRequest } from "./source-control-sync";

// Commit and Publish with the real Git core (isomorphic-git, Git LFS) under the
// project's write lock, against a real Git server (the system `git` over CGI,
// with an LFS batch API and object store). The storage is wired as the editor
// wires it: the Git core gets the port request's storage, which is the sync's
// view of the admission-guarded project storage, and the lock is the real
// `withExclusiveWriter` over the real `ProjectWriteAdmission`.

const AUTHOR = { name: "Device", email: "device@example.com" };
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const RULE = `${GITATTRIBUTES_LFS_RULE}\n`;
const lookup: ChangeLookup = () => null;

let server: GitTestServer;

/** A Git LFS pointer file, as the spec writes it. */
const pointer = (sha: string, size: number) => `version https://git-lfs.github.com/spec/v1\noid sha256:${sha}\nsize ${size}\n`;

beforeEach(async () => {
  server = await GitTestServer.start();
});

afterEach(async () => {
  await server.stop();
});

/** A Texture whose 70 KiB payload chunk is stored as a blob, with that blob's path. */
async function textureWithBlob(name: string, fill: number) {
  const stored = await testAsset("Texture", name, { chunks: [{ id: "payload", kind: "payload", mime: "application/octet-stream", data: new Uint8Array(70 * 1024).fill(fill) }] });
  const [sha, bytes] = [...stored.blobs][0]!;
  return { header: stored.bytes, sha, blob: bytes, blobPath: `assets/.blobs/${sha}` };
}

/**
 * The editor's storage for a project folder (`raw`, memory unless given):
 * the admission, the guarded storage owners write through, and the public
 * guarded storage the sync and saves get. `gitWrites` lists every write the
 * Git core makes while the lock holds the project's writes.
 */
async function editorProject(raw?: ProjectStorage) {
  const storage = raw ?? new MemoryStorageAdapter("documents");
  const folder = raw ? raw.getCurrentFolder()! : await storage.openDocumentsProject("Game");
  const admission = new ProjectWriteAdmission();
  const publicStorage = guardProjectStorage(guardProjectStorage(storage, admission, true), admission);
  const lockedWrites: string[] = [];
  const recording = new Proxy(storage, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (typeof value !== "function") return value;
      if (key !== "writeText" && key !== "writeBinary" && key !== "mkdir" && key !== "remove") return value.bind(target);
      return (...args: unknown[]) => {
        if (admission.locked) lockedWrites.push(`${String(key)} ${String(args[0])}`);
        return Reflect.apply(value, target, args);
      };
    },
  });
  return { storage, folder, admission, publicStorage, lockedWrites, recording };
}

type Project = Awaited<ReturnType<typeof editorProject>>;

/** The Git core as `syncPortFactory` builds it outside test mode, for the port request's storage. */
function realFactory(options: { files?: (storage: ProjectStorage) => ReturnType<GitTestServer["files"]>; ports?: SyncPort[] } = {}): SyncPortFactory {
  const core = (request: SyncPortRequest) => ({
    storage: request.storage,
    http: server.http,
    ...(options.files ? { files: options.files(request.storage) } : {}),
    credential: server.credential(),
    repositoryUrl: request.repositoryUrl,
    now: () => NOW,
  });
  return {
    open: async (request) => {
      const port = await openRepository(core(request));
      options.ports?.push(port);
      return port;
    },
    init: async (request) => {
      const port = await initRepository({ ...core(request), branch: request.branch, replace: request.replace });
      options.ports?.push(port);
      return port;
    },
    author: async () => AUTHOR,
    readAdoption: async () => true,
    setAdoption: async () => {},
  };
}

function syncInput(project: Project, mode: SourceControlMode, factory: SyncPortFactory): SyncConfigureInput {
  return {
    settings: { ...DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS, mode, repositoryUrl: REPOSITORY_URL, branch: "main", releaseLocksAfterPush: false },
    folder: project.folder,
    storage: project.publicStorage,
    // Not test mode: the desktop app's own working copy, which needs no adoption question here.
    platform: "ios",
    testMode: false,
    lookup,
    locks: { theirs: async () => [], releaseOwn: async () => {} },
    // The lock as ProjectService takes it; its storage records the writes the Git core makes past the barrier.
    exclusiveWrites: (reason, work, signal, options) => withExclusiveWriter(project.admission, project.recording, reason, work, signal, options),
    backgroundWritesIdle: async () => {},
    factory,
  };
}

/** The pushed branch as a teammate's clone with the system `git` sees it. */
function pushed(path: string): string {
  const teammate = server.teammate();
  return readFileSync(join(teammate.dir, path), "utf8");
}

describe("Commit and Publish with the real Git core under the project's write lock", { timeout: 60_000 }, () => {
  it("commits a file and an LFS asset with its blob while the lock holds; a save meanwhile waits and lands after", async () => {
    server.seed({ ".gitattributes": RULE, "project.json": "{}", "assets/Rock.texture.hasset": "R" });
    const project = await editorProject();
    // The working copy as Clone leaves it.
    await cloneRepository({ storage: project.storage, http: server.http, credential: server.credential(), repositoryUrl: REPOSITORY_URL, branch: "main", now: () => NOW });
    const ports: SyncPort[] = [];
    const sync = new SourceControlSyncService();
    await sync.configure(syncInput(project, "integrated", realFactory({ ports })));
    expect(sync.getSnapshot()).toMatchObject({ active: true, branch: "main", problem: null });

    const rock = await textureWithBlob("Rock", 5);
    await project.publicStorage.writeText("project.json", "{\"edited\":true}");
    await project.publicStorage.writeBinary(rock.blobPath, rock.blob);
    await project.publicStorage.writeBinary("assets/Rock.texture.hasset", rock.header);

    // A save arriving while the commit holds the lock, through the storage saves use.
    let saveLanded = false;
    let saving: Promise<void> | null = null;
    const commit = ports[0]!.commit.bind(ports[0]!);
    vi.spyOn(ports[0]!, "commit").mockImplementation(async (input) => {
      expect(project.admission.locked).toBe(true);
      saving = project.publicStorage.writeText("assets/Late.hasset", "L").then(() => { saveLanded = true; });
      const result = await commit(input);
      // The commit is recorded and the save has still not landed: nothing came between the status and the commit.
      expect(saveLanded).toBe(false);
      expect(await project.storage.exists("assets/Late.hasset")).toBe(false);
      return result;
    });

    expect(await sync.commit({ rowIds: new Set(["project.json", "assets/Rock.texture.hasset"]), message: "Rock and settings", push: true })).toBe(true);
    expect(sync.getSnapshot().problem).toBeNull();
    // Every Git write under the lock succeeded: the index, objects and the branch ref among them.
    expect(project.lockedWrites.some((write) => write.includes(".git/objects/"))).toBe(true);
    expect(project.lockedWrites.some((write) => write.endsWith(".git/index"))).toBe(true);
    expect(project.lockedWrites.some((write) => write.endsWith(".git/refs/heads/main"))).toBe(true);
    expect(project.lockedWrites.every((write) => write.includes(" .git/") || write.includes(" .git"))).toBe(true);

    // The save ran after the commit, as a later change.
    await saving;
    expect(saveLanded).toBe(true);
    await sync.refreshStatus();
    expect(sync.getSnapshot().rows.map((row) => row.id)).toEqual(["assets/Late.hasset"]);

    // The pushed commit is complete: the file, the asset and its blob as an LFS pointer whose object is in the store.
    expect(pushed("project.json")).toBe("{\"edited\":true}");
    expect(pushed(rock.blobPath)).toBe(pointer(rock.sha, rock.blob.byteLength));
    expect(server.objects.get(rock.sha)).toEqual(rock.blob);
    expect(new Uint8Array(readFileSync(join(server.teammate().dir, "assets/Rock.texture.hasset")))).toEqual(rock.header);
  });

  it("publishes: the first commit succeeds while the lock holds, and the push sends every file and LFS object", async () => {
    const project = await editorProject();
    const crate = await textureWithBlob("Crate", 9);
    await project.publicStorage.writeText(".gitattributes", RULE);
    await project.publicStorage.writeText("project.json", "{}");
    await project.publicStorage.writeBinary(crate.blobPath, crate.blob);
    await project.publicStorage.writeBinary("assets/Crate.texture.hasset", crate.header);
    const sync = new SourceControlSyncService();
    const factory = realFactory();
    await sync.configure(syncInput(project, "off", factory));
    await sync.publish({
      input: syncInput(project, "off", factory),
      repositoryUrl: REPOSITORY_URL,
      branch: "main",
      replace: false,
      beforeCommit: async () => {
        // As Publish saves Integrated mode, admitted like any save.
        await project.publicStorage.writeText("project.json", "{\"mode\":\"integrated\"}");
        await sync.configure(syncInput(project, "integrated", factory));
      },
    });
    expect(sync.getSnapshot()).toMatchObject({ active: true, ahead: 0, behind: 0, rows: [], problem: null });
    expect(project.lockedWrites.some((write) => write.endsWith(".git/refs/heads/main"))).toBe(true);
    expect(project.admission.blocked).toBe(false);
    expect(pushed("project.json")).toBe("{\"mode\":\"integrated\"}");
    expect(pushed(crate.blobPath)).toBe(pointer(crate.sha, crate.blob.byteLength));
    expect(server.objects.get(crate.sha)).toEqual(crate.blob);
  });

  it("publishes from a desktop folder, its LFS upload streamed by the native file transfer, which the lock never guards", async () => {
    const disk = await server.storage();
    const project = await editorProject(disk);
    const crate = await textureWithBlob("Crate", 3);
    await project.publicStorage.writeText(".gitattributes", RULE);
    await project.publicStorage.writeText("project.json", "{}");
    await project.publicStorage.writeBinary(crate.blobPath, crate.blob);
    await project.publicStorage.writeBinary("assets/Crate.texture.hasset", crate.header);
    const transfers: string[] = [];
    const factory = realFactory({
      files: (storage) => {
        const native = server.files(storage);
        return async (request) => {
          transfers.push(`${request.method} ${request.path}`);
          return native(request);
        };
      },
    });
    const sync = new SourceControlSyncService();
    await sync.configure(syncInput(project, "off", factory));
    await sync.publish({ input: syncInput(project, "off", factory), repositoryUrl: REPOSITORY_URL, branch: "main", replace: false, beforeCommit: async () => {} });
    expect(sync.getSnapshot()).toMatchObject({ rows: [], ahead: 0, problem: null });
    expect(transfers).toEqual([`PUT ${crate.blobPath}`]);
    expect(server.objects.get(crate.sha)).toEqual(crate.blob);
    expect(new Uint8Array(readFileSync(join(server.teammate().dir, "assets/Crate.texture.hasset")))).toEqual(crate.header);
  });
});
