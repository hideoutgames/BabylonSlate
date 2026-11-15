import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS, type SourceControlMode } from "@haptic/core";
import { GITATTRIBUTES_LFS_RULE, SyncError, type FileLock, type SyncPort } from "@haptic/source-control";
import { FakeRemote, FakeSync } from "@haptic/source-control/fake-sync";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { setEditorQuiet } from "../lib/editor-quiet";
import type { ChangeLookup } from "../lib/source-control-changes";
import { testAsset } from "../testing/diff-assets";
import { projectJsonWith } from "../testing/integrated-sync";
import { SourceControlSyncService, STATUS_DEBOUNCE_MS, type SyncConfigureInput, type SyncPortFactory } from "./source-control-sync";

const URL = "https://github.com/team/game.git";
const AUTHOR = { name: "ada", email: "" };
const BLOB = "a".repeat(64);
const BLOB_PATH = `assets/.blobs/${BLOB}`;
const lookup: ChangeLookup = (path) =>
  path === "assets/Forest.scene.hasset" ? { name: "Forest", type: "Scene", blobPaths: [BLOB_PATH] }
    : path === "assets/Rock.texture.hasset" ? { name: "Rock", type: "Texture", blobPaths: [] }
      : null;

/** Test mode never asks before running Git (no `.git`). */
const NOT_ASKED: Pick<SyncPortFactory, "readAdoption" | "setAdoption"> = {
  readAdoption: async () => {
    throw new Error("Test mode reads no adoption.");
  },
  setAdoption: async () => {},
};

function lock(path: string, ownerName: string, ours: boolean): FileLock {
  return { id: `${path}-lock`, path, ownerName, lockedAt: "", ours };
}

/** What every working copy here starts from, unless a test seeds its own. */
const SEED = { ".gitattributes": `${GITATTRIBUTES_LFS_RULE}\n`, "assets/Forest.scene.hasset": "F", "assets/Rock.texture.hasset": "R" };

