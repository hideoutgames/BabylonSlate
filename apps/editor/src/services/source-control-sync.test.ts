import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS, type SourceControlMode } from "@haptic/core";
import { GITATTRIBUTES_LFS_RULE, SyncError, type FileLock, type SyncPort } from "@haptic/source-control";
import { FakeRemote, FakeSync } from "@haptic/source-control/fake-sync";
import { MemoryStorageAdapter } from "@haptic/vfs";
import type { ChangeLookup } from "../lib/source-control-changes";
import { SourceControlSyncService, STATUS_DEBOUNCE_MS, type SyncConfigureInput, type SyncPortFactory } from "./source-control-sync";

const URL = "https://github.com/team/game.git";
const AUTHOR = { name: "ada", email: "" };
const BLOB = "a".repeat(64);
const BLOB_PATH = `assets/.blobs/${BLOB}`;
const lookup: ChangeLookup = (path) =>
  path === "assets/Forest.scene.hasset" ? { name: "Forest", type: "Scene", blobPaths: [BLOB_PATH] }
    : path === "assets/Rock.texture.hasset" ? { name: "Rock", type: "Texture", blobPaths: [] }
      : null;

function lock(path: string, ownerName: string, ours: boolean): FileLock {
  return { id: `${path}-lock`, path, ownerName, lockedAt: "", ours };
}

