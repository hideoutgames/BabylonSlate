import type { ProjectStorage } from "@haptic/core";
import * as git from "isomorphic-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lfsPointerText } from "../lfs-pointer";
import { GITATTRIBUTES_LFS_RULE, isSyncError, type SyncError } from "../sync-port";
import {
  blobBytes,
  blobPath,
  CREDENTIAL,
  countingStorage,
  GIT_ORIGIN,
  GitTestServer,
  REPOSITORY_URL,
  STORAGE_AUTHORIZATION,
  STORAGE_ORIGIN,
} from "../test-support/git-server";
import { fixedCredential } from "../credentials";
import { readAdoption, setAdoption } from "./adoption";
import { cloneRepository, initRepository, openRepository, type GitRepository } from "./repository";

// isomorphic-git as it is, with its commit reads counted.
vi.mock("isomorphic-git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("isomorphic-git")>();
  return { ...actual, readCommit: vi.fn(actual.readCommit) };
});

const AUTHOR = { name: "Device", email: "device@example.com" };
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const RULE = `${GITATTRIBUTES_LFS_RULE}\n`;
const text = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null);
const encode = (value: string) => new TextEncoder().encode(value);

let server: GitTestServer;

beforeEach(async () => {
  server = await GitTestServer.start();
});

afterEach(async () => {
  await server.stop();
});

async function clone(storage?: ProjectStorage, options: { depth?: number; token?: string } = {}): Promise<GitRepository> {
  return cloneRepository({
    storage: storage ?? (await server.storage()),
    http: server.http,
    credential: options.token ? fixedCredential({ ...CREDENTIAL, token: options.token }) : server.credential(),
    repositoryUrl: REPOSITORY_URL,
    branch: "main",
    now: () => NOW,
    ...(options.depth ? { depth: options.depth } : {}),
  });
}

/** The project folder the storage is bound to, for reading it back with the system `git`. */
function folder(storage: ProjectStorage): string {
  return storage.getCurrentFolder()!.id.replace(/^node:/, "");
}

async function rejection(promise: Promise<unknown>): Promise<SyncError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(isSyncError(error)).toBe(true);
  return error as SyncError;
}