async function setup(options: { platform?: string; testMode?: boolean; files?: Record<string, string> } = {}) {
  const remote = new FakeRemote();
  remote.commit(options.files ?? SEED, "Seed");
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
    readAdoption: vi.fn(async () => false),
    setAdoption: vi.fn(async () => {}),
  };
  const locks = {
    theirs: vi.fn<(paths: readonly string[], branch: string) => Promise<FileLock[]>>(async () => []),
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
    expect(factory.readAdoption).not.toHaveBeenCalled();
    expect(service.statusPending).toBe(false);
    expect(service.getSnapshot().active).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("opens the folder's client once per repository, then reads changes and what the remote has", async () => {
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

  describe("asking once per desktop working copy", () => {
    /** A working copy with `.git` on `platform`; `answer` is what its Git config holds. */
    async function withGit(platform: string, adopted: boolean) {
      const context = await setup({ platform, testMode: false });
      await context.storage.writeText(".git/HEAD", "ref: refs/heads/main\n");
      const answer = { adopted };
      vi.mocked(context.factory.readAdoption).mockImplementation(async () => answer.adopted);
      vi.mocked(context.factory.setAdoption).mockImplementation(async (_storage, value) => {
        answer.adopted = value;
      });
      return { ...context, answer };
    }

    it("runs no Git client in a desktop folder this device never adopted, until its user accepts", async () => {
      const { service, factory, input, answer } = await withGit("electron", false);
      await service.configure(input("integrated"));
      expect(factory.open).not.toHaveBeenCalled();
      expect(service.getSnapshot()).toMatchObject({ active: false, blocked: "not-adopted" });
      // The settings effect configures again: still blocked, and nothing is written without an answer.
      await service.configure(input("integrated"));
      expect(factory.setAdoption).not.toHaveBeenCalled();

      await service.setAdopted(input("integrated"), true);
      expect(answer.adopted).toBe(true);
      expect(factory.open).toHaveBeenCalledTimes(1);
      expect(service.getSnapshot()).toMatchObject({ active: true, blocked: null, statusReady: true });
    });

    it("opens a desktop folder it adopted, and Stop Using closes the client and asks again", async () => {
      const { service, factory, input, answer, spied } = await withGit("electron", true);
      await service.configure(input("integrated"));
      expect(service.getSnapshot()).toMatchObject({ active: true, blocked: null });
      await service.setAdopted(input("integrated"), false);
      expect(answer.adopted).toBe(false);
      expect(service.getSnapshot()).toMatchObject({ active: false, blocked: "not-adopted" });
      spied.status.mockClear();
      await service.refreshStatus();
      expect(spied.status).not.toHaveBeenCalled();
      expect(factory.open).toHaveBeenCalledTimes(1);
    });

    it("records the answer of a switch to Integrated before the mode changes, opening nothing until then", async () => {
      const { service, factory, input, answer } = await withGit("electron", false);
      await service.configure(input("manual"));
      await service.setAdopted(input("manual"), true);
      expect(answer.adopted).toBe(true);
      expect(factory.open).not.toHaveBeenCalled();
      await service.configure(input("integrated"));
      expect(service.getSnapshot()).toMatchObject({ active: true, blocked: null });
    });

    it("keeps the blocker when the answer cannot be written, and opens again on Refresh after the answer could not be read", async () => {
      const { service, factory, input } = await withGit("electron", false);
      await service.configure(input("integrated"));
      vi.mocked(factory.setAdoption).mockRejectedValueOnce(new Error("The folder is read-only."));
      await expect(service.setAdopted(input("integrated"), true)).rejects.toThrow("The folder is read-only.");
      expect(service.getSnapshot()).toMatchObject({ active: false, blocked: "not-adopted" });

      service.stop();
      vi.mocked(factory.readAdoption).mockRejectedValueOnce(new Error(".git/config could not be read."));
      await service.configure(input("integrated"));
      expect(service.getSnapshot()).toMatchObject({ blocked: null, problem: { title: "Could Not Open The Repository" } });
      await service.refresh();
      expect(service.getSnapshot()).toMatchObject({ blocked: "not-adopted", problem: null });
    });

    it("never asks on iOS, where only Haptic runs Git in app storage", async () => {
      const { service, factory, input } = await withGit("ios", false);
      await service.configure(input("integrated"));
      expect(factory.readAdoption).not.toHaveBeenCalled();
      expect(service.getSnapshot()).toMatchObject({ active: true, blocked: null });
    });
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

  it.each([
    ["a game covers the editor", (_service: SourceControlSyncService, away: boolean) => setEditorQuiet(away)],
    ["the app is in the background", (service: SourceControlSyncService, away: boolean) => service.setHidden(away)],
  ])("holds a status due while %s and reads it once on return", async (_name, setAway) => {
    const { service, input, spied } = await setup();
    await service.configure(input("integrated"));
    vi.useFakeTimers();
    try {
      spied.status.mockClear();
      // Play's Save All, just before the game covers the editor.
      service.noteSaved();
      setAway(service, true);
      service.noteSaved();
      await vi.advanceTimersByTimeAsync(STATUS_DEBOUNCE_MS * 4);
      expect(spied.status).not.toHaveBeenCalled();
      setAway(service, false);
      await vi.advanceTimersByTimeAsync(STATUS_DEBOUNCE_MS);
      expect(spied.status).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      setAway(service, false);
    }
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

  it("leaves out a blob no committed asset uses, and takes an unindexed asset's blobs from its own header", async () => {
    const { service, input, storage, remote } = await setup();
    await service.configure(input("integrated"));
    // A reverted edit's blob: nothing references it any more.
    const leftover = `assets/.blobs/${"e".repeat(64)}`;
    await storage.writeBinary(leftover, new Uint8Array([9, 9]));
    // A disabled plugin's asset, which the registry does not index, with its blob.
    const crate = await testAsset("Texture", "Crate", { chunks: [{ id: "payload", kind: "payload", mime: "application/octet-stream", data: new Uint8Array(70 * 1024).fill(3) }] });
    const [sha, blobBytes] = [...crate.blobs][0]!;
    await storage.writeBinary(`plugins/Props/assets/.blobs/${sha}`, blobBytes);
    await storage.writeBinary("plugins/Props/assets/Crate.texture.hasset", crate.bytes);
    await storage.writeText("assets/Rock.texture.hasset", "R2");
    await service.refreshStatus();
    await service.commit({ rowIds: new Set(["assets/Rock.texture.hasset", "plugins/Props/assets/Crate.texture.hasset"]), message: "Rock and crate", push: true });
    const files = [...remote.get(remote.branches.get("main")!).files.keys()];
    expect(files).toEqual(expect.arrayContaining(["assets/Rock.texture.hasset", "plugins/Props/assets/Crate.texture.hasset", `plugins/Props/assets/.blobs/${sha}`]));
    expect(files).not.toContain(leftover);
    expect(remote.lfsObjects.has("e".repeat(64))).toBe(false);
    // It stays in the working copy, in no row.
    expect(await storage.exists(leftover)).toBe(true);
    expect(service.getSnapshot().rows).toEqual([]);
  });

  it("reads the counts the push's look at the remote moved, when the push is refused", async () => {
    const { service, input, storage, remote } = await setup();
    await service.configure(input("integrated"));
    const theirs = remote.commit({ "assets/Forest.scene.hasset": "F-theirs" }, "Their forest");
    await storage.writeText("assets/Rock.texture.hasset", "R2");
    await service.commit({ rowIds: new Set(["assets/Rock.texture.hasset"]), message: "Rock", push: true });
    expect(service.getSnapshot()).toMatchObject({ problem: { title: "Could Not Push", code: "push-rejected" }, remoteHead: theirs, ahead: 1, behind: 1 });
  });

  it("refuses a push that would send an asset someone else locks, naming the holder", async () => {
    const { service, input, storage, locks, spied } = await setup();
    await service.configure(input("integrated"));
    await storage.writeText("assets/Rock.texture.hasset", "R2");
    locks.theirs.mockImplementation(async (paths) => paths.includes("assets/Rock.texture.hasset") ? [lock("assets/Rock.texture.hasset", "Sam", false)] : []);
    await service.commit({ rowIds: new Set(["assets/Rock.texture.hasset"]), message: "Rock", push: true });
    expect(locks.theirs).toHaveBeenCalledWith(["assets/Rock.texture.hasset"], "main");
    expect(spied.push).not.toHaveBeenCalled();
    expect(service.getSnapshot().problem).toMatchObject({ title: "Could Not Push", holders: [{ ownerName: "Sam" }] });
    expect(service.getSnapshot().problem?.message).toContain("Sam");
    expect(service.getSnapshot().ahead).toBe(1);
  });

  it("checks the locks of the branch it pushes, the one checked out, not the project's default branch", async () => {
    const { service, input, storage, locks, remote } = await setup();
    await service.configure(input("integrated"));
    await service.createBranch("feature");
    await storage.writeText("assets/Rock.texture.hasset", "R2");
    await service.commit({ rowIds: new Set(["assets/Rock.texture.hasset"]), message: "Rock", push: true });
    expect(locks.theirs.mock.calls).toEqual([[["assets/Rock.texture.hasset"], "feature"]]);
    expect(remote.branches.has("feature")).toBe(true);
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
        ...NOT_ASKED,
      };
      const locks = {
        theirs: vi.fn<(paths: readonly string[], branch: string) => Promise<FileLock[]>>(async () => []),
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

  describe("branches", () => {
    it("shows the working copy's branch, not the project's default, and reopens nothing when the default changes", async () => {
      const { service, factory, input, port } = await setup();
      await port.createBranch("feature");
      await service.configure(input("integrated"));
      expect(service.getSnapshot()).toMatchObject({ active: true, branch: "feature" });
      const current = input("integrated");
      await service.configure({ ...current, settings: { ...current.settings, branch: "release" } });
      expect(factory.open).toHaveBeenCalledTimes(1);
      expect(service.getSnapshot().branch).toBe("feature");
    });

    it("lists this copy's branches without the network and the remote's from it", async () => {
      const { service, input, remote, port } = await setup();
      remote.commit({ "assets/Rock.texture.hasset": "R-art" }, "Art", "art");
      await service.configure(input("integrated"));
      const remoteBranches = vi.spyOn(port, "remoteBranches");
      expect(await service.localBranches()).toEqual(["main"]);
      expect(remoteBranches).not.toHaveBeenCalled();
      expect(await service.remoteBranches()).toEqual(["art", "main"]);
    });

    it("starts a branch at HEAD that has nothing to push until it has a commit, which a push then creates on the remote", async () => {
      const { service, input, storage, remote } = await setup();
      await service.configure(input("integrated"));
      const head = service.getSnapshot().head;
      await service.createBranch("feature");
      expect(service.getSnapshot()).toMatchObject({ branch: "feature", head, ahead: 0, behind: 0, rows: [] });
      await expect(service.createBranch("feature")).rejects.toMatchObject({ code: "branch-exists" });
      await storage.writeText("assets/Rock.texture.hasset", "R2");
      await service.commit({ rowIds: new Set(["assets/Rock.texture.hasset"]), message: "Rock", push: true });
      expect(remote.branches.get("feature")).toBe(service.getSnapshot().head);
      expect(service.getSnapshot()).toMatchObject({ branch: "feature", ahead: 0, problem: null });
    });

    it("switches branch, returning the files it wrote, and refuses while a file it would replace has uncommitted changes", async () => {
      const { service, input, storage, remote } = await setup({ files: { ...SEED, "project.json": projectJsonWith({ mode: "integrated", repositoryUrl: URL }) } });
      // Integrated with the same repository, in another spelling of its URL.
      const art = remote.commit({ "assets/Rock.texture.hasset": "R-art", "project.json": projectJsonWith({ mode: "integrated", repositoryUrl: "git@github.com:team/game" }) }, "Art", "art");
      await service.configure(input("integrated"));
      const main = service.getSnapshot().head;
      await storage.writeText("assets/Rock.texture.hasset", "R-mine");
      await service.refreshStatus();

      await expect(service.switchBranch("art")).rejects.toMatchObject({ kind: "conflict", code: "uncommitted-changes", paths: ["assets/Rock.texture.hasset"] });
      expect(service.getSnapshot()).toMatchObject({ branch: "main", head: main, operation: null, problem: { title: "Could Not Switch Branch" } });
      expect(await storage.readText("assets/Rock.texture.hasset")).toBe("R-mine");

      await storage.writeText("assets/Rock.texture.hasset", "R");
      expect(await service.switchBranch("art")).toEqual({ head: art, changedPaths: ["assets/Rock.texture.hasset", "project.json"] });
      expect(await storage.readText("assets/Rock.texture.hasset")).toBe("R-art");
      expect(await storage.readText("project.json")).toContain("git@github.com:team/game");
      // The local counts are in when it returns; the check of the remote follows without holding the reload.
      expect(service.getSnapshot()).toMatchObject({ branch: "art", head: art, rows: [], problem: null, operation: { kind: "fetch" } });
      await service.settled();
      expect(service.getSnapshot()).toMatchObject({ branch: "art", remoteHead: art, operation: null });
      expect(await service.localBranches()).toEqual(["art", "main"]);
    });

    it.each([
      ["Manual", projectJsonWith({ mode: "manual", repositoryUrl: URL }), "art's Project Settings set Source Control to Manual"],
      ["Off", projectJsonWith({ mode: "off", repositoryUrl: URL }), "art's Project Settings set Source Control to Off"],
      ["another repository", projectJsonWith({ mode: "integrated", repositoryUrl: "https://github.com/team/other.git" }), "art's Project Settings use another repository (https://github.com/team/other.git)"],
      ["no project.json", null, "art has no Haptic project: project.json is missing."],
      ["an unreadable project.json", "{", "art's project.json cannot be read."],
    ])("refuses to switch to a branch whose project.json would stop Integrated mode here (%s), changing nothing", async (_name, settings, reason) => {
      const { service, input, storage, remote, port } = await setup({ files: { ...SEED, "project.json": projectJsonWith({ mode: "integrated", repositoryUrl: URL }) } });
      remote.commit({ "assets/Rock.texture.hasset": "R-art", "project.json": settings }, "Art", "art");
      await service.configure(input("integrated"));
      const main = service.getSnapshot().head;
      const switched = vi.spyOn(port, "switchBranch");
      const refusal = service.switchBranch("art");
      await expect(refusal).rejects.toThrow(reason);
      expect(switched).not.toHaveBeenCalled();
      expect(service.getSnapshot()).toMatchObject({ branch: "main", head: main, operation: null, problem: { title: "Could Not Switch Branch" } });
      expect(await storage.readText("assets/Rock.texture.hasset")).toBe("R");
      expect(await storage.readText("project.json")).toContain(`"integrated"`);
      expect(await service.localBranches()).toEqual(["main"]);
    });

    it("pages the history of an asset or the branch, and lists the files a commit changed", async () => {
      const { service, input, storage } = await setup();
      await service.configure(input("integrated"));
      await storage.writeText("assets/Rock.texture.hasset", "R2");
      await service.commit({ rowIds: new Set(["assets/Rock.texture.hasset"]), message: "Rock", push: false });
      await storage.writeText("assets/Forest.scene.hasset", "F2");
      await service.commit({ rowIds: new Set(["assets/Forest.scene.hasset"]), message: "Forest", push: false });
      const all = await service.history({ limit: 2 });
      expect(all.commits.map((commit) => commit.message)).toEqual(["Forest", "Rock"]);
      expect((await service.history({ limit: 2, skip: 2 })).commits.map((commit) => commit.message)).toEqual(["Seed"]);
      expect((await service.history({ limit: 5, path: "assets/Rock.texture.hasset" })).commits.map((commit) => commit.message)).toEqual(["Rock", "Seed"]);
      expect(await service.commitChanges(all.commits[0]!.id)).toEqual([{ path: "assets/Forest.scene.hasset", kind: "modified" }]);
    });

    it("loads older history in the queue, where a close waits for it and cancels its download, and reads the counts the download moved", async () => {
      const { service, input, remote, port } = await setup();
      await service.configure(input("integrated"));
      remote.commit({ "assets/Rock.texture.hasset": "R2" }, "Brighter rock");
      // A deepen fetches the branch, which moves its remote-tracking branch, as the Git core's does.
      let finish!: () => void;
      const signals: (AbortSignal | undefined)[] = [];
      const log = port.log.bind(port);
      vi.spyOn(port, "log").mockImplementation(async (options) => {
        if (options.deepen) {
          signals.push(options.signal);
          await port.fetch();
          await new Promise<void>((resolve, reject) => {
            finish = resolve;
            options.signal?.addEventListener("abort", () => reject(new SyncError("cancelled", "Cancelled.")));
          });
        }
        return log(options);
      });

      const loading = service.history({ limit: 50, deepen: true });
      await vi.waitFor(() => expect(signals).toHaveLength(1));
      let settled = false;
      void service.settled().then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      finish();
      expect((await loading).commits.map((commit) => commit.message)).toEqual(["Seed"]);
      await service.settled();
      expect(service.getSnapshot()).toMatchObject({ behind: 1, incoming: [{ message: "Brighter rock" }] });

      const closing = service.history({ limit: 50, deepen: true });
      await vi.waitFor(() => expect(signals).toHaveLength(2));
      service.stop();
      expect(signals[1]!.aborted).toBe(true);
      await expect(closing).rejects.toThrow();
      await service.settled();
    });
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

    it("names no checked-out branch while the repository cannot open, as on a detached HEAD", async () => {
      const { service, input, factory } = await setup();
      const detached = "This working copy has no branch checked out. Check out a branch with the Git app that left it, then open the project again.";
      vi.mocked(factory.open).mockRejectedValueOnce(new SyncError("conflict", detached, { code: "detached-head" }));
      await service.configure(input("integrated"));
      // Not the project's default branch: nothing is checked out that Haptic could show or start a branch from.
      expect(service.getSnapshot()).toMatchObject({ active: true, branch: "", head: null, problem: { title: "Could Not Open The Repository", message: detached, code: "detached-head" } });
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
        ...NOT_ASKED,
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
