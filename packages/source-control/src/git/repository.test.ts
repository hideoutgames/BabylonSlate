import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import type { FileTransferClient } from "../http";
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

async function clone(storage?: ProjectStorage, options: { depth?: number; token?: string; files?: FileTransferClient; signal?: AbortSignal } = {}): Promise<GitRepository> {
  return cloneRepository({
    storage: storage ?? (await server.storage()),
    http: server.http,
    ...(options.files ? { files: options.files } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
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
    // This branch never committed c, so the merge records the teammate's version and the kept edit stays uncommitted against it,
    // as a fast-forward leaves it.
    expect(server.git(dir, "show", "HEAD:assets/c.hasset")).toBe("C-theirs");
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

  it("keeps this branch's committed version of a file kept as mine in a merge", async () => {
    server.seed({ "assets/a.hasset": "A", "assets/b.hasset": "B" });
    const storage = await server.storage();
    const repository = await clone(storage);
    const teammate = server.teammate();
    teammate.write({ "assets/a.hasset": "A-theirs", "assets/b.hasset": "B-theirs" });
    teammate.commitAndPush("Teammate");
    await storage.writeBinary("assets/a.hasset", encode("A-mine"));
    await repository.commit({ paths: ["assets/a.hasset"], message: "Mine", author: AUTHOR });

    expect(await repository.pull({ author: AUTHOR, choices: { "assets/a.hasset": "mine" } })).toMatchObject({ kind: "merged", changedPaths: ["assets/b.hasset"] });
    expect(server.git(folder(storage), "show", "HEAD:assets/a.hasset")).toBe("A-mine");
    expect(server.git(folder(storage), "show", "HEAD:assets/b.hasset")).toBe("B-theirs");
    expect((await repository.status()).changes).toEqual([]);
  });

  describe("files another Git app staged", () => {
    /** A clone with a, b and c committed, then staged by the system `git` as `stage` says, b changed and saved in the working tree. */
    async function staged(stage: (dir: string) => void) {
      server.seed({ "assets/a.hasset": "A", "assets/b.hasset": "B", "assets/c.hasset": "C" });
      const storage = await server.storage();
      const repository = await clone(storage);
      const dir = folder(storage);
      stage(dir);
      await storage.writeBinary("assets/b.hasset", encode("B2"));
      return { storage, repository, dir };
    }

    it.each([
      ["added", (dir: string) => { writeFileSync(join(dir, "assets/n.hasset"), "N"); server.git(dir, "add", "assets/n.hasset"); }, { path: "assets/n.hasset", kind: "added" }],
      ["modified", (dir: string) => { writeFileSync(join(dir, "assets/a.hasset"), "A-staged"); server.git(dir, "add", "assets/a.hasset"); }, { path: "assets/a.hasset", kind: "modified" }],
      ["deleted", (dir: string) => { server.git(dir, "rm", "--quiet", "assets/c.hasset"); }, { path: "assets/c.hasset", kind: "deleted" }],
    ] as const)("shows a file %s and staged elsewhere, and never commits it unless chosen, keeping its working file", async (_name, stage, change) => {
      const { storage, repository, dir } = await staged(stage);
      expect((await repository.status()).changes).toContainEqual(change);
      await repository.commit({ paths: ["assets/b.hasset"], message: "Only b", author: AUTHOR });
      expect(server.git(dir, "show", "--name-only", "--format=", "HEAD").trim()).toBe("assets/b.hasset");
      // Its index entry is back at HEAD, so no later commit or merge takes it; its working file is as the other app left it.
      expect(server.git(dir, "diff", "--cached", "--name-only").trim()).toBe("");
      expect((await repository.status()).changes).toEqual([change]);
      expect(await storage.exists(change.path)).toBe(change.kind !== "deleted");
    });

    it("refuses a commit, changing nothing, while a version staged elsewhere exists nowhere else, and marks it", async () => {
      const { storage, repository, dir } = await staged((folderPath) => {
        writeFileSync(join(folderPath, "assets/a.hasset"), "A-staged");
        server.git(folderPath, "add", "assets/a.hasset");
        writeFileSync(join(folderPath, "assets/a.hasset"), "A-working");
      });
      const head = server.git(dir, "rev-parse", "HEAD").trim();
      expect((await repository.status()).changes).toContainEqual({ path: "assets/a.hasset", kind: "modified", staged: true });
      const error = await rejection(repository.commit({ paths: ["assets/b.hasset"], message: "Only b", author: AUTHOR }));
      expect([error.kind, error.code, error.paths]).toEqual(["conflict", "staged-elsewhere", ["assets/a.hasset"]]);
      // It says what happened and what to do next.
      expect(error.message).toBe(
        "Another Git app staged changes to assets/a.hasset that differ from both the last commit and the files on disk, and setting them aside would lose them. "
        + "Nothing was committed. Unstage or commit them in that app, or include them in this commit to commit the files as they are now.",
      );
      expect(server.git(dir, "rev-parse", "HEAD").trim()).toBe(head);
      expect(server.git(dir, "show", ":assets/a.hasset")).toBe("A-staged");
      expect(server.git(dir, "show", ":assets/b.hasset")).toBe("B");
      expect(text(await storage.readBinary("assets/a.hasset"))).toBe("A-working");
      // Chosen, it commits the working file.
      await repository.commit({ paths: ["assets/a.hasset", "assets/b.hasset"], message: "Both", author: AUTHOR });
      expect(server.git(dir, "show", "HEAD:assets/a.hasset")).toBe("A-working");
    });

    it("leaves what another app staged out of a merge commit", async () => {
      const { storage, repository, dir } = await staged((folderPath) => {
        writeFileSync(join(folderPath, "assets/a.hasset"), "A-staged");
        server.git(folderPath, "add", "assets/a.hasset");
      });
      await repository.commit({ paths: ["assets/b.hasset"], message: "Mine", author: AUTHOR });
      // The commit put a's entry back; the other app stages it again before the pull.
      server.git(dir, "add", "assets/a.hasset");
      const teammate = server.teammate();
      teammate.write({ "assets/e.hasset": "E" });
      teammate.commitAndPush("Teammate");
      expect(await repository.pull({ author: AUTHOR })).toMatchObject({ kind: "merged" });
      expect(server.git(dir, "show", "HEAD:assets/a.hasset")).toBe("A");
      expect(server.git(dir, "show", "HEAD:assets/e.hasset")).toBe("E");
      expect(text(await storage.readBinary("assets/a.hasset"))).toBe("A-staged");
    });
  });

  it("puts the working files and index back when a pull fails part way, and pulls once the failure is gone", async () => {
    server.seed({ "assets/a.hasset": "A", "assets/b.hasset": "B", "assets/c.hasset": "C" });
    const base = await server.storage();
    let failOn: string | null = null;
    const storage = new Proxy(base, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (property === "writeBinary") {
          return async (path: string, bytes: Uint8Array) => {
            if (path === failOn) throw new Error("No space left on device");
            return (value as ProjectStorage["writeBinary"]).call(target, path, bytes);
          };
        }
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as ProjectStorage;
    const repository = await clone(storage);
    const dir = folder(storage);
    const teammate = server.teammate();
    teammate.write({ "assets/a.hasset": "A-theirs", "assets/b.hasset": "B-theirs", "assets/e.hasset": "E" });
    teammate.remove("assets/c.hasset");
    const remote = teammate.commitAndPush("Teammate");
    // An uncommitted edit the pull is told to replace.
    await storage.writeBinary("assets/a.hasset", encode("A-mine"));
    const head = server.git(dir, "rev-parse", "HEAD").trim();
    const index = server.git(dir, "ls-files", "--stage");

    failOn = "assets/e.hasset";
    await expect(repository.pull({ author: AUTHOR, choices: { "assets/a.hasset": "theirs" } })).rejects.toThrow();
    expect(server.git(dir, "rev-parse", "HEAD").trim()).toBe(head);
    expect(server.git(dir, "ls-files", "--stage")).toBe(index);
    expect(text(await storage.readBinary("assets/a.hasset"))).toBe("A-mine");
    expect(text(await storage.readBinary("assets/b.hasset"))).toBe("B");
    expect(text(await storage.readBinary("assets/c.hasset"))).toBe("C");
    expect(await storage.exists("assets/e.hasset")).toBe(false);
    expect((await repository.status()).changes).toEqual([{ path: "assets/a.hasset", kind: "modified" }]);

    failOn = null;
    expect(await repository.pull({ author: AUTHOR, choices: { "assets/a.hasset": "theirs" } })).toMatchObject({ kind: "fast-forward", head: remote });
    expect(text(await storage.readBinary("assets/a.hasset"))).toBe("A-theirs");
    expect(await storage.exists("assets/c.hasset")).toBe(false);
    expect((await repository.status()).changes).toEqual([]);
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

  it("keeps the history readable when a deepen is cancelled once its pack is stored, through later fetches", async () => {
    for (const message of ["One", "Two", "Three", "Four", "Five"]) server.seed({ "assets/a.hasset": message }, message);
    const controller = new AbortController();
    let armed = false;
    // Cancels while the pack's index is written, letting that write through: the fetch itself then succeeds.
    const storage = new Proxy(await server.storage(), {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== "function") return value;
        if (property !== "writeBinary" && property !== "writeText") return (value as (...args: unknown[]) => unknown).bind(target);
        return (path: string, ...rest: unknown[]) => {
          if (armed && path.endsWith(".idx")) controller.abort();
          return (value as (...args: unknown[]) => unknown).call(target, path, ...rest);
        };
      },
    });
    const repository = await clone(storage);
    armed = true;
    await repository.log({ limit: 2, skip: 1, deepen: true, signal: controller.signal }).catch(() => undefined);
    armed = false;

    await repository.fetch();
    const page = await repository.log({ limit: 5 });
    expect(page.commits[0]?.message).toBe("Five\n");
    expect(page.shallow).toBe(true);
    const older = await repository.log({ limit: 5, deepen: true });
    expect(older.commits.map((commit) => commit.message.trim())).toEqual(["Five", "Four", "Three", "Two", "One"]);
  });

  it("offers older history only when the branch's own history stops at the shallow boundary", async () => {
    server.seed({ "assets/a.hasset": "1" }, "One");
    server.seed({ "assets/a.hasset": "2" }, "Two");
    const teammate = server.teammate();
    teammate.checkout("art");
    teammate.write({ "assets/b.hasset": "B" });
    teammate.commitAndPush("Art", "art");
    teammate.write({ "assets/b.hasset": "B2" });
    const art = teammate.commitAndPush("More art", "art");
    const storage = await server.storage();
    const repository = await clone(storage, { depth: 10 });
    // Switching to a branch only the remote has fetches it one commit deep: the copy is shallow from then on.
    await repository.switchBranch("art");
    expect(await repository.log({ limit: 50 })).toMatchObject({ commits: [{ id: art }], hasMore: true, shallow: true });
    await repository.switchBranch("main");
    expect((await storage.readText(".git/shallow")).trim()).toBe(art);

    server.requests.length = 0;
    for (const options of [{ limit: 50 }, { limit: 50, deepen: true }, { limit: 50, path: "assets/a.hasset", deepen: true }]) {
      const page = await repository.log(options);
      expect(page.commits.map((commit) => commit.message.trim())).toEqual(["Two", "One"]);
      expect(page).toMatchObject({ hasMore: false, shallow: false });
    }
    expect(server.requests.filter((request) => request.origin === GIT_ORIGIN)).toEqual([]);
  });

  it("leaves no shallow boundary at a branch fetched one deep whose parent it already holds", async () => {
    server.seed({ "assets/a.hasset": "1" }, "One");
    server.seed({ "assets/a.hasset": "2" }, "Two");
    const teammate = server.teammate();
    teammate.checkout("art");
    teammate.write({ "assets/b.hasset": "B" });
    teammate.commitAndPush("Art", "art");
    const storage = await server.storage();
    const repository = await clone(storage, { depth: 10 });
    await repository.switchBranch("art");
    expect(await storage.exists(".git/shallow")).toBe(false);
    expect(await repository.log({ limit: 50 })).toMatchObject({ commits: [{ message: "Art\n" }, { message: "Two\n" }, { message: "One\n" }], hasMore: false, shallow: false });
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

  it("reads its packs again after releasing its caches, and not before", async () => {
    server.seed({ "assets/a.hasset": "A" });
    server.seed({ "assets/b.hasset": "B" });
    const { storage, reads } = countingStorage(await server.storage());
    const repository = await clone(storage);
    const packReads = () => reads.filter((path) => path.startsWith(".git/objects/pack/")).length;
    await repository.status();
    reads.length = 0;
    await repository.status();
    expect(packReads()).toBe(0);
    repository.releaseCaches();
    await repository.status();
    expect(packReads()).toBeGreaterThan(0);
    // Under the cap a fetch keeps them too.
    await repository.fetch();
    reads.length = 0;
    await repository.status();
    expect(packReads()).toBe(0);
  });

  it("releases its packs after a fetch once they pass the cap, never after a status", async () => {
    server.seed({ "assets/a.hasset": "A" });
    server.seed({ "assets/b.hasset": "B" });
    const { storage, reads } = countingStorage(await server.storage());
    const repository = await cloneRepository({
      storage, http: server.http, credential: server.credential(), repositoryUrl: REPOSITORY_URL, branch: "main", now: () => NOW, packCacheBytes: 1,
    });
    const packReads = () => reads.filter((path) => path.startsWith(".git/objects/pack/")).length;
    await repository.status();
    reads.length = 0;
    await repository.status();
    expect(packReads()).toBe(0);
    await repository.fetch();
    reads.length = 0;
    await repository.status();
    expect(packReads()).toBeGreaterThan(0);
  });

  it("empties the LFS scratch folder a killed app left when it opens", async () => {
    server.seed({ "assets/a.hasset": "A" });
    const storage = await server.storage();
    await clone(storage);
    // An object downloaded for reading, left when the app was killed before it was read and removed.
    await storage.writeBinary(`.git/lfs/tmp/${"c".repeat(64)}`, blobBytes(1, 4096));
    await openRepository({ storage, http: server.http, credential: server.credential(), repositoryUrl: REPOSITORY_URL, now: () => NOW });
    expect(existsSync(join(folder(storage), ".git/lfs/tmp"))).toBe(false);
  });

  it("reclaims downloads a killed app staged beside the blobs, never one young enough to be in flight", async () => {
    server.seed({ ".gitattributes": RULE, "assets/a.hasset": "A" });
    const storage = await server.storage();
    const repository = await clone(storage);
    const blobs = join(folder(storage), "assets/.blobs");
    mkdirSync(blobs, { recursive: true });
    const killed = ".haptic-0f8fad5b-d9cb-469f-a165-70867728950e.tmp";
    const running = ".haptic-7c9e6679-7425-40de-944b-e07fc1f90ae7.tmp";
    writeFileSync(join(blobs, killed), "partial");
    writeFileSync(join(blobs, running), "streaming");
    // The killed one was last written an hour ago; the running one moments ago.
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(join(blobs, killed), hourAgo, hourAgo);

    // Remove Unused Files offers it with the rest...
    expect(await repository.removableLfsObjects({ references: () => [] })).toEqual([`assets/.blobs/${killed}`]);
    // ...and opening the copy removes it.
    await openRepository({ storage, http: server.http, credential: server.credential(), repositoryUrl: REPOSITORY_URL });
    expect(readdirSync(blobs).sort()).toEqual([running]);
  });

  it("types refused credentials, missing repositories and unreachable hosts", async () => {
    server.seed({ "assets/a.hasset": "A" });
    // The saved sign-in is refused: said so, apart from a 403 (no access) or no sign-in at all.
    expect(await rejection(clone(undefined, { token: "wrong" }))).toMatchObject({ kind: "auth", code: "credential-refused", status: 401 });
    const signedOut = cloneRepository({ storage: await server.storage(), http: server.http, credential: { current: async () => null, renew: async () => null }, repositoryUrl: REPOSITORY_URL, branch: "main" });
    expect(await rejection(signedOut)).toMatchObject({ kind: "auth", code: "no-credential" });
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

/** Clones over the test server's native file transfer (Node streams, as the desktop main process runs them) unless `files` replaces it. */
function cloneNative(storage: ProjectStorage, options: { signal?: AbortSignal; files?: FileTransferClient } = {}) {
  return clone(storage, { ...options, files: options.files ?? server.files(storage) });
}

/** What went through JavaScript storage under `.blobs`. */
/** LFS objects read or written through JavaScript storage (not the `.gitignore` lookups Git makes in every folder). */
const blobIo = (paths: readonly string[]) => paths.filter((path) => /\.blobs\/[0-9a-f]{64}$/.test(path));

/**
 * LFS objects travel through native HTTP as whole bodies (the web build's
 * path, and any host without a file transfer) or through the host's native
 * file transfer. Both must give the same repository; the native one must
 * move no object byte through JavaScript storage.
 */
describe.each(["whole-body", "native"] as const)("GitRepository's LFS objects over %s transfers", { timeout: 60_000 }, (transport) => {
  const native = transport === "native";
  const cloneOver = (storage: ProjectStorage) => (native ? cloneNative(storage) : clone(storage));

  it("clones shallow with LFS objects downloaded, and reads no unchanged file for status", async () => {
    const texture = blobBytes(1, 300_000);
    server.seed({ ".gitattributes": RULE, "project.json": "{}\n", "assets/a.hasset": "A" });
    server.seed({ "assets/b.hasset": "B", [blobPath(texture)]: texture });
    const { storage, reads, writes } = countingStorage(await server.storage());
    const repository = await cloneOver(storage);
    expect(blobIo(writes)).toEqual(native ? [] : [blobPath(texture)]);
    expect(repository.lastOperation.transfer.received).toBeGreaterThanOrEqual(300_000);

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

  it("pushes after uploading only the LFS objects the server lacks, never sending the stored credential to the store", async () => {
    const kept = blobBytes(4, 50_000);
    server.seed({ ".gitattributes": RULE, "assets/a.hasset": "A", [blobPath(kept)]: kept });
    const { storage, reads } = countingStorage(await server.storage());
    const repository = await cloneOver(storage);
    const added = blobBytes(5, 120_000);
    await storage.writeBinary(blobPath(added), added);
    // The same object under a plugin's content root: the server already has it.
    await storage.writeBinary(blobPath(kept, "plugins/p/assets"), kept);
    await storage.writeBinary("assets/a.hasset", encode("A2"));
    const { commit } = await repository.commit({ paths: [blobPath(added), blobPath(kept, "plugins/p/assets"), "assets/a.hasset"], message: "Add", author: AUTHOR });
    server.requests.length = 0;
    reads.length = 0;

    expect(await repository.push()).toEqual({ head: commit, uploaded: 1 });
    expect(blobIo(reads)).toEqual(native ? [] : [blobPath(added)]);
    expect(repository.lastOperation.transfer.sent).toBeGreaterThanOrEqual(120_000);
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

  it("fast-forwards, writing incoming files and downloading only LFS objects that are missing", async () => {
    const kept = blobBytes(6, 40_000);
    server.seed({ ".gitattributes": RULE, "assets/a.hasset": "A", "assets/b.hasset": "B", [blobPath(kept)]: kept });
    const { storage, writes } = countingStorage(await server.storage());
    const repository = await cloneOver(storage);
    const teammate = server.teammate();
    const added = blobBytes(7, 90_000);
    teammate.write({ "assets/a.hasset": "A2", "assets/new.hasset": "N", [blobPath(added)]: added, [blobPath(kept, "plugins/p/assets")]: kept });
    teammate.remove("assets/b.hasset");
    const remote = teammate.commitAndPush("Teammate");
    // Already on this device (another content root holds the same object): never downloaded.
    await storage.writeBinary(blobPath(kept, "plugins/p/assets"), kept);
    server.requests.length = 0;
    writes.length = 0;

    const result = await repository.pull({ author: AUTHOR });
    expect(result).toEqual({
      kind: "fast-forward",
      head: remote,
      changedPaths: [blobPath(added), "assets/a.hasset", "assets/b.hasset", "assets/new.hasset", blobPath(kept, "plugins/p/assets")],
    });
    expect(blobIo(writes)).toEqual(native ? [] : [blobPath(added)]);
    expect(text(await storage.readBinary("assets/a.hasset"))).toBe("A2");
    expect(await storage.exists("assets/b.hasset")).toBe(false);
    expect(await storage.readBinary(blobPath(added))).toEqual(added);
    expect(server.requests.filter((request) => request.origin === STORAGE_ORIGIN).map((request) => request.path)).toEqual([`/objects/${blobPath(added).slice(-64)}`]);
    expect((await repository.status()).changes).toEqual([]);
    expect(server.git(folder(storage), "rev-parse", "HEAD").trim()).toBe(remote);
  });

  it("reads a file as a commit holds it, and an LFS object's own bytes, leaving nothing behind", async () => {
    const texture = blobBytes(8, 10_000);
    const first = server.seed({ ".gitattributes": RULE, "assets/a.hasset": "A", [blobPath(texture)]: texture });
    const storage = await server.storage();
    const repository = await cloneOver(storage);
    await storage.writeBinary("assets/a.hasset", encode("A2"));
    await repository.commit({ paths: ["assets/a.hasset"], message: "Edit", author: AUTHOR });

    expect(text(await repository.readFile("assets/a.hasset", first))).toBe("A");
    expect(await repository.readFile(blobPath(texture), first)).toEqual(texture);
    await storage.remove(blobPath(texture));
    expect(await repository.readFile(blobPath(texture), first)).toEqual(texture);
    expect(await repository.readLfsObject(blobPath(texture), texture.byteLength)).toEqual(texture);
    expect(await repository.readFile("assets/missing.hasset", first)).toBeNull();
    // Never written to the working tree; a native download's scratch file is gone once read.
    expect(await storage.exists(blobPath(texture))).toBe(false);
    const scratch = join(folder(storage), ".git/lfs/tmp");
    expect(existsSync(scratch) ? readdirSync(scratch) : []).toEqual([]);
  });

  it("downloads missing LFS objects into their files, through JavaScript only without a native transfer", async () => {
    const texture = blobBytes(9, 64_000);
    const mesh = blobBytes(11, 32_000);
    server.seed({ ".gitattributes": RULE, [blobPath(texture)]: texture, [blobPath(mesh)]: mesh });
    const { storage, reads, writes } = countingStorage(await server.storage());
    const repository = await cloneOver(storage);
    await storage.remove(blobPath(texture));
    // A damaged copy: another size, so it is downloaded again without being read.
    await storage.writeBinary(blobPath(mesh), mesh.slice(0, 100));
    server.requests.length = 0;
    reads.length = 0;
    writes.length = 0;

    const files = [{ path: blobPath(texture), size: texture.byteLength }, { path: blobPath(mesh), size: mesh.byteLength }];
    await repository.downloadLfsObjects(files);
    expect(await storage.readBinary(blobPath(texture))).toEqual(texture);
    expect(await storage.readBinary(blobPath(mesh))).toEqual(mesh);
    expect(blobIo(reads)).toEqual([blobPath(texture), blobPath(mesh)]);
    expect(blobIo(writes)).toEqual(native ? [] : [blobPath(texture), blobPath(mesh)]);
    expect((await repository.status()).changes).toEqual([]);
    // A present file of the object's size is never fetched again.
    await repository.downloadLfsObjects(files);
    expect(server.requests.filter((request) => request.origin === STORAGE_ORIGIN)).toHaveLength(2);
  });

  it("reads a working copy's LFS file only when it has the object's size", async () => {
    const texture = blobBytes(12, 20_000);
    server.seed({ ".gitattributes": RULE, [blobPath(texture)]: texture });
    const { storage, reads } = countingStorage(await server.storage());
    const repository = await cloneOver(storage);
    await storage.writeBinary(blobPath(texture), texture.slice(0, 10));
    reads.length = 0;
    expect(await repository.readLfsObject(blobPath(texture), texture.byteLength)).toEqual(texture);
    expect(blobIo(reads)).toEqual([]);
  });
});

describe("GitRepository's LFS objects over the native file transfer", { timeout: 60_000 }, () => {
  it("leaves no object or temporary file when a clone is cancelled mid-download", async () => {
    const texture = blobBytes(10, 4 * 1024 * 1024);
    server.seed({ ".gitattributes": RULE, "project.json": "{}\n", [blobPath(texture)]: texture });
    const storage = await server.storage();
    const controller = new AbortController();
    const files = server.files(storage);
    let progressed = 0;
    // Cancel once the first bytes are on disk, as Cancel in the Clone dialog would.
    const cancelling: FileTransferClient = (request) => files({
      ...request,
      onProgress: (bytes) => {
        progressed = bytes;
        controller.abort();
      },
    });

    const error = await rejection(cloneNative(storage, { files: cancelling, signal: controller.signal }));
    expect(error.kind).toBe("cancelled");
    expect(progressed).toBeGreaterThan(0);
    // On disk: the adapter's listings hide staged `.haptic-*.tmp` files.
    expect(readdirSync(join(folder(storage), "assets/.blobs"))).toEqual([]);
  });

  it("refuses an object that arrives damaged and keeps no file of it", async () => {
    const texture = blobBytes(11, 20_000);
    server.seed({ ".gitattributes": RULE, [blobPath(texture)]: texture });
    // The store now holds other bytes under the object's name.
    server.objects.set(blobPath(texture).slice(-64), blobBytes(12, 20_000));
    const storage = await server.storage();

    const error = await rejection(cloneNative(storage));
    expect([error.kind, error.code]).toEqual(["lfs", "lfs-object-corrupt"]);
    // On disk: the adapter's listings hide staged `.haptic-*.tmp` files.
    expect(readdirSync(join(folder(storage), "assets/.blobs"))).toEqual([]);
  });
});