// Each test drives the system `git` and a CGI server, which take seconds rather than milliseconds.
describe("GitRepository", { timeout: 60_000 }, () => {
  it("clones shallow with LFS objects downloaded, and reads no unchanged file for status", async () => {
    const texture = blobBytes(1, 300_000);
    server.seed({ ".gitattributes": RULE, "project.json": "{}\n", "assets/a.hasset": "A" });
    server.seed({ "assets/b.hasset": "B", [blobPath(texture)]: texture });
    const { storage, reads } = countingStorage(await server.storage());
    const repository = await clone(storage);

    expect(text(await storage.readBinary("assets/b.hasset"))).toBe("B");
    expect(await storage.readBinary(blobPath(texture))).toEqual(texture);
    expect(server.git(server.bare, "rev-list", "--count", "main").trim()).toBe("2");
    expect((await repository.log({ limit: 10 })).commits.map((commit) => commit.message.trim())).toEqual(["Seed"]);

    reads.length = 0;
    const status = await repository.status();
    expect(status.changes).toEqual([]);
    expect(reads.filter((path) => !path.startsWith(".git/"))).toEqual([]);
    expect(repository.lastOperation.storage).toMatchObject({ workingReads: 0, pointerReads: 0 });
  });

  it("lists changes and commits exactly the chosen paths, storing .blobs files as pointers without reading them", async () => {
    server.seed({ ".gitattributes": RULE, "assets/a.hasset": "A", "assets/b.hasset": "B", "assets/c.hasset": "C" });
    const { storage, reads } = countingStorage(await server.storage());
    const repository = await clone(storage);
    const texture = blobBytes(2, 70_000);
    await storage.writeBinary("assets/a.hasset", encode("A2"));
    await storage.writeBinary("assets/c.hasset", encode("C2"));
    await storage.remove("assets/b.hasset");
    await storage.writeBinary(blobPath(texture), texture);
    expect((await repository.status()).changes).toEqual([
      { path: blobPath(texture), kind: "added" },
      { path: "assets/a.hasset", kind: "modified" },
      { path: "assets/b.hasset", kind: "deleted" },
      { path: "assets/c.hasset", kind: "modified" },
    ]);

    reads.length = 0;
    const { commit } = await repository.commit({ paths: ["assets/a.hasset", "assets/b.hasset", blobPath(texture)], message: "Edit", author: AUTHOR });
    expect(reads).not.toContain(blobPath(texture));
    const dir = folder(storage);
    expect(server.git(dir, "rev-parse", "HEAD").trim()).toBe(commit);
    expect(server.git(dir, "show", `HEAD:${blobPath(texture)}`)).toBe(lfsPointerText(blobPath(texture).slice(-64), 70_000));
    expect(server.git(dir, "show", "HEAD:assets/a.hasset")).toBe("A2");
    expect(server.git(dir, "show", "HEAD:assets/c.hasset")).toBe("C");
    expect(server.git(dir, "log", "-1", "--format=%an <%ae> %at")).toBe(`Device <device@example.com> ${NOW / 1000}\n`);
    expect((await repository.status()).changes).toEqual([{ path: "assets/c.hasset", kind: "modified" }]);
  });

  it("refuses to commit .blobs files unless the commit's .gitattributes stores them through LFS", async () => {
    server.seed({ "assets/a.hasset": "A" });
    const storage = await server.storage();
    const repository = await clone(storage);
    const texture = blobBytes(3, 1000);
    await storage.writeBinary(blobPath(texture), texture);

    const error = await rejection(repository.commit({ paths: [blobPath(texture)], message: "Blob", author: AUTHOR }));
    expect([error.kind, error.code]).toEqual(["lfs", "missing-lfs-rule"]);
    // The rule in the working tree does not count until the same commit carries it.
    await storage.writeBinary(".gitattributes", encode(RULE));
    expect((await rejection(repository.commit({ paths: [blobPath(texture)], message: "Blob", author: AUTHOR }))).code).toBe("missing-lfs-rule");
    await repository.commit({ paths: [blobPath(texture), ".gitattributes"], message: "Blob", author: AUTHOR });
    expect((await repository.status()).changes).toEqual([]);
  });

  it("pushes after uploading only the LFS objects the server lacks, never sending the stored credential to the store", async () => {
    const kept = blobBytes(4, 50_000);
    server.seed({ ".gitattributes": RULE, "assets/a.hasset": "A", [blobPath(kept)]: kept });
    const storage = await server.storage();
    const repository = await clone(storage);
    const added = blobBytes(5, 120_000);
    await storage.writeBinary(blobPath(added), added);
    // The same object under a plugin's content root: the server already has it.
    await storage.writeBinary(blobPath(kept, "plugins/p/assets"), kept);
    await storage.writeBinary("assets/a.hasset", encode("A2"));
    const { commit } = await repository.commit({ paths: [blobPath(added), blobPath(kept, "plugins/p/assets"), "assets/a.hasset"], message: "Add", author: AUTHOR });
    server.requests.length = 0;

    expect(await repository.push()).toEqual({ head: commit, uploaded: 1 });
    expect(server.git(server.bare, "rev-parse", "main").trim()).toBe(commit);
    expect(server.objects.get(blobPath(added).slice(-64))).toEqual(added);
    const toStore = server.requests.filter((request) => request.origin === STORAGE_ORIGIN);
    expect(toStore.map((request) => `${request.method} ${request.path}`)).toEqual([`PUT /objects/${blobPath(added).slice(-64)}`]);
    expect(toStore.every((request) => request.authorization === STORAGE_AUTHORIZATION)).toBe(true);
    const toGit = server.requests.filter((request) => request.origin === GIT_ORIGIN);
    expect(toGit.every((request) => request.authorization?.startsWith("Basic "))).toBe(true);
    // Smart HTTP identifies as a Git client, not as the WebView native HTTP would otherwise name.
    expect(toGit.filter((request) => !request.path.includes("/info/lfs/")).map((request) => request.userAgent?.split("@")[0])).toEqual(["git/isomorphic-git", "git/isomorphic-git"]);
  });

  it("refuses a push when the remote moved, as a conflict", async () => {
    server.seed({ "assets/a.hasset": "A" });
    const storage = await server.storage();
    const repository = await clone(storage);
    server.seed({ "assets/b.hasset": "B" }, "Teammate");
    await storage.writeBinary("assets/a.hasset", encode("A2"));
    await repository.commit({ paths: ["assets/a.hasset"], message: "Mine", author: AUTHOR });
    const error = await rejection(repository.push());
    expect([error.kind, error.code]).toEqual(["conflict", "push-rejected"]);
  });

  it("fetches and counts the commits on each side", async () => {
    server.seed({ "assets/a.hasset": "A" });
    const storage = await server.storage();
    const repository = await clone(storage);
    const teammate = server.teammate();
    teammate.write({ "assets/b.hasset": "B" });
    teammate.commitAndPush("One");
    teammate.write({ "assets/b.hasset": "B2" });
    const remote = teammate.commitAndPush("Two");
    await storage.writeBinary("assets/a.hasset", encode("A2"));
    const { commit } = await repository.commit({ paths: ["assets/a.hasset"], message: "Mine", author: AUTHOR });

    const state = await repository.fetch();
    expect(state).toMatchObject({ branch: "main", local: commit, remote, ahead: 1, behind: 2 });
    expect(state.incoming.map((entry) => entry.message.trim())).toEqual(["Two", "One"]);
  });

  it("fast-forwards, writing incoming files and downloading only LFS objects that are missing", async () => {
    const kept = blobBytes(6, 40_000);
    server.seed({ ".gitattributes": RULE, "assets/a.hasset": "A", "assets/b.hasset": "B", [blobPath(kept)]: kept });
    const storage = await server.storage();
    const repository = await clone(storage);
    const teammate = server.teammate();
    const added = blobBytes(7, 90_000);
    teammate.write({ "assets/a.hasset": "A2", "assets/new.hasset": "N", [blobPath(added)]: added, [blobPath(kept, "plugins/p/assets")]: kept });
    teammate.remove("assets/b.hasset");
    const remote = teammate.commitAndPush("Teammate");
    // Already on this device (another content root holds the same object): never downloaded.
    await storage.writeBinary(blobPath(kept, "plugins/p/assets"), kept);
    server.requests.length = 0;

    const result = await repository.pull({ author: AUTHOR });
    expect(result).toEqual({
      kind: "fast-forward",
      head: remote,
      changedPaths: [blobPath(added), "assets/a.hasset", "assets/b.hasset", "assets/new.hasset", blobPath(kept, "plugins/p/assets")],
    });
    expect(text(await storage.readBinary("assets/a.hasset"))).toBe("A2");
    expect(await storage.exists("assets/b.hasset")).toBe(false);
    expect(await storage.readBinary(blobPath(added))).toEqual(added);
    expect(server.requests.filter((request) => request.origin === STORAGE_ORIGIN).map((request) => request.path)).toEqual([`/objects/${blobPath(added).slice(-64)}`]);
    expect((await repository.status()).changes).toEqual([]);
    expect(server.git(folder(storage), "rev-parse", "HEAD").trim()).toBe(remote);
  });

  it("returns whole-file conflicts, uncommitted edits included, and changes nothing until each has a choice", async () => {
    server.seed({ "assets/a.hasset": "A", "assets/c.hasset": "C", "assets/d.hasset": "D" });
    const storage = await server.storage();
    const repository = await clone(storage);
    const teammate = server.teammate();
    teammate.write({ "assets/a.hasset": "A-theirs", "assets/c.hasset": "C-theirs", "assets/e.hasset": "E" });
    const remote = teammate.commitAndPush("Teammate");
    await storage.writeBinary("assets/a.hasset", encode("A-mine"));
    await storage.writeBinary("assets/d.hasset", encode("D-mine"));
    const { commit: local } = await repository.commit({ paths: ["assets/a.hasset", "assets/d.hasset"], message: "Mine", author: AUTHOR });
    // Saved but not committed: still mine.
    await storage.writeBinary("assets/c.hasset", encode("C-mine"));

    const conflicts = { kind: "conflicts", conflicts: [
      { path: "assets/a.hasset", mine: "modified", theirs: "modified" },
      { path: "assets/c.hasset", mine: "modified", theirs: "modified" },
    ] };
    expect(await repository.pull({ author: AUTHOR })).toEqual(conflicts);
    expect(await repository.pull({ author: AUTHOR, choices: { "assets/a.hasset": "theirs" } })).toEqual(conflicts);
    expect(text(await storage.readBinary("assets/c.hasset"))).toBe("C-mine");
    expect(await storage.exists("assets/e.hasset")).toBe(false);
    expect((await repository.status()).head).toBe(local);

    const result = await repository.pull({ author: AUTHOR, choices: { "assets/a.hasset": "theirs", "assets/c.hasset": "mine" } });
    expect(result).toMatchObject({ kind: "merged", changedPaths: ["assets/a.hasset", "assets/e.hasset"] });
    const dir = folder(storage);
    expect(server.git(dir, "rev-parse", "HEAD^1", "HEAD^2").trim().split("\n")).toEqual([local, remote]);
    expect(text(await storage.readBinary("assets/a.hasset"))).toBe("A-theirs");
    expect(text(await storage.readBinary("assets/c.hasset"))).toBe("C-mine");
    expect(server.git(dir, "show", "HEAD:assets/c.hasset")).toBe("C");
    expect(server.git(dir, "show", "HEAD:assets/d.hasset")).toBe("D-mine");
    expect(server.git(dir, "show", "HEAD:assets/e.hasset")).toBe("E");
    expect((await repository.status()).changes).toEqual([{ path: "assets/c.hasset", kind: "modified" }]);
    expect(await repository.push()).toMatchObject({ head: (result as { head: string }).head });
  });

  it("keeps an uncommitted file on a fast-forward when asked, leaving it as a change against the new head", async () => {
    server.seed({ "assets/a.hasset": "A" });
    const storage = await server.storage();
    const repository = await clone(storage);
    const teammate = server.teammate();
    teammate.write({ "assets/a.hasset": "A-theirs" });
    const remote = teammate.commitAndPush("Teammate");
    await storage.writeBinary("assets/a.hasset", encode("A-mine"));

    expect(await repository.pull({ author: AUTHOR, choices: { "assets/a.hasset": "mine" } })).toEqual({ kind: "fast-forward", head: remote, changedPaths: [] });
    expect(text(await storage.readBinary("assets/a.hasset"))).toBe("A-mine");
    expect((await repository.status()).changes).toEqual([{ path: "assets/a.hasset", kind: "modified" }]);
  });

  it("reads a file as a commit holds it, and an LFS object's own bytes", async () => {
    const texture = blobBytes(8, 10_000);
    const first = server.seed({ ".gitattributes": RULE, "assets/a.hasset": "A", [blobPath(texture)]: texture });
    const storage = await server.storage();
    const repository = await clone(storage);
    await storage.writeBinary("assets/a.hasset", encode("A2"));
    await repository.commit({ paths: ["assets/a.hasset"], message: "Edit", author: AUTHOR });

    expect(text(await repository.readFile("assets/a.hasset", first))).toBe("A");
    expect(await repository.readFile(blobPath(texture), first)).toEqual(texture);
    await storage.remove(blobPath(texture));
    expect(await repository.readFile(blobPath(texture), first)).toEqual(texture);
    expect(await repository.readFile("assets/missing.hasset", first)).toBeNull();
  });

  it("reads each commit once when a fetch counts and lists the incoming ones", async () => {
    server.seed({ "assets/a.hasset": "1" }, "One");
    const repository = await clone();
    server.seed({ "assets/a.hasset": "2" }, "Two");
    server.seed({ "assets/a.hasset": "3" }, "Three");
    const readCommit = vi.mocked(git.readCommit);
    readCommit.mockClear();
    const state = await repository.fetch();
    expect(state.incoming.map((commit) => commit.message)).toEqual(["Three\n", "Two\n"]);
    const reads = readCommit.mock.calls.map(([args]) => args.oid);
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads).size).toBe(reads.length);
  });

  it("deepens a shallow log on demand", async () => {
    server.seed({ "assets/a.hasset": "1" }, "One");
    server.seed({ "assets/a.hasset": "2" }, "Two");
    server.seed({ "assets/a.hasset": "3" }, "Three");
    const repository = await clone();
    // The clone's one commit ends the history it has; its parent is not here, so neither are its changes.
    const shallow = await repository.log({ limit: 3 });
    expect(shallow).toMatchObject({ commits: [{ message: "Three\n" }], hasMore: true, shallow: true });
    expect(await repository.commitChanges(shallow.commits[0]!.id)).toBeNull();
    // The next page deepens: the clone's commit is left out, the older ones come.
    const older = await repository.log({ limit: 3, skip: 1, deepen: true });
    expect(older.commits.map((commit) => commit.message)).toEqual(["Two\n", "One\n"]);
    expect(older).toMatchObject({ hasMore: false, shallow: false });
    expect(await repository.commitChanges(shallow.commits[0]!.id)).toEqual([{ path: "assets/a.hasset", kind: "modified" }]);
  });

  it("leaves the history as it was when a deepen is cancelled mid-fetch, so the next one deepens it", async () => {
    server.seed({ "assets/a.hasset": "1" }, "One");
    server.seed({ "assets/a.hasset": "2" }, "Two");
    server.seed({ "assets/a.hasset": "3" }, "Three");
    const controller = new AbortController();
    let armed = false;
    // Cancels at the deepen's first write into .git, letting that one write through as storage already had it.
    const storage = new Proxy(await server.storage(), {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== "function") return value;
        if (property !== "writeBinary" && property !== "writeText") return (value as (...args: unknown[]) => unknown).bind(target);
        return (path: string, ...rest: unknown[]) => {
          if (armed && path.startsWith(".git/")) controller.abort();
          return (value as (...args: unknown[]) => unknown).call(target, path, ...rest);
        };
      },
    });
    const repository = await clone(storage);
    armed = true;
    expect((await rejection(repository.log({ limit: 3, skip: 1, deepen: true, signal: controller.signal }))).kind).toBe("cancelled");
    armed = false;

    expect(await repository.log({ limit: 3 })).toMatchObject({ commits: [{ message: "Three\n" }], hasMore: true, shallow: true });
    expect((await repository.fetch()).behind).toBe(0);
    const older = await repository.log({ limit: 3, skip: 1, deepen: true });
    expect(older.commits.map((commit) => commit.message)).toEqual(["Two\n", "One\n"]);
    expect(server.git(folder(storage), "log", "--format=%s").trim().split("\n")).toEqual(["Three", "Two", "One"]);
  });

  it("offers older history only when the branch's own history stops at the shallow boundary", async () => {
    server.seed({ "assets/a.hasset": "1" }, "One");
    server.seed({ "assets/a.hasset": "2" }, "Two");
    const teammate = server.teammate();
    teammate.checkout("art");
    teammate.write({ "assets/b.hasset": "B" });
    teammate.commitAndPush("Art", "art");
    const storage = await server.storage();
    const repository = await clone(storage, { depth: 10 });
    // Switching to a branch only the remote has fetches it one commit deep: the copy is shallow from then on.
    await repository.switchBranch("art");
    await repository.switchBranch("main");
    expect(await storage.readText(".git/shallow")).not.toBe("");

    server.requests.length = 0;
    for (const options of [{ limit: 50 }, { limit: 50, deepen: true }, { limit: 50, path: "assets/a.hasset", deepen: true }]) {
      const page = await repository.log(options);
      expect(page.commits.map((commit) => commit.message.trim())).toEqual(["Two", "One"]);
      expect(page).toMatchObject({ hasMore: false, shallow: false });
    }
    expect(server.requests.filter((request) => request.origin === GIT_ORIGIN)).toEqual([]);
  });

  it("opens on the branch the working copy's HEAD names, and refuses a detached HEAD", async () => {
    server.seed({ "assets/a.hasset": "A" });
    const storage = await server.storage();
    const repository = await clone(storage);
    await repository.createBranch("feature");
    const options = { storage, http: server.http, credential: server.credential(), repositoryUrl: REPOSITORY_URL, now: () => NOW };
    expect((await (await openRepository(options)).status()).branch).toBe("feature");
    expect(server.git(folder(storage), "symbolic-ref", "HEAD").trim()).toBe("refs/heads/feature");

    // Its first push makes the remote branch its upstream, as other Git apps read it.
    await storage.writeBinary("assets/a.hasset", encode("A2"));
    await repository.commit({ paths: ["assets/a.hasset"], message: "Feature", author: AUTHOR });
    await repository.push();
    expect(server.git(folder(storage), "config", "--get", "branch.feature.merge").trim()).toBe("refs/heads/feature");

    server.git(folder(storage), "checkout", "--quiet", "--detach");
    expect(await rejection(openRepository(options))).toMatchObject({ kind: "conflict", code: "detached-head" });
  });

  it("types refused credentials, missing repositories and unreachable hosts", async () => {
    server.seed({ "assets/a.hasset": "A" });
    expect((await rejection(clone(undefined, { token: "wrong" }))).kind).toBe("auth");
    const missing = cloneRepository({ storage: await server.storage(), http: server.http, credential: server.credential(), repositoryUrl: `${GIT_ORIGIN}/team/none.git`, branch: "main" });
    expect((await rejection(missing)).kind).toBe("not-found");
    const offline = cloneRepository({ storage: await server.storage(), http: server.http, credential: fixedCredential({ ...CREDENTIAL, origin: "https://elsewhere.test" }), repositoryUrl: "https://elsewhere.test/a/b.git", branch: "main" });
    expect((await rejection(offline)).kind).toBe("network");
    const storage = await server.storage();
    await storage.writeBinary("project.json", encode("{}"));
    expect((await rejection(clone(storage))).code).toBe("not-empty");
  });

  it("starts Publish's working copy afresh over the .git an interrupted Publish left, only when asked", async () => {
    const storage = await server.storage();
    const options = { storage, http: server.http, credential: server.credential(), repositoryUrl: REPOSITORY_URL, branch: "main", now: () => NOW };
    await storage.writeBinary("project.json", encode("{}"));
    // The interrupted Publish: a working copy and its first commit, never pushed.
    const interrupted = await initRepository(options);
    await interrupted.commit({ paths: ["project.json"], message: "Publish project", author: AUTHOR });
    expect((await rejection(initRepository(options))).code).toBe("repository-exists");
    const fresh = await initRepository({ ...options, replace: true });
    expect(await fresh.status()).toEqual({ branch: "main", head: null, changes: [{ path: "project.json", kind: "added" }] });
    const { commit } = await fresh.commit({ paths: ["project.json"], message: "Publish project", author: AUTHOR });
    expect(await fresh.push()).toEqual({ head: commit, uploaded: 0 });
  });

  describe("adoption (Haptic runs Git in this working copy)", () => {
    it("is recorded in the Git config of every copy Clone and Publish make, as any Git reads it", async () => {
      server.seed({ "assets/a.hasset": "A" });
      const cloned = await server.storage();
      await clone(cloned);
      const published = await server.storage();
      await published.writeBinary("project.json", encode("{}"));
      await initRepository({ storage: published, http: server.http, credential: server.credential(), repositoryUrl: REPOSITORY_URL, branch: "main" });

      for (const storage of [cloned, published]) {
        expect(await readAdoption(storage)).toBe(true);
        expect(server.git(folder(storage), "config", "--get", "haptic.integrated").trim()).toBe("true");
      }
    });

    it("reads a working copy another Git app made as not adopted, and records or clears the answer, keeping the rest of its config", async () => {
      const storage = await server.storage();
      const dir = folder(storage);
      server.git(dir, "init", "--quiet", "--initial-branch=main");
      server.git(dir, "remote", "add", "origin", REPOSITORY_URL);
      expect(await readAdoption(storage)).toBe(false);

      await setAdoption(storage, true);
      expect(await readAdoption(storage)).toBe(true);
      expect(server.git(dir, "config", "--get", "haptic.integrated").trim()).toBe("true");
      await setAdoption(storage, false);
      expect(await readAdoption(storage)).toBe(false);
      expect(() => server.git(dir, "config", "--get", "haptic.integrated")).toThrow();
      expect(server.git(dir, "config", "--get", "remote.origin.url").trim()).toBe(REPOSITORY_URL);

      // Git's own spellings of true count, and so does an entry another Git app wrote.
      server.git(dir, "config", "haptic.integrated", "yes");
      expect(await readAdoption(storage)).toBe(true);
      server.git(dir, "config", "haptic.integrated", "false");
      expect(await readAdoption(storage)).toBe(false);
    });

    it("reads a folder without .git as not adopted", async () => {
      expect(await readAdoption(await server.storage())).toBe(false);
    });
  });
});
