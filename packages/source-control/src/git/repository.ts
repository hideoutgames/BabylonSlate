import * as git from "isomorphic-git";
import type { HttpClient as IsoHttpClient, WalkerEntry } from "isomorphic-git";
import { isStorageNotFound, type ProjectStorage } from "@haptic/core";
import { authorizedHttp, type CredentialSource } from "../credentials";
import type { HttpClient } from "../http";
import { parseRepositoryUrl, repositoryCloneUrl } from "../lfs-endpoint";
import { gitBlobSha1, lfsObjectId, parseLfsPointer } from "../lfs-pointer";
import { planPull } from "../pull-plan";
import {
  hasLfsRule,
  INCOMING_LIMIT,
  SyncError,
  type CommitAuthor,
  type CommitInfo,
  type CommitInput,
  type CommitResult,
  type FileChange,
  type LogOptions,
  type LogPage,
  type PullInput,
  type PullResult,
  type PushResult,
  type RemoteState,
  type SyncPort,
  type SyncStatus,
} from "../sync-port";
import { installBufferGlobal } from "./buffer-global";
import { toSyncError } from "./errors";
import { gitHttp, type TransferCounters } from "./git-http";
import { relate, type CommitNode, type Relation } from "./history";
import { LfsTransfer, type LfsObject } from "./lfs-transfer";
import { GITDIR, StorageFs, storagePath, WORKTREE, type StorageFsCounters } from "./storage-fs";

/** Clones fetch one commit; history deepens on demand. */
export const DEFAULT_CLONE_DEPTH = 1;
/** Commits fetched per deepen while looking for a merge base, doubling each time. */
const DEEPEN_STEP = 50;
const MAX_DEEPENS = 4;
/** Markers a new project folder may hold before a clone. */
const CLONE_IGNORES = new Set([".haptic-creating", ".DS_Store", "Thumbs.db", "desktop.ini"]);

export interface GitRepositoryOptions {
  /** Bound to the project folder, which is the repository root (`.git` beside `assets/`). */
  storage: ProjectStorage;
  /** Native HTTP; credentials are added only for the repository's origin. */
  http: HttpClient;
  credential: CredentialSource;
  /** The configured remote (HTTPS, SSH or scp-style; Git always uses its HTTPS form). */
  repositoryUrl: string;
  branch: string;
  /** Commit times; tests pass a fixed clock. */
  now?: () => number;
}

/** What the last operation cost, for the benchmark. */
export interface OperationCounters {
  storage: StorageFsCounters;
  transfer: TransferCounters;
}

interface Op {
  fs: StorageFs;
  git: { fs: StorageFs; dir: string; gitdir: string; cache: object };
  http: IsoHttpClient;
  lfs: LfsTransfer;
}

interface Incoming {
  path: string;
  base: string | null;
  theirs: string | null;
  head: string | null;
}

type StatusRow = [string, 0 | 1, 0 | 1 | 2, 0 | 1 | 2 | 3];

function changeOf([path, head, workdir]: StatusRow): FileChange | null {
  if (workdir === 2) return { path, kind: head === 0 ? "added" : "modified" };
  if (workdir === 0 && head === 1) return { path, kind: "deleted" };
  return null;
}

function parentOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

async function blobOid(entry: WalkerEntry | null | undefined): Promise<string | null> {
  return entry && (await entry.type()) === "blob" ? ((await entry.oid()) ?? null) : null;
}

/** Opens the Git working copy already in `storage`. */
export async function openRepository(options: GitRepositoryOptions): Promise<GitRepository> {
  installBufferGlobal();
  return new GitRepository(options);
}

/**
 * Makes the project folder `storage` is bound to a new working copy with no
 * commits, whose `origin` is `repositoryUrl` (Publish: the first push creates
 * the remote branch). A folder that already has `.git` is refused.
 */
export async function initRepository(options: GitRepositoryOptions): Promise<GitRepository> {
  installBufferGlobal();
  const repository = new GitRepository(options);
  await repository.init();
  return repository;
}

/** Clones `repositoryUrl`'s branch into the empty project folder `storage` is bound to. */
export async function cloneRepository(options: GitRepositoryOptions & { depth?: number }): Promise<GitRepository> {
  installBufferGlobal();
  const repository = new GitRepository(options);
  await repository.clone(options.depth ?? DEFAULT_CLONE_DEPTH);
  return repository;
}

