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

interface Fixture {
  /** Commits `changes` to the remote's main as a teammate; resolves to the new head. */
  teammate(changes: Changes, message?: string): Promise<string>;
  /** A new working copy of main, in its own project folder. */
  copy(): Promise<{ port: SyncPort; storage: ProjectStorage }>;
  /** A new working copy with no commits in an empty project folder, as Publish starts one. */
  init(): Promise<{ port: SyncPort; storage: ProjectStorage }>;
  dispose(): Promise<void>;
}

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const AUTHOR = { name: "Device", email: "device@example.com" };
const RULE = `${GITATTRIBUTES_LFS_RULE}\n`;
const encode = (value: string) => new TextEncoder().encode(value);
const text = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null);

async function gitFixture(): Promise<Fixture> {
  const server = await GitTestServer.start();
  return {
    async teammate(changes, message = "Teammate") {
      const teammate = server.teammate();
      teammate.write(Object.fromEntries(Object.entries(changes).filter((entry): entry is [string, string | Uint8Array] => entry[1] !== null)));
      teammate.remove(...Object.keys(changes).filter((path) => changes[path] === null));
      return teammate.commitAndPush(message);
    },
    async copy() {
      const storage = await server.storage();
      const port = await cloneRepository({ storage, http: server.http, credential: server.credential(), repositoryUrl: REPOSITORY_URL, branch: "main", now: () => NOW });
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
    async teammate(changes, message) {
      return remote.commit(changes, message);
    },
    async copy() {
      copies += 1;
      const storage = new NodeStorageAdapter(root);
      await storage.openDocumentsProject(`copy-${copies}`);
      return { port: await FakeSync.clone({ storage, remote, branch: "main", now: () => NOW }), storage };
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
