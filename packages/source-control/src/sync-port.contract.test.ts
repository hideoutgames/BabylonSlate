import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectStorage } from "@haptic/core";
import { NodeStorageAdapter } from "@haptic/vfs/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeRemote, FakeSync } from "./fake-sync";
import { cloneRepository, initRepository } from "./git/repository";
import {
  GITATTRIBUTES_LFS_RULE,
  isSyncError,
  withIgnoreEntries,
  type SyncError,
  type SyncPort,
} from "./sync-port";
import { blobBytes, blobPath, GitTestServer, REPOSITORY_URL } from "./test-support/git-server";

// One contract for both SyncPort implementations, so the fake the editor's tests use cannot
// drift from the Git client: every case runs against GitRepository on a real Git HTTP server
// and against FakeSync.

type Changes = Record<string, string | Uint8Array | null>;

interface CopyOptions {
  signal?: AbortSignal;
  /** Called before each working tree write (not `.git`), as checkout makes them. */
  onWorkingWrite?: (path: string) => void;
}

interface Fixture {
  /** Commits `changes` to the remote's `branch` (main; a new branch starts from main) as a teammate; resolves to the new head. */
  teammate(changes: Changes, message?: string, branch?: string): Promise<string>;
  /** A new working copy of main, in its own project folder. */
  copy(options?: CopyOptions): Promise<{ port: SyncPort; storage: ProjectStorage }>;
  /** A new working copy with no commits in an empty project folder, as Publish starts one. */
  init(): Promise<{ port: SyncPort; storage: ProjectStorage }>;
  dispose(): Promise<void>;
}

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const AUTHOR = { name: "Device", email: "device@example.com" };
const RULE = `${GITATTRIBUTES_LFS_RULE}\n`;
const encode = (value: string) => new TextEncoder().encode(value);
const text = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null);

/** `storage` calling `onWrite` before each working tree write. */
function watched(storage: ProjectStorage, onWrite: ((path: string) => void) | undefined): ProjectStorage {
  if (!onWrite) return storage;
  return new Proxy(storage, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (property !== "writeBinary" && property !== "writeText") return (value as (...args: unknown[]) => unknown).bind(target);
      return (path: string, ...rest: unknown[]) => {
        if (path !== ".git" && !path.startsWith(".git/")) onWrite(path);
        return (value as (...args: unknown[]) => unknown).call(target, path, ...rest);
      };
    },
  });
}

async function gitFixture(): Promise<Fixture> {
  const server = await GitTestServer.start();
  return {
    async teammate(changes, message = "Teammate", branch = "main") {
      const teammate = server.teammate();
      if (branch !== "main") teammate.checkout(branch);
      teammate.write(Object.fromEntries(Object.entries(changes).filter((entry): entry is [string, string | Uint8Array] => entry[1] !== null)));
      teammate.remove(...Object.keys(changes).filter((path) => changes[path] === null));
      return teammate.commitAndPush(message, branch);
    },
    async copy(options = {}) {
      const storage = watched(await server.storage(), options.onWorkingWrite);
      const port = await cloneRepository({
        storage,
        http: server.http,
        credential: server.credential(),
        repositoryUrl: REPOSITORY_URL,
        branch: "main",
        now: () => NOW,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return { port, storage };
    },
    async init() {
      const storage = await server.storage();
      const port = await initRepository({ storage, http: server.http, credential: server.credential(), repositoryUrl: REPOSITORY_URL, branch: "main", now: () => NOW });
      return { port, storage };
    },
    dispose: () => server.stop(),
  };
}

async function fakeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "haptic-fake-sync-"));
  const remote = new FakeRemote({ now: () => NOW });
  let copies = 0;
  return {
    async teammate(changes, message, branch) {
      return remote.commit(changes, message, branch);
    },
    async copy(options = {}) {
      copies += 1;
      const node = new NodeStorageAdapter(root);
      await node.openDocumentsProject(`copy-${copies}`);
      const storage = watched(node, options.onWorkingWrite);
      return { port: await FakeSync.clone({ storage, remote, branch: "main", now: () => NOW, ...(options.signal ? { signal: options.signal } : {}) }), storage };
    },
    async init() {
      copies += 1;
      const storage = new NodeStorageAdapter(root);
      await storage.openDocumentsProject(`copy-${copies}`);
      return { port: FakeSync.init({ storage, remote, branch: "main", now: () => NOW }), storage };
    },
    async dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<SyncError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(isSyncError(error)).toBe(true);
  return error as SyncError;
}