/**
 * The project folder's Git working copy through isomorphic-git, with `.blobs`
 * files as Git LFS objects (see `StorageFs`). Operations run one at a time.
 * Clones are shallow and single-branch; history deepens on demand.
 */
export class GitRepository implements SyncPort {
  readonly branch: string;
  /** Storage and network traffic of the last finished operation. */
  lastOperation: OperationCounters = {
    storage: { workingReads: 0, pointerReads: 0, smudgedPointers: 0 },
    transfer: { sent: 0, received: 0 },
  };
  private readonly storage: ProjectStorage;
  private readonly http: HttpClient;
  private readonly authorized: HttpClient;
  private readonly credential: CredentialSource;
  private readonly repositoryUrl: string;
  private readonly url: string;
  private readonly now: () => number;
  /** isomorphic-git's object and index cache: packs are immutable and the index is checked by stat. */
  private readonly cache = {};
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: GitRepositoryOptions) {
    const location = parseRepositoryUrl(options.repositoryUrl);
    if (!location) throw new SyncError("not-found", `Invalid repository URL: ${options.repositoryUrl}`);
    this.url = repositoryCloneUrl(location);
    this.repositoryUrl = options.repositoryUrl;
    this.branch = options.branch;
    this.storage = options.storage;
    this.http = options.http;
    this.credential = options.credential;
    this.authorized = authorizedHttp(options.credential, options.http, "basic");
    this.now = options.now ?? Date.now;
  }

  private get localRef() {
    return `refs/heads/${this.branch}`;
  }

  private get remoteRef() {
    return `refs/remotes/origin/${this.branch}`;
  }

  /** @internal Use `cloneRepository`. */
  clone(depth: number): Promise<void> {
    return this.run(async (op) => {
      const existing = (await this.storage.readdir("")).filter((entry) => !CLONE_IGNORES.has(entry.name));
      if (existing.length > 0) throw new SyncError("conflict", "A clone needs an empty project folder.", { code: "not-empty" });
      await git.clone({ ...op.git, http: op.http, url: this.url, ref: this.branch, singleBranch: true, depth, noCheckout: true, noTags: true });
      // Project storage keeps no file modes.
      await git.setConfig({ ...op.git, path: "core.filemode", value: false });
      const head = await this.resolve(op, this.localRef);
      if (!head) throw new SyncError("not-found", `The repository has no branch ${this.branch}.`);
      await this.downloadMissing(op, head, null);
      await git.checkout({ ...op.git, ref: this.branch, force: true });
    });
  }

  /** @internal Use `initRepository`. */
  init(): Promise<void> {
    return this.run(async (op) => {
      if (await this.storage.exists(".git/HEAD")) {
        throw new SyncError("conflict", "This folder already has a Git repository.", { code: "repository-exists" });
      }
      await git.init({ ...op.git, defaultBranch: this.branch });
      await git.addRemote({ ...op.git, remote: "origin", url: this.url });
      // Project storage keeps no file modes.
      await git.setConfig({ ...op.git, path: "core.filemode", value: false });
    });
  }

  status(): Promise<SyncStatus> {
    return this.run(async (op) => {
      const rows = (await git.statusMatrix({ ...op.git })) as StatusRow[];
      return {
        branch: this.branch,
        head: await this.resolve(op, this.localRef),
        changes: rows.map(changeOf).filter((change): change is FileChange => change !== null),
      };
    });
  }

  commit({ paths, message, author }: CommitInput): Promise<CommitResult> {
    return this.run(async (op) => {
      const selected = [...new Set(paths.map(storagePath))].filter((path) => path !== "").sort();
      if (selected.length === 0) throw new Error("Choose the files to commit.");
      const rows = new Map(((await git.statusMatrix({ ...op.git, filepaths: selected })) as StatusRow[]).map((row) => [row[0], row]));
      const changed = selected.filter((path) => rows.get(path)?.[2] === 2);
      const removed = selected.filter((path) => rows.get(path)?.[1] === 1 && rows.get(path)?.[2] === 0);
      if (changed.some((path) => lfsObjectId(path) !== null)) {
        await this.requireLfsRule(op, changed.includes(".gitattributes") ? "working" : removed.includes(".gitattributes") ? "removed" : "head");
      }
      if (changed.length > 0) await git.add({ ...op.git, filepath: changed });
      for (const path of removed) await git.remove({ ...op.git, filepath: path });
      const signature = this.signature(author);
      const commit = await git.commit({ ...op.git, message, author: signature, committer: signature, disallowEmpty: true });
      return { commit };
    });
  }

  fetch(): Promise<RemoteState> {
    return this.run(async (op) => {
      await this.fetchBranch(op);
      const local = await this.resolve(op, this.localRef);
      const remote = await this.resolve(op, this.remoteRef);
      if (!local) {
        const incoming = remote ? (await this.relation(op, remote, null)).ahead : [];
        return { branch: this.branch, local, remote, ahead: 0, behind: incoming.length, incoming: await this.commitInfos(op, incoming) };
      }
      const relation = await this.relation(op, local, remote);
      return {
        branch: this.branch,
        local,
        remote,
        ahead: relation.ahead.length,
        behind: relation.behind.length,
        incoming: await this.commitInfos(op, relation.behind),
      };
    });
  }

  outgoing(): Promise<string[]> {
    return this.run(async (op) => {
      const local = await this.resolve(op, this.localRef);
      const remote = await this.resolve(op, this.remoteRef);
      if (!local || local === remote) return [];
      const trees = [git.TREE({ ref: local }), ...(remote ? [git.TREE({ ref: remote })] : [])];
      const paths = (await git.walk({
        ...op.git,
        trees,
        map: async (path, [mine, theirs]) => {
          if (path === ".") return undefined;
          const mineId = mine ? await mine.oid() : null;
          // The same id on both sides: nothing below it differs.
          if (mineId === (theirs ? await theirs.oid() : null)) return null;
          const isBlob = (await blobOid(mine)) !== null || (await blobOid(theirs)) !== null;
          return isBlob ? path : undefined;
        },
      })) as string[];
      return paths.sort();
    });
  }

  pull({ author, choices = {} }: PullInput): Promise<PullResult> {
    return this.run(async (op) => {
      await this.fetchBranch(op);
      const local = await this.resolve(op, this.localRef);
      const remote = await this.resolve(op, this.remoteRef);
      if (!remote || remote === local) return { kind: "up-to-date", head: local };
      let base: string | null = null;
      let fastForward = true;
      if (local) {
        const relation = await this.relation(op, local, remote);
        if (relation.behind.length === 0) return { kind: "up-to-date", head: local };
        if (!relation.base) {
          throw new SyncError("conflict", "The remote branch shares no history with this copy.", { code: "unrelated-histories" });
        }
        base = relation.base;
        fastForward = relation.ahead.length === 0;
      }

      const incoming = await this.incoming(op, base, remote, local);
      const mine = await this.workingOids(op, incoming);
      const { conflicts, writes, kept, ready } = planPull(incoming.map((entry) => ({ ...entry, mine: mine.get(entry.path) ?? null })), choices);
      if (!ready) return { kind: "conflicts", conflicts };

      await this.downloadMissing(op, remote, new Set(writes));
      if (writes.length > 0) await git.checkout({ ...op.git, ref: remote, filepaths: writes, force: true, noUpdateHead: true });
      if (fastForward) {
        // The index follows the new HEAD; a kept file then reads as an uncommitted change.
        const theirs = new Map(incoming.map((entry) => [entry.path, entry.theirs]));
        for (const path of kept) {
          const oid = theirs.get(path);
          if (oid) await git.updateIndex({ ...op.git, filepath: path, oid, add: true });
          else await git.updateIndex({ ...op.git, filepath: path, remove: true, force: true });
        }
        await git.writeRef({ ...op.git, ref: this.localRef, value: remote, force: true });
        return { kind: "fast-forward", head: remote, changedPaths: writes };
      }
      const signature = this.signature(author);
      const head = await git.commit({
        ...op.git,
        message: `Merge remote-tracking branch 'origin/${this.branch}'`,
        author: signature,
        committer: signature,
        parent: [local!, remote],
      });
      return { kind: "merged", head, changedPaths: writes };
    });
  }

  push(options: { remoteBranch?: string } = {}): Promise<PushResult> {
    return this.run(async (op) => {
      const head = await this.resolve(op, this.localRef);
      if (!head) throw new SyncError("not-found", "There is nothing to push yet.");
      const remoteBranch = options.remoteBranch ?? this.branch;
      // A new remote branch starts from what the tracked branch already has on the server.
      const remote = (await this.resolve(op, `refs/remotes/origin/${remoteBranch}`)) ?? (await this.resolve(op, this.remoteRef));
      const { ahead } = await this.relation(op, head, remote);
      const objects = await this.introducedObjects(op, ahead);
      const uploaded = await op.lfs.upload([...objects.values()].map(({ object }) => object), async (object) => {
        const path = objects.get(object.oid)!.path;
        try {
          const bytes = await this.storage.readBinary(path);
          if (bytes.byteLength === object.size) return bytes;
        } catch (error) {
          if (!isStorageNotFound(error)) throw error;
        }
        throw new SyncError("lfs", `${path} is missing, so it cannot be uploaded.`, { code: "lfs-object-missing" });
      });
      await git.push({ ...op.git, http: op.http, remote: "origin", ref: this.branch, remoteRef: remoteBranch });
      return { head, uploaded };
    });
  }

  readFile(path: string, commit: string): Promise<Uint8Array | null> {
    return this.run(async (op) => {
      let blob: Uint8Array;
      try {
        blob = (await git.readBlob({ ...op.git, oid: commit, filepath: storagePath(path) })).blob;
      } catch (error) {
        if ((error as { code?: unknown }).code === "NotFoundError") return null;
        throw error;
      }
      const pointer = lfsObjectId(path) ? parseLfsPointer(blob) : null;
      if (!pointer) return blob;
      // An LFS object never changes under its name, so the working copy's file is the commit's.
      try {
        const local = await this.storage.readBinary(storagePath(path));
        if (local.byteLength === pointer.size) return local;
      } catch (error) {
        if (!isStorageNotFound(error)) throw error;
      }
      let downloaded: Uint8Array | null = null;
      await op.lfs.download([pointer], async (_object, bytes) => {
        downloaded = bytes;
      });
      return downloaded;
    });
  }

  log({ limit, path, deepen = false }: LogOptions): Promise<LogPage> {
    return this.run(async (op) => {
      const read = async (): Promise<CommitInfo[]> => {
        try {
          const entries = await git.log({ ...op.git, ref: this.localRef, depth: limit, ...(path ? { filepath: storagePath(path) } : {}) });
          return entries.map(({ oid, commit }) => ({
            id: oid,
            message: commit.message,
            author: { name: commit.author.name, email: commit.author.email },
            timestamp: commit.author.timestamp,
            parents: commit.parent,
          }));
        } catch (error) {
          if ((error as { code?: unknown }).code === "NotFoundError") return [];
          throw error;
        }
      };
      let commits = await read();
      let shallow = (await this.shallowCommits()).size > 0;
      if (deepen && commits.length < limit && shallow) {
        await this.fetchBranch(op, limit);
        commits = await read();
        shallow = (await this.shallowCommits()).size > 0;
      }
      return { commits, hasMore: commits.length >= limit || shallow };
    });
  }

  private run<T>(work: (op: Op) => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const fs = new StorageFs(this.storage);
      const transfer: TransferCounters = { sent: 0, received: 0 };
      const op: Op = {
        fs,
        git: { fs, dir: WORKTREE, gitdir: GITDIR, cache: this.cache },
        http: gitHttp(this.authorized, transfer),
        lfs: new LfsTransfer({ repositoryUrl: this.repositoryUrl, branch: this.branch, http: this.http, credential: this.credential, counters: transfer }),
      };
      try {
        return await work(op);
      } catch (error) {
        throw toSyncError(error);
      } finally {
        this.lastOperation = { storage: { ...fs.counters }, transfer };
      }
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private signature(author: CommitAuthor) {
    const now = this.now();
    return { name: author.name, email: author.email, timestamp: Math.floor(now / 1000), timezoneOffset: new Date(now).getTimezoneOffset() };
  }

  private async resolve(op: Op, ref: string): Promise<string | null> {
    try {
      return await git.resolveRef({ ...op.git, ref });
    } catch (error) {
      if ((error as { code?: unknown }).code === "NotFoundError") return null;
      throw error;
    }
  }

  private async fetchBranch(op: Op, deepen?: number): Promise<void> {
    await git.fetch({
      ...op.git,
      http: op.http,
      remote: "origin",
      ref: this.branch,
      singleBranch: true,
      tags: false,
      ...(deepen ? { depth: deepen, relative: true } : {}),
    });
  }

  private async shallowCommits(): Promise<Set<string>> {
    try {
      const text = new TextDecoder().decode(await this.storage.readBinary(".git/shallow"));
      return new Set(text.split("\n").filter((line) => /^[0-9a-f]{40}$/.test(line)));
    } catch (error) {
      if (isStorageNotFound(error)) return new Set();
      throw error;
    }
  }

  /** The newest of `oids` (at most `INCOMING_LIMIT`), newest first, as the log lists commits. */
  private async commitInfos(op: Op, oids: readonly string[]): Promise<CommitInfo[]> {
    const commits: CommitInfo[] = [];
    for (const oid of oids) {
      const { commit } = await git.readCommit({ ...op.git, oid });
      commits.push({
        id: oid,
        message: commit.message,
        author: { name: commit.author.name, email: commit.author.email },
        timestamp: commit.author.timestamp,
        parents: commit.parent,
      });
    }
    return commits.sort((a, b) => b.timestamp - a.timestamp).slice(0, INCOMING_LIMIT);
  }

  private async commitNode(op: Op, oid: string): Promise<CommitNode | null> {
    try {
      const { commit } = await git.readCommit({ ...op.git, oid });
      return { parents: commit.parent, timestamp: commit.committer.timestamp };
    } catch (error) {
      if ((error as { code?: unknown }).code === "NotFoundError") return null;
      throw error;
    }
  }

  /** Splits the history; a fork older than the shallow history deepens it a bounded number of times. */
  private async relation(op: Op, local: string, remote: string | null): Promise<Relation> {
    for (let attempt = 0; ; attempt += 1) {
      const relation = await relate(local, remote, (oid) => this.commitNode(op, oid), await this.shallowCommits());
      if (!remote || relation.base || !relation.truncated || attempt >= MAX_DEEPENS) return relation;
      await this.fetchBranch(op, DEEPEN_STEP * 2 ** attempt);
    }
  }

  /** Files the remote changed since `base`, with their base, remote and local commit ids. */
  private async incoming(op: Op, base: string | null, remote: string, head: string | null): Promise<Incoming[]> {
    const trees = [git.TREE({ ref: remote }), ...(base ? [git.TREE({ ref: base })] : []), ...(head ? [git.TREE({ ref: head })] : [])];
    const result = await git.walk({
      ...op.git,
      trees,
      map: async (path, entries) => {
        if (path === ".") return undefined;
        const theirsEntry = entries[0];
        const baseEntry = base ? entries[1] : null;
        const headEntry = head ? entries[base ? 2 : 1] : null;
        const theirsId = theirsEntry ? await theirsEntry.oid() : null;
        const baseId = baseEntry ? await baseEntry.oid() : null;
        // Identical on both sides: nothing below it came in.
        if (theirsId === baseId) return null;
        const theirs = await blobOid(theirsEntry);
        const baseBlob = await blobOid(baseEntry);
        if (theirs === null && baseBlob === null) return undefined;
        return { path, base: baseBlob, theirs, head: await blobOid(headEntry) } satisfies Incoming;
      },
    });
    return result as Incoming[];
  }

  /** The working tree's blob id for each incoming path (null when absent), hashing only files whose stats changed. */
  private async workingOids(op: Op, incoming: readonly Incoming[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (incoming.length === 0) return out;
    const paths = incoming.map((entry) => entry.path);
    const rows = new Map(((await git.statusMatrix({ ...op.git, filepaths: paths })) as StatusRow[]).map((row) => [row[0], row]));
    for (const entry of incoming) {
      const row = rows.get(entry.path);
      if (!row || row[2] === 0) out.set(entry.path, null);
      else if (row[2] === 1) out.set(entry.path, entry.head);
      else out.set(entry.path, await gitBlobSha1((await op.fs.promises.readFile(entry.path)) as Uint8Array));
    }
    return out;
  }

  /** The LFS objects `commit` holds (only under `paths` when given), by working tree path. */
  private async lfsEntries(op: Op, commit: string, paths: ReadonlySet<string> | null): Promise<Map<string, LfsObject>> {
    const ancestors = new Set<string>();
    for (const path of paths ?? []) for (let dir = parentOf(path); dir !== ""; dir = parentOf(dir)) ancestors.add(dir);
    const found = new Map<string, LfsObject>();
    await git.walk({
      ...op.git,
      trees: [git.TREE({ ref: commit })],
      map: async (path, [entry]) => {
        if (path === ".") return undefined;
        if (paths && !paths.has(path) && !ancestors.has(path)) return null;
        if (!entry || (await entry.type()) !== "blob" || !lfsObjectId(path)) return undefined;
        const pointer = parseLfsPointer((await entry.content()) ?? new Uint8Array());
        if (pointer) found.set(path, pointer);
        return undefined;
      },
    });
    return found;
  }

  /** Downloads the LFS objects of `commit` (under `paths`) whose files are missing; present files are never read. */
  private async downloadMissing(op: Op, commit: string, paths: ReadonlySet<string> | null): Promise<void> {
    const wanted = await this.lfsEntries(op, commit, paths);
    const pathsByOid = new Map<string, string[]>();
    const missing: LfsObject[] = [];
    for (const [path, object] of wanted) {
      const stat = await op.fs.stat(path).catch(() => null);
      if (stat && stat.isFile() && stat.size === object.size) continue;
      if (!pathsByOid.has(object.oid)) missing.push(object);
      pathsByOid.set(object.oid, [...(pathsByOid.get(object.oid) ?? []), path]);
    }
    if (missing.length === 0) return;
    await op.lfs.download(missing, async (object, bytes) => {
      for (const path of pathsByOid.get(object.oid)!) {
        await this.storage.mkdir(parentOf(path), true);
        await this.storage.writeBinary(path, bytes);
      }
    });
  }

  /** LFS objects the given commits add, against their first parent (all of a root's), by oid. */
  private async introducedObjects(op: Op, commits: readonly string[]): Promise<Map<string, { path: string; object: LfsObject }>> {
    const out = new Map<string, { path: string; object: LfsObject }>();
    for (const oid of commits) {
      const node = await this.commitNode(op, oid);
      const parent = node?.parents[0] && (await this.commitNode(op, node.parents[0])) ? node.parents[0] : null;
      const trees = [git.TREE({ ref: oid }), ...(parent ? [git.TREE({ ref: parent })] : [])];
      await git.walk({
        ...op.git,
        trees,
        map: async (path, [entry, before]) => {
          if (path === ".") return undefined;
          const id = entry ? await entry.oid() : null;
          if (!entry || id === (before ? await before.oid() : null)) return null;
          if ((await entry.type()) !== "blob" || !lfsObjectId(path)) return undefined;
          const pointer = parseLfsPointer((await entry.content()) ?? new Uint8Array());
          if (pointer && !out.has(pointer.oid)) out.set(pointer.oid, { path, object: pointer });
          return undefined;
        },
      });
    }
    return out;
  }

  /** `.blobs` files may be committed only where `.gitattributes`, as the commit will hold it, stores them through LFS. */
  private async requireLfsRule(op: Op, source: "working" | "removed" | "head"): Promise<void> {
    let text = "";
    if (source === "working") {
      text = new TextDecoder().decode(await this.storage.readBinary(".gitattributes"));
    } else if (source === "head") {
      const head = await this.resolve(op, this.localRef);
      if (head) {
        try {
          text = new TextDecoder().decode((await git.readBlob({ ...op.git, oid: head, filepath: ".gitattributes" })).blob);
        } catch (error) {
          if ((error as { code?: unknown }).code !== "NotFoundError") throw error;
        }
      }
    }
    if (!hasLfsRule(text)) {
      throw new SyncError("lfs", "Add the .blobs rule to .gitattributes before committing asset blobs.", { code: "missing-lfs-rule" });
    }
  }
}
