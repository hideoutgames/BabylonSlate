import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS, type SourceControlMode } from "@haptic/core";
import { GITATTRIBUTES_LFS_RULE, type FileLock, type SyncPort } from "@haptic/source-control";
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
      await expect(service.publish({ input: input("off"), repositoryUrl: URL, branch: "main", beforeCommit: async () => {} }))
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