async function setup(options: { platform?: string; testMode?: boolean; files?: Record<string, string> } = {}) {
  const remote = new FakeRemote();
  remote.commit(options.files ?? { ".gitattributes": `${GITATTRIBUTES_LFS_RULE}\n`, "assets/Forest.scene.hasset": "F", "assets/Rock.texture.hasset": "R" }, "Seed");
  const storage = new MemoryStorageAdapter("documents");
  const folder = await storage.openDocumentsProject("Game");
  const port = await FakeSync.clone({ storage, remote, branch: "main" });
  const spied = {
    push: vi.spyOn(port, "push"),
    status: vi.spyOn(port, "status"),
    commit: vi.spyOn(port, "commit"),
  };
  const factory: SyncPortFactory = {
    open: vi.fn(async (): Promise<SyncPort> => port),
    init: vi.fn(async (): Promise<SyncPort> => port),
    author: async () => AUTHOR,
  };
  const locks = {
    theirs: vi.fn<(paths: readonly string[]) => Promise<FileLock[]>>(async () => []),
    releaseOwn: vi.fn<(paths: readonly string[]) => Promise<void>>(async () => {}),
  };
  const input = (mode: SourceControlMode, releaseLocksAfterPush = true): SyncConfigureInput => ({
    settings: { ...DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS, mode, repositoryUrl: URL, branch: "main", releaseLocksAfterPush },
    folder,
    storage,
    platform: options.platform ?? "web",
    testMode: options.testMode ?? true,
    lookup,
    locks,
    factory,
  });
  const service = new SourceControlSyncService();
  return { remote, storage, port, spied, factory, locks, input, service };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SourceControlSyncService", () => {
  it.each(["off", "manual"] as const)("opens no Git client in %s mode", async (mode) => {
    const { service, factory, input } = await setup();
    const listener = vi.fn();
    service.subscribe(listener);
    await service.configure(input(mode));
    service.noteSaved();
    expect(factory.open).not.toHaveBeenCalled();
    expect(service.statusPending).toBe(false);
    expect(service.getSnapshot().active).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("opens the folder's client once per repository and branch, then reads changes and what the remote has", async () => {
    const { service, factory, input, storage, remote } = await setup();
    remote.commit({ "assets/Rock.texture.hasset": "R2" }, "Brighter rock");
    await storage.writeText("assets/Forest.scene.hasset", "F2");
    await service.configure(input("integrated"));
    await service.configure(input("integrated"));
    expect(factory.open).toHaveBeenCalledTimes(1);
    const snapshot = service.getSnapshot();
    expect(snapshot).toMatchObject({ active: true, branch: "main", ahead: 0, behind: 1 });
    expect(snapshot.rows.map((row) => [row.name, row.kind])).toEqual([["Forest", "modified"]]);
    expect(snapshot.incoming.map((commit) => commit.message)).toEqual(["Brighter rock"]);
    expect(snapshot.lastFetchAt).not.toBeNull();
    // Off again drops the client; nothing stays scheduled.
    await service.configure(input("off"));
    expect(service.getSnapshot().active).toBe(false);
  });

  it("refuses to run the Git client in a folder without .git on a device", async () => {
    const { service, factory, input } = await setup({ platform: "ios", testMode: false });
    await service.configure(input("integrated"));
    expect(factory.open).not.toHaveBeenCalled();
    expect(service.getSnapshot()).toMatchObject({ active: false, blocked: "no-repository" });
  });

  it("reads status once after a burst of saves, and never schedules anything while idle", async () => {
    const { service, input, spied, storage } = await setup();
    await service.configure(input("integrated"));
    vi.useFakeTimers();
    spied.status.mockClear();
    expect(vi.getTimerCount()).toBe(0);
    await storage.writeText("assets/Rock.texture.hasset", "R2");
    service.noteSaved();
    service.noteSaved();
    service.noteSaved();
    await vi.advanceTimersByTimeAsync(STATUS_DEBOUNCE_MS - 1);
    expect(spied.status).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(service.getSnapshot().rows.map((row) => row.name)).toEqual(["Rock"]));
    expect(spied.status).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(service.statusPending).toBe(false);
  });

  it("commits the chosen asset with its blob and pushes after", async () => {
    const { service, input, storage, remote } = await setup();
    await service.configure(input("integrated"));
    await storage.writeText("assets/Forest.scene.hasset", "F2");
    await storage.writeBinary(BLOB_PATH, new Uint8Array([1, 2, 3]));
    await storage.writeText("assets/Rock.texture.hasset", "R2");
    await service.refreshStatus();
    expect(service.getSnapshot().rows.map((row) => row.name)).toEqual(["Forest", "Rock"]);
    expect(await service.commit({ rowIds: new Set(["assets/Forest.scene.hasset"]), message: "Forest", push: true })).toBe(true);
    const head = remote.branches.get("main")!;
    const files = [...remote.get(head).files.keys()].sort();
    expect(files).toContain(BLOB_PATH);
    expect(new TextDecoder().decode(remote.get(head).files.get("assets/Rock.texture.hasset"))).toBe("R");
    expect(service.getSnapshot()).toMatchObject({ ahead: 0, behind: 0, problem: null });
    expect(service.getSnapshot().rows.map((row) => row.name)).toEqual(["Rock"]);
  });

  it("refuses a push that would send an asset someone else locks, naming the holder", async () => {
    const { service, input, storage, locks, spied } = await setup();
    await service.configure(input("integrated"));
    await storage.writeText("assets/Rock.texture.hasset", "R2");
    locks.theirs.mockImplementation(async (paths) => paths.includes("assets/Rock.texture.hasset") ? [lock("assets/Rock.texture.hasset", "Sam", false)] : []);
    await service.commit({ rowIds: new Set(["assets/Rock.texture.hasset"]), message: "Rock", push: true });
    expect(locks.theirs).toHaveBeenCalledWith(["assets/Rock.texture.hasset"]);
    expect(spied.push).not.toHaveBeenCalled();
    expect(service.getSnapshot().problem).toMatchObject({ title: "Could Not Push", holders: [{ ownerName: "Sam" }] });
    expect(service.getSnapshot().problem?.message).toContain("Sam");
    expect(service.getSnapshot().ahead).toBe(1);
  });

  it.each([
    [true, [[["assets/Rock.texture.hasset"]]]],
    [false, []],
  ])("with Release Locks After Push %s, releases the pushed assets that have no further change", async (release, calls) => {
    const { service, input, storage, locks } = await setup();
    await service.configure(input("integrated", release));
    await storage.writeText("assets/Rock.texture.hasset", "R2");
    await storage.writeText("assets/Forest.scene.hasset", "F2");
    await service.refreshStatus();
    await service.commit({ rowIds: new Set(["assets/Rock.texture.hasset", "assets/Forest.scene.hasset"]), message: "Both", push: false });
    // Forest changes again before the push, so its lock stays.
    await storage.writeText("assets/Forest.scene.hasset", "F3");
    await service.push();
    expect(locks.releaseOwn.mock.calls).toEqual(calls);
  });

  it("returns conflicts without changing anything, then applies the choices", async () => {
    const { service, input, storage, remote } = await setup();
    await service.configure(input("integrated"));
    remote.commit({ "assets/Rock.texture.hasset": "R-theirs", "assets/New.hasset": "N" }, "Teammate");
    await storage.writeText("assets/Rock.texture.hasset", "R-mine");
    const conflicts = await service.pull();
    expect(conflicts).toEqual({ kind: "conflicts", conflicts: [{ path: "assets/Rock.texture.hasset", mine: "modified", theirs: "modified" }] });
    expect(await storage.exists("assets/New.hasset")).toBe(false);
    const applied = await service.pull({ "assets/Rock.texture.hasset": "theirs" });
    expect(applied).toMatchObject({ kind: "fast-forward", changedPaths: ["assets/New.hasset", "assets/Rock.texture.hasset"] });
    expect(await storage.readText("assets/Rock.texture.hasset")).toBe("R-theirs");
    expect(service.getSnapshot()).toMatchObject({ behind: 0, rows: [] });
  });

  describe("a project that closes while an operation runs", () => {
    /** Projects A and B, each with its own remote, in folders of one storage that is bound to one folder at a time. */
    async function twoProjects() {
      const storage = new MemoryStorageAdapter("documents");
      const remotes = new Map<string, FakeRemote>();
      const project = async (name: string) => {
        const url = `https://github.com/team/${name}.git`;
        const remote = new FakeRemote();
        remote.commit({ ".gitattributes": `${GITATTRIBUTES_LFS_RULE}\n`, "assets/Rock.texture.hasset": `${name} rock` }, "Seed");
        remotes.set(url, remote);
        const folder = await storage.openDocumentsProject(name);
        await FakeSync.clone({ storage, remote, branch: "main" });
        return { url, remote, folder };
      };
      const a = await project("A");
      const b = await project("B");
      let releaseAuthor!: () => void;
      const authorHeld = new Promise<void>((resolve) => { releaseAuthor = resolve; });
      const factory: SyncPortFactory = {
        // As the editor's factory: the port works on the storage the service hands it.
        open: vi.fn(async (request): Promise<SyncPort> => new FakeSync({ storage: request.storage, remote: remotes.get(request.repositoryUrl)!, branch: "main" })),
        init: vi.fn(async (): Promise<SyncPort> => { throw new Error("Not published here."); }),
        // The first author (A's commit) waits for the test.
        author: vi.fn<SyncPortFactory["author"]>().mockImplementationOnce(async () => {
          await authorHeld;
          return AUTHOR;
        }).mockResolvedValue(AUTHOR),
      };
      const locks = {
        theirs: vi.fn<(paths: readonly string[]) => Promise<FileLock[]>>(async () => []),
        releaseOwn: vi.fn<(paths: readonly string[]) => Promise<void>>(async () => {}),
      };
      const input = (target: { url: string; folder: SyncConfigureInput["folder"] }): SyncConfigureInput => ({
        settings: { ...DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS, mode: "integrated", repositoryUrl: target.url, branch: "main" },
        folder: target.folder,
        storage,
        platform: "web",
        testMode: true,
        lookup,
        locks,
        factory,
      });
      return { storage, a, b, input, locks, factory, releaseAuthor };
    }

    it("never pushes, reports or releases locks for the next project, nor touches its folder", async () => {
      const { storage, a, b, input, locks, factory, releaseAuthor } = await twoProjects();
      const service = new SourceControlSyncService();
      await storage.openKnownFolder(a.folder!);
      await service.configure(input(a));
      await storage.writeText("assets/Rock.texture.hasset", "A rock edited");
      await service.refreshStatus();
      const aHead = a.remote.branches.get("main");
      const committing = service.commit({ rowIds: new Set(["assets/Rock.texture.hasset"]), message: "A", push: true });
      await vi.waitFor(() => expect(factory.author).toHaveBeenCalled());
      // Close A and open B while A's commit runs (without waiting for it to settle).
      service.stop();
      await storage.openKnownFolder(b.folder!);
      const configuring = service.configure(input(b));
      await vi.waitFor(() => expect(service.getSnapshot().active).toBe(true));
      await storage.writeText("assets/Forest.scene.hasset", "B forest");
      const bCommit = service.commit({ rowIds: new Set(["assets/Forest.scene.hasset"]), message: "B", push: false });
      releaseAuthor();
      await committing;
      await configuring;
      await bCommit;
      await service.settled();
      expect(a.remote.branches.get("main")).toBe(aHead);
      // B's commit stays local: nothing pushed it, and no lock was released for it.
      expect(b.remote.get(b.remote.branches.get("main")!).message).toBe("Seed");
      expect(locks.releaseOwn).not.toHaveBeenCalled();
      expect(await storage.readText("assets/Rock.texture.hasset")).toBe("B rock");
      expect(service.getSnapshot()).toMatchObject({ ahead: 1, rows: [], problem: null });
    });

    it("cancels the running transfer on stop, and settles once it has ended", async () => {
      const { service, input, storage, spied } = await setup();
      await service.configure(input("integrated"));
      await storage.writeText("assets/Rock.texture.hasset", "R2");
      await service.commit({ rowIds: new Set(["assets/Rock.texture.hasset"]), message: "Rock", push: false });
      let ended = false;
      spied.push.mockImplementationOnce((options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          ended = true;
          reject(new SyncError("cancelled", "Cancelled."));
        });
      }));
      const pushing = service.push();
      await vi.waitFor(() => expect(spied.push).toHaveBeenCalled());
      service.stop();
      await service.settled();
      expect(ended).toBe(true);
      await pushing;
      expect(service.getSnapshot()).toMatchObject({ active: false, problem: null });
    });
  });

  it("re-renders no snapshot reader for transfer bytes, and publishes the byte count at most every interval", async () => {
    const { service, input, storage, spied, factory } = await setup();
    await service.configure(input("integrated"));
    const { transfer } = vi.mocked(factory.open).mock.calls[0]![0];
    await storage.writeText("assets/Rock.texture.hasset", "R2");
    await service.commit({ rowIds: new Set(["assets/Rock.texture.hasset"]), message: "Rock", push: false });
    let finishPush!: () => void;
    spied.push.mockImplementationOnce(() => new Promise((resolve) => {
      finishPush = () => resolve({ head: "", uploaded: 0 });
    }));
    const pushing = service.push();
    await vi.waitFor(() => expect(spied.push).toHaveBeenCalled());
    vi.useFakeTimers();
    const snapshotReader = vi.fn();
    service.subscribe(snapshotReader);
    // An LFS push of 500 objects: a PUT and a verify each.
    for (let request = 0; request < 1000; request += 1) transfer.bytes(10);
    expect(snapshotReader).not.toHaveBeenCalled();
    const byteReader = vi.fn();
    service.transfer.subscribe(byteReader);
    expect(service.transfer.getSnapshot()).toBe(0);
    vi.advanceTimersByTime(99);
    expect(byteReader).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(byteReader).toHaveBeenCalledTimes(1);
    expect(service.transfer.getSnapshot()).toBe(10_000);
    vi.useRealTimers();
    finishPush();
    await pushing;
  });

  describe("after a push or pull", () => {
    it("keeps a push that succeeded as pushed when the check for changes after it fails", async () => {
      const { service, input, storage, locks, port } = await setup();
      await service.configure(input("integrated"));
      await storage.writeText("assets/Rock.texture.hasset", "R2");
      await service.commit({ rowIds: new Set(["assets/Rock.texture.hasset"]), message: "Rock", push: false });
      vi.spyOn(port, "fetch").mockRejectedValue(new SyncError("network", "The host could not be reached."));
      await service.push();
      expect(service.getSnapshot()).toMatchObject({ ahead: 0, problem: { title: "Could Not Check For Changes" } });
      expect(locks.releaseOwn).toHaveBeenCalledWith(["assets/Rock.texture.hasset"]);
    });

    it("reports a pull that wrote its files as done, without asking the remote again", async () => {
      const { service, input, storage, remote, port } = await setup();
      await service.configure(input("integrated"));
      remote.commit({ "assets/Rock.texture.hasset": "R-theirs" }, "Teammate");
      const fetch = vi.spyOn(port, "fetch").mockRejectedValue(new SyncError("network", "The host could not be reached."));
      expect(await service.pull()).toMatchObject({ kind: "fast-forward" });
      expect(await storage.readText("assets/Rock.texture.hasset")).toBe("R-theirs");
      expect(fetch).not.toHaveBeenCalled();
      expect(service.getSnapshot()).toMatchObject({ behind: 0, problem: null });
    });
  });

  describe("problems", () => {
    it("clears Could Not Read Changes once a status succeeds", async () => {
      const { service, input, spied } = await setup();
      await service.configure(input("integrated"));
      spied.status.mockRejectedValueOnce(new Error("The folder could not be listed."));
      await service.refreshStatus();
      expect(service.getSnapshot().problem).toMatchObject({ title: "Could Not Read Changes" });
      await service.refreshStatus();
      expect(service.getSnapshot().problem).toBeNull();
    });

    it("keeps a refused push's problem through later checks for changes", async () => {
      const { service, input, storage, locks } = await setup();
      await service.configure(input("integrated"));
      await storage.writeText("assets/Rock.texture.hasset", "R2");
      locks.theirs.mockResolvedValue([lock("assets/Rock.texture.hasset", "Sam", false)]);
      await service.commit({ rowIds: new Set(["assets/Rock.texture.hasset"]), message: "Rock", push: true });
      await service.fetch();
      await service.refreshStatus();
      expect(service.getSnapshot().problem).toMatchObject({ title: "Could Not Push", holders: [{ ownerName: "Sam" }] });
    });

    it("opens the repository again on Refresh after it could not open", async () => {
      const { service, input, factory } = await setup();
      vi.mocked(factory.open).mockRejectedValueOnce(new Error("The repository could not be read."));
      await service.configure(input("integrated"));
      expect(service.getSnapshot().problem).toMatchObject({ title: "Could Not Open The Repository" });
      await service.refresh();
      expect(factory.open).toHaveBeenCalledTimes(2);
      expect(service.getSnapshot()).toMatchObject({ active: true, problem: null, statusReady: true });
    });
  });

  describe("Publish", () => {
    async function unpublished() {
      const remote = new FakeRemote();
      const storage = new MemoryStorageAdapter("documents");
      const folder = await storage.openDocumentsProject("Game");
      await storage.writeText("project.json", "{}");
      await storage.writeText("assets/Forest.scene.hasset", "F");
      const factory: SyncPortFactory = {
        open: vi.fn(async (): Promise<SyncPort> => { throw new Error("A published folder opens the client Publish started."); }),
        init: vi.fn(async (): Promise<SyncPort> => FakeSync.init({ storage, remote, branch: "main" })),
        author: async () => AUTHOR,
      };
      const input = (mode: SourceControlMode): SyncConfigureInput => ({
        settings: { ...DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS, mode, repositoryUrl: URL, branch: "main" },
        folder,
        storage,
        platform: "web",
        testMode: true,
        lookup,
        locks: { theirs: async () => [], releaseOwn: async () => {} },
        factory,
      });
      return { remote, storage, factory, input };
    }

    it("starts the working copy, keeps it through the switch to Integrated, and pushes every file", async () => {
      const { remote, storage, factory, input } = await unpublished();
      const service = new SourceControlSyncService();
      await service.configure(input("off"));
      await service.publish({
        input: input("off"),
        repositoryUrl: URL,
        branch: "main",
        replace: false,
        beforeCommit: async () => {
          // As Publish saves Integrated mode, and the settings effect then configures.
          await storage.writeText("project.json", "{\"mode\":\"integrated\"}");
          await service.configure(input("integrated"));
        },
      });
      expect(factory.init).toHaveBeenCalledTimes(1);
      expect(factory.open).not.toHaveBeenCalled();
      const head = remote.get(remote.branches.get("main")!);
      expect(new TextDecoder().decode(head.files.get("project.json"))).toBe("{\"mode\":\"integrated\"}");
      expect(head.files.has("assets/Forest.scene.hasset")).toBe(true);
      expect(service.getSnapshot()).toMatchObject({ active: true, ahead: 0, behind: 0, rows: [], problem: null });
    });

    it("stays idle and rethrows when the working copy cannot start", async () => {
      const { factory, input } = await unpublished();
      vi.mocked(factory.init).mockRejectedValueOnce(new Error("This folder already has a Git repository."));
      const service = new SourceControlSyncService();
      await expect(service.publish({ input: input("off"), repositoryUrl: URL, branch: "main", replace: false, beforeCommit: async () => {} }))
        .rejects.toThrow("This folder already has a Git repository.");
      expect(service.getSnapshot()).toMatchObject({ active: false, problem: null });
      // The next configure starts afresh.
      await service.configure(input("off"));
      expect(factory.open).not.toHaveBeenCalled();
    });
  });

  it("offers the Git LFS rule where a commit of blobs is refused, and commits only .gitattributes for it", async () => {
    const { service, input, storage, remote } = await setup({ files: { "assets/Forest.scene.hasset": "F" } });
    await service.configure(input("integrated"));
    await storage.writeText("assets/Forest.scene.hasset", "F2");
    await storage.writeBinary(BLOB_PATH, new Uint8Array([1]));
    await service.refreshStatus();
    expect(await service.commit({ rowIds: new Set(["assets/Forest.scene.hasset"]), message: "Forest", push: false })).toBe(false);
    expect(service.getSnapshot().problem).toMatchObject({ code: "missing-lfs-rule" });
    await service.addLfsRule();
    expect(await storage.readText(".gitattributes")).toBe(`${GITATTRIBUTES_LFS_RULE}\n`);
    expect(service.getSnapshot().rows.map((row) => row.name)).toEqual(["Forest"]);
    expect(await service.commit({ rowIds: new Set(["assets/Forest.scene.hasset"]), message: "Forest", push: true })).toBe(true);
    expect(remote.get(remote.branches.get("main")!).files.has(BLOB_PATH)).toBe(true);
  });
});