describe.each([
  { name: "GitRepository", create: gitFixture },
  { name: "FakeSync", create: fakeFixture },
])("SyncPort contract: $name", { timeout: 60_000 }, ({ create }) => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await create();
  });

  afterEach(async () => {
    await fixture.dispose();
  });

  it("lists added, modified and deleted files, leaving ignored files out", async () => {
    await fixture.teammate({ ".gitignore": withIgnoreEntries(""), "assets/a.hasset": "A", "assets/b.hasset": "B" });
    const { port, storage } = await fixture.copy();
    expect((await port.status()).changes).toEqual([]);
    await storage.writeBinary("assets/a.hasset", encode("A2"));
    await storage.remove("assets/b.hasset");
    await storage.writeBinary("assets/c.hasset", encode("C"));
    await storage.writeBinary("layout.json", encode("{}"));
    await storage.writeBinary("assets/.haptic-move-1", encode("x"));
    expect(await port.status()).toMatchObject({
      branch: "main",
      changes: [
        { path: "assets/a.hasset", kind: "modified" },
        { path: "assets/b.hasset", kind: "deleted" },
        { path: "assets/c.hasset", kind: "added" },
      ],
    });
  });

  it("commits only the chosen paths and reads files as each commit holds them", async () => {
    const seed = await fixture.teammate({ "assets/a.hasset": "A", "assets/b.hasset": "B" });
    const { port, storage } = await fixture.copy();
    await storage.writeBinary("assets/a.hasset", encode("A2"));
    await storage.writeBinary("assets/b.hasset", encode("B2"));
    const { commit } = await port.commit({ paths: ["assets/a.hasset"], message: "Mine", author: AUTHOR });
    expect(await port.status()).toEqual({ branch: "main", head: commit, changes: [{ path: "assets/b.hasset", kind: "modified" }] });
    expect(text(await port.readFile("assets/a.hasset", commit))).toBe("A2");
    expect(text(await port.readFile("assets/a.hasset", seed))).toBe("A");
    expect(text(await port.readFile("assets/b.hasset", commit))).toBe("B");
    expect(await port.readFile("assets/none.hasset", commit)).toBeNull();
    const log = await port.log({ limit: 5 });
    expect(log.commits.map((entry) => [entry.id, entry.message.trim(), entry.author])).toContainEqual([commit, "Mine", AUTHOR]);
    expect(log.commits[0]!.id).toBe(commit);
  });

  it("commits .blobs files only together with the LFS rule", async () => {
    await fixture.teammate({ "assets/a.hasset": "A" });
    const { port, storage } = await fixture.copy();
    const texture = blobBytes(1, 2048);
    await storage.writeBinary(blobPath(texture), texture);
    expect((await rejection(port.commit({ paths: [blobPath(texture)], message: "Blob", author: AUTHOR }))).code).toBe("missing-lfs-rule");
    await storage.writeBinary(".gitattributes", encode(RULE));
    await port.commit({ paths: [blobPath(texture), ".gitattributes"], message: "Blob", author: AUTHOR });
    expect((await port.status()).changes).toEqual([]);
    expect(await port.push()).toMatchObject({ uploaded: 1 });
  });

  it("reads an LFS object from the working copy, else from the server, and never writes it", async () => {
    const pushed = blobBytes(5, 3000);
    await fixture.teammate({ ".gitattributes": RULE, "assets/a.hasset": "A", [blobPath(pushed)]: pushed });
    const { port, storage } = await fixture.copy();
    // Only in this working copy: the server never had it.
    const local = blobBytes(6, 2500);
    await storage.writeBinary(blobPath(local), local);
    expect(await port.readLfsObject(blobPath(local), local.byteLength)).toEqual(local);

    await storage.remove(blobPath(pushed));
    expect(await port.readLfsObject(blobPath(pushed), pushed.byteLength)).toEqual(pushed);
    expect(await storage.exists(blobPath(pushed))).toBe(false);
    expect((await port.status()).changes).toEqual([
      { path: blobPath(local), kind: "added" },
      { path: blobPath(pushed), kind: "deleted" },
    ].sort((a, b) => a.path.localeCompare(b.path)));

    const missing = blobBytes(7, 1000);
    expect(await rejection(port.readLfsObject(blobPath(missing), missing.byteLength))).toMatchObject({ kind: "lfs", code: "lfs-object-missing" });
    const cancelled = new AbortController();
    cancelled.abort();
    expect((await rejection(port.readLfsObject(blobPath(pushed), pushed.byteLength, { signal: cancelled.signal }))).kind).toBe("cancelled");
  });

  it("counts the commits on each side after a fetch", async () => {
    await fixture.teammate({ "assets/a.hasset": "A" });
    const { port, storage } = await fixture.copy();
    await fixture.teammate({ "assets/b.hasset": "B" }, "One");
    const remote = await fixture.teammate({ "assets/b.hasset": "B2" }, "Two");
    await storage.writeBinary("assets/a.hasset", encode("A2"));
    const { commit } = await port.commit({ paths: ["assets/a.hasset"], message: "Mine", author: AUTHOR });
    const state = await port.fetch();
    expect(state).toMatchObject({ branch: "main", local: commit, remote, ahead: 1, behind: 2 });
    // Only the remote's commits, newest first.
    expect(state.incoming.map((entry) => [entry.id === remote, entry.message.trim(), entry.author.name])).toEqual([
      [true, "Two", "Teammate"],
      [false, "One", "Teammate"],
    ]);
  });

  it("reads the counts as last fetched without asking the remote", async () => {
    await fixture.teammate({ "assets/a.hasset": "A" });
    const { port, storage } = await fixture.copy();
    await storage.writeBinary("assets/a.hasset", encode("A2"));
    const { commit } = await port.commit({ paths: ["assets/a.hasset"], message: "Mine", author: AUTHOR });
    const remote = await fixture.teammate({ "assets/b.hasset": "B" }, "Later");
    // The teammate's commit is not known until a fetch.
    expect(await port.remoteState()).toMatchObject({ local: commit, ahead: 1, behind: 0, incoming: [] });
    await port.fetch();
    const state = await port.remoteState();
    expect(state).toMatchObject({ local: commit, remote, ahead: 1, behind: 1 });
    expect(state.incoming.map((entry) => entry.message.trim())).toEqual(["Later"]);
  });

  it("ends a clone cancelled during checkout as cancelled", async () => {
    await fixture.teammate({ "assets/a.hasset": "A", "assets/b.hasset": "B", "assets/c.hasset": "C" });
    const controller = new AbortController();
    const error = await rejection(fixture.copy({ signal: controller.signal, onWorkingWrite: () => controller.abort() }));
    expect(error.kind).toBe("cancelled");
  });

  it("changes nothing when a fetch, pull or push is cancelled", async () => {
    await fixture.teammate({ "assets/a.hasset": "A" });
    const { port, storage } = await fixture.copy();
    const remote = await fixture.teammate({ "assets/b.hasset": "B" }, "Teammate");
    const cancelled = new AbortController();
    cancelled.abort();
    const { signal } = cancelled;
    expect((await rejection(port.fetch({ signal }))).kind).toBe("cancelled");
    expect(await port.remoteState()).toMatchObject({ behind: 0 });
    expect((await rejection(port.pull({ author: AUTHOR, signal }))).kind).toBe("cancelled");
    expect(await storage.exists("assets/b.hasset")).toBe(false);
    await port.pull({ author: AUTHOR });
    await storage.writeBinary("assets/a.hasset", encode("A2"));
    const { commit } = await port.commit({ paths: ["assets/a.hasset"], message: "Mine", author: AUTHOR });
    expect((await rejection(port.push({ signal }))).kind).toBe("cancelled");
    expect(await port.fetch()).toMatchObject({ local: commit, remote, ahead: 1 });
  });

  it("lists the paths a push would change, against the remote as last fetched", async () => {
    await fixture.teammate({ "assets/a.hasset": "A", "assets/b.hasset": "B", "assets/c.hasset": "C" });
    const { port, storage } = await fixture.copy();
    expect(await port.outgoing()).toEqual([]);
    await storage.writeBinary("assets/a.hasset", encode("A2"));
    await storage.remove("assets/b.hasset");
    await storage.writeBinary("assets/d.hasset", encode("D"));
    await storage.writeBinary("assets/c.hasset", encode("C2"));
    await port.commit({ paths: ["assets/a.hasset", "assets/b.hasset", "assets/d.hasset"], message: "Mine", author: AUTHOR });
    // The uncommitted edit of c is not part of a push.
    expect(await port.outgoing()).toEqual(["assets/a.hasset", "assets/b.hasset", "assets/d.hasset"]);
    await port.push();
    expect(await port.outgoing()).toEqual([]);
  });

  it("publishes a new working copy: the first push creates the branch another copy clones", async () => {
    const { port, storage } = await fixture.init();
    expect(await port.status()).toMatchObject({ head: null, changes: [] });
    const texture = blobBytes(3, 4096);
    await storage.writeBinary(".gitattributes", encode(RULE));
    await storage.writeBinary(".gitignore", encode(withIgnoreEntries("")));
    await storage.writeBinary("project.json", encode("{}"));
    await storage.writeBinary(blobPath(texture), texture);
    await storage.writeBinary("layout.json", encode("{}"));
    const { changes } = await port.status();
    expect(changes.map((change) => change.path)).toEqual([".gitattributes", ".gitignore", blobPath(texture), "project.json"]);
    const { commit } = await port.commit({ paths: changes.map((change) => change.path), message: "Publish", author: AUTHOR });
    expect(await port.outgoing()).toEqual([".gitattributes", ".gitignore", blobPath(texture), "project.json"]);
    expect(await port.push()).toEqual({ head: commit, uploaded: 1 });
    expect(await port.fetch()).toMatchObject({ local: commit, remote: commit, ahead: 0, behind: 0, incoming: [] });
    const other = await fixture.copy();
    expect(await other.storage.readBinary(blobPath(texture))).toEqual(texture);
    expect(text(await other.storage.readBinary("project.json"))).toBe("{}");
    expect(await other.storage.exists("layout.json")).toBe(false);
  });

  it("fast-forwards to the remote's files", async () => {
    await fixture.teammate({ "assets/a.hasset": "A", "assets/b.hasset": "B" });
    const { port, storage } = await fixture.copy();
    const remote = await fixture.teammate({ "assets/a.hasset": "A2", "assets/b.hasset": null, "assets/n.hasset": "N" });
    expect(await port.pull({ author: AUTHOR })).toEqual({ kind: "fast-forward", head: remote, changedPaths: ["assets/a.hasset", "assets/b.hasset", "assets/n.hasset"] });
    expect(text(await storage.readBinary("assets/a.hasset"))).toBe("A2");
    expect(await storage.exists("assets/b.hasset")).toBe(false);
    expect(await port.status()).toEqual({ branch: "main", head: remote, changes: [] });
    expect(await port.pull({ author: AUTHOR })).toEqual({ kind: "up-to-date", head: remote });
  });

  it("needs a choice for every file changed on both sides, uncommitted edits included, before it merges", async () => {
    await fixture.teammate({ "assets/a.hasset": "A", "assets/c.hasset": "C", "assets/d.hasset": "D" });
    const { port, storage } = await fixture.copy();
    await fixture.teammate({ "assets/a.hasset": "A-theirs", "assets/c.hasset": null, "assets/e.hasset": "E" });
    await storage.writeBinary("assets/a.hasset", encode("A-mine"));
    await storage.writeBinary("assets/d.hasset", encode("D-mine"));
    const { commit: local } = await port.commit({ paths: ["assets/a.hasset", "assets/d.hasset"], message: "Mine", author: AUTHOR });
    await storage.writeBinary("assets/c.hasset", encode("C-mine"));

    const conflicts = {
      kind: "conflicts",
      conflicts: [
        { path: "assets/a.hasset", mine: "modified", theirs: "modified" },
        { path: "assets/c.hasset", mine: "modified", theirs: "deleted" },
      ],
    };
    expect(await port.pull({ author: AUTHOR })).toEqual(conflicts);
    expect(await port.pull({ author: AUTHOR, choices: { "assets/c.hasset": "mine" } })).toEqual(conflicts);
    expect((await port.status()).head).toBe(local);
    expect(await storage.exists("assets/e.hasset")).toBe(false);

    const merged = await port.pull({ author: AUTHOR, choices: { "assets/a.hasset": "theirs", "assets/c.hasset": "mine" } });
    expect(merged).toMatchObject({ kind: "merged", changedPaths: ["assets/a.hasset", "assets/e.hasset"] });
    const head = (merged as { head: string }).head;
    expect(text(await storage.readBinary("assets/a.hasset"))).toBe("A-theirs");
    expect(text(await storage.readBinary("assets/c.hasset"))).toBe("C-mine");
    expect(text(await port.readFile("assets/d.hasset", head))).toBe("D-mine");
    expect(text(await port.readFile("assets/c.hasset", head))).toBe("C");
    expect(await port.status()).toEqual({ branch: "main", head, changes: [{ path: "assets/c.hasset", kind: "modified" }] });
    expect(await port.push()).toEqual({ head, uploaded: 0 });
    expect(await port.fetch()).toMatchObject({ ahead: 0, behind: 0, remote: head });
  });

  it("logs a path's commits newest first, and older history on demand", async () => {
    await fixture.teammate({ "assets/a.hasset": "1", "assets/b.hasset": "1" }, "One");
    await fixture.teammate({ "assets/a.hasset": "2" }, "Two");
    await fixture.teammate({ "assets/a.hasset": "3" }, "Three");
    const { port, storage } = await fixture.copy();
    const deep = await port.log({ limit: 3, deepen: true });
    expect(deep.commits.map((commit) => commit.message.trim())).toEqual(["Three", "Two", "One"]);
    expect((await port.log({ limit: 10, deepen: true })).hasMore).toBe(false);
    // Pages: the next one leaves out what the first listed.
    const first = await port.log({ limit: 2 });
    expect(first).toMatchObject({ hasMore: true, shallow: false });
    const next = await port.log({ limit: 2, skip: first.commits.length });
    expect(next.commits.map((commit) => commit.message.trim())).toEqual(["One"]);
    expect(next).toMatchObject({ hasMore: false, shallow: false });

    await storage.writeBinary("assets/a.hasset", encode("4"));
    const { commit: a4 } = await port.commit({ paths: ["assets/a.hasset"], message: "A4", author: AUTHOR });
    await storage.writeBinary("assets/b.hasset", encode("2"));
    const { commit: b2 } = await port.commit({ paths: ["assets/b.hasset"], message: "B2", author: AUTHOR });
    const ofA = (await port.log({ limit: 10, path: "assets/a.hasset" })).commits.map((commit) => commit.message.trim());
    expect(ofA.slice(0, 3)).toEqual(["A4", "Three", "Two"]);
    const ofB = (await port.log({ limit: 10, path: "assets/b.hasset" })).commits.map((commit) => commit.id);
    expect(ofB[0]).toBe(b2);
    expect(ofB).not.toContain(a4);
  });

  it("lists the files a commit changed against its parent", async () => {
    await fixture.teammate({ "assets/a.hasset": "A", "assets/b.hasset": "B" });
    const { port, storage } = await fixture.copy();
    await storage.writeBinary("assets/a.hasset", encode("A2"));
    await storage.remove("assets/b.hasset");
    await storage.writeBinary("assets/c.hasset", encode("C"));
    const { commit } = await port.commit({ paths: ["assets/a.hasset", "assets/b.hasset", "assets/c.hasset"], message: "Mine", author: AUTHOR });
    expect(await port.commitChanges(commit)).toEqual([
      { path: "assets/a.hasset", kind: "modified" },
      { path: "assets/b.hasset", kind: "deleted" },
      { path: "assets/c.hasset", kind: "added" },
    ]);
  });

  it("starts a branch at HEAD that the next push creates on the remote, where another copy lists it and switches to it", async () => {
    await fixture.teammate({ "assets/a.hasset": "A" });
    await fixture.teammate({ "assets/art.hasset": "Art" }, "Art", "art");
    const { port, storage } = await fixture.copy();
    expect(await port.localBranches()).toEqual(["main"]);
    expect(await port.remoteBranches()).toEqual(["art", "main"]);

    expect(await rejection(port.createBranch("bad name"))).toMatchObject({ kind: "conflict", code: "invalid-branch-name" });
    expect(await rejection(port.createBranch("main"))).toMatchObject({ kind: "conflict", code: "branch-exists" });
    const { head } = await port.status();
    await port.createBranch("feature");
    expect(await port.localBranches()).toEqual(["feature", "main"]);
    expect(await port.status()).toEqual({ branch: "feature", head, changes: [] });
    // Not on the remote yet: nothing to pull, nothing new to push, and fetching it is no failure.
    expect(await port.fetch()).toMatchObject({ branch: "feature", local: head, remote: null, ahead: 0, behind: 0 });

    await storage.writeBinary("assets/a.hasset", encode("A-feature"));
    const { commit } = await port.commit({ paths: ["assets/a.hasset"], message: "Feature", author: AUTHOR });
    expect(await port.remoteState()).toMatchObject({ local: commit, remote: null, ahead: 1, behind: 0 });
    expect(await port.outgoing()).toEqual(["assets/a.hasset"]);
    await port.push();
    expect(await port.fetch()).toMatchObject({ local: commit, remote: commit, ahead: 0, behind: 0 });
    expect(await port.remoteBranches()).toEqual(["art", "feature", "main"]);

    const other = await fixture.copy();
    expect(await other.port.switchBranch("feature")).toEqual({ head: commit, changedPaths: ["assets/a.hasset"] });
    expect(text(await other.storage.readBinary("assets/a.hasset"))).toBe("A-feature");
    expect(await other.port.status()).toEqual({ branch: "feature", head: commit, changes: [] });
    expect(await other.port.localBranches()).toEqual(["feature", "main"]);
    expect((await other.port.log({ limit: 1 })).commits[0]!.id).toBe(commit);
    // It tracks the remote branch: a teammate's commit there comes in with a pull.
    const later = await fixture.teammate({ "assets/b.hasset": "B" }, "Later", "feature");
    expect(await other.port.pull({ author: AUTHOR })).toMatchObject({ kind: "fast-forward", head: later, changedPaths: ["assets/b.hasset"] });
    expect(await other.port.switchBranch("feature")).toEqual({ head: later, changedPaths: [] });
    expect(await rejection(other.port.switchBranch("missing"))).toMatchObject({ kind: "not-found" });
  });

  it("switches branches, keeping uncommitted changes the switch does not touch and refusing ones it would overwrite", async () => {
    await fixture.teammate({ "assets/a.hasset": "A", "assets/b.hasset": "B", "assets/e.hasset": "E" });
    const art = await fixture.teammate({ "assets/a.hasset": "A-art", "assets/b.hasset": null, "assets/c.hasset": "C" }, "Art", "art");
    const { port, storage } = await fixture.copy();
    const main = (await port.status()).head;
    await storage.writeBinary("assets/e.hasset", encode("E-mine"));

    // A file the branches hold differently: refused, and nothing changes.
    await storage.writeBinary("assets/a.hasset", encode("A-mine"));
    expect(await rejection(port.switchBranch("art"))).toMatchObject({ kind: "conflict", code: "uncommitted-changes", paths: ["assets/a.hasset"] });
    // As is a file only the other branch has, which would be written over.
    await storage.writeBinary("assets/a.hasset", encode("A"));
    await storage.writeBinary("assets/c.hasset", encode("C-mine"));
    expect(await rejection(port.switchBranch("art"))).toMatchObject({ code: "uncommitted-changes", paths: ["assets/c.hasset"] });
    expect(await port.status()).toMatchObject({ branch: "main", head: main });
    expect(text(await storage.readBinary("assets/a.hasset"))).toBe("A");
    await storage.remove("assets/c.hasset");

    expect(await port.switchBranch("art")).toEqual({ head: art, changedPaths: ["assets/a.hasset", "assets/b.hasset", "assets/c.hasset"] });
    expect(text(await storage.readBinary("assets/a.hasset"))).toBe("A-art");
    expect(await storage.exists("assets/b.hasset")).toBe(false);
    expect(text(await storage.readBinary("assets/c.hasset"))).toBe("C");
    // The edit to e, which both branches hold alike, came along.
    expect(await port.status()).toEqual({ branch: "art", head: art, changes: [{ path: "assets/e.hasset", kind: "modified" }] });

    expect(await port.switchBranch("main")).toEqual({ head: main, changedPaths: ["assets/a.hasset", "assets/b.hasset", "assets/c.hasset"] });
    expect(text(await storage.readBinary("assets/b.hasset"))).toBe("B");
    expect(await storage.exists("assets/c.hasset")).toBe(false);
    expect(await port.status()).toEqual({ branch: "main", head: main, changes: [{ path: "assets/e.hasset", kind: "modified" }] });
  });

  it("refuses to push over commits it has not pulled", async () => {
    await fixture.teammate({ "assets/a.hasset": "A" });
    const { port, storage } = await fixture.copy();
    await fixture.teammate({ "assets/b.hasset": "B" });
    await storage.writeBinary("assets/a.hasset", encode("A2"));
    await port.commit({ paths: ["assets/a.hasset"], message: "Mine", author: AUTHOR });
    expect(await rejection(port.push())).toMatchObject({ kind: "conflict", code: "push-rejected" });
    expect(await port.pull({ author: AUTHOR })).toMatchObject({ kind: "merged", changedPaths: ["assets/b.hasset"] });
    expect((await port.push()).uploaded).toBe(0);
  });
});
