import * as git from "isomorphic-git";
import type { CommitObject, HttpClient as IsoHttpClient, WalkerEntry } from "isomorphic-git";
import { isStorageNotFound, PROJECT_CREATION_MARKER, type ProjectStorage } from "@haptic/core";
import { authorizedHttp, type CredentialSource } from "../credentials";
import type { FileTransferClient, HttpClient } from "../http";
import { parseRepositoryUrl, repositoryCloneUrl } from "../lfs-endpoint";
import { gitBlobSha1, lfsObjectId, parseLfsPointer } from "../lfs-pointer";
import { planPull } from "../pull-plan";
import {
  cancelledError,
  hasLfsRule,
  INCOMING_LIMIT,
  isValidBranchName,
  SyncError,
  throwIfCancelled,
  uncommittedChangesError,
  type ChangeKind,
  type CommitAuthor,
  type CommitInfo,
  type CommitInput,
  type CommitResult,
  type FileChange,
  type LfsFile,
  type LogOptions,
  type LogPage,
  type PullInput,
  type PullResult,
  type PushResult,
  type RemoteState,
  type RemovableLfsOptions,
  type SwitchResult,
  type SyncPort,
  type SyncStatus,
  type TransferOptions,
} from "../sync-port";
import { ADOPTION_CONFIG } from "./adoption";
import { installBufferGlobal } from "./buffer-global";
import { toSyncError } from "./errors";
import { cancellableFiles, cancellableHttp, gitHttp, type TransferCounters } from "./git-http";
import { relate, type CommitNode, type Relation } from "./history";
import { LfsTransfer, type LfsObject } from "./lfs-transfer";
import { GITDIR, StorageFs, storagePath, WORKTREE, type StorageFsCounters } from "./storage-fs";

/** Clones fetch one commit; history deepens on demand. */
export const DEFAULT_CLONE_DEPTH = 1;
/** Commits fetched per deepen while looking for a merge base, doubling each time. */
const DEEPEN_STEP = 50;
const MAX_DEEPENS = 4;
/** Markers a new project folder may hold before a clone. */
const CLONE_IGNORES = new Set([PROJECT_CREATION_MARKER, ".DS_Store", "Thumbs.db", "desktop.ini"]);
/**
 * Where a native transfer lands an object `readFile` or `readLfsObject`
 * hands over (never the working tree, which would keep a file no asset
 * uses): read, then removed. git-lfs's own temporary folder.
 */
const LFS_SCRATCH = ".git/lfs/tmp";

export interface GitRepositoryOptions {
  /** Bound to the project folder, which is the repository root (`.git` beside `assets/`). */
  storage: ProjectStorage;
  /** Native HTTP; credentials are added only for the repository's origin. */
  http: HttpClient;
  /**
   * The host's native file transfer, bound to the same project folder: LFS
   * objects then stream between the server and their working files, never
   * entering JavaScript. Without one they cross whole through `http`.
   */
  files?: FileTransferClient;
  credential: CredentialSource;
  /** The configured remote (HTTPS, SSH or scp-style; Git always uses its HTTPS form). */
  repositoryUrl: string;
  /** The branch to clone or start; an opened copy is on the branch its HEAD names. */
  branch: string;
  /** Commit times; tests pass a fixed clock. */
  now?: () => number;
  /** The pack cache's cap (`MAX_PACK_CACHE_BYTES`); tests pass a small one. */
  packCacheBytes?: number;
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
  /** Commits read so far: the history walk's reads serve the incoming list too. */
  commits: Map<string, CommitObject>;
}

interface Incoming {
  path: string;
  base: string | null;
  theirs: string | null;
  head: string | null;
}

type StatusRow = [string, 0 | 1, 0 | 1 | 2, 0 | 1 | 2 | 3];

/** What a failed pull puts back (`GitRepository.pullCheckpoint`). */
interface PullCheckpoint {
  /** `.git/index` as it was; null when there was none. */
  index: Uint8Array | null;
  /** Each working file the pull may write: its version then (null when absent) and the blob id the pull writes (null: it removes it). */
  files: Array<{ path: string; theirs: string | null; was: null | { oid: string } | { bytes: Uint8Array } }>;
}

/** The working file differs from HEAD's. */
function workingChanged([, head, workdir]: StatusRow): boolean {
  return workdir === 2 || (workdir === 0 && head === 1);
}

/** The index entry differs from HEAD's (another Git app, or an interrupted operation, staged it). */
function stagedChanged([, head, , stage]: StatusRow): boolean {
  return head === 0 ? stage !== 0 : stage !== 1;
}

/**
 * The index differs from both HEAD and the working file (`MM`, `AM`, `AD`,
 * `MD`, or a staged deletion of a file still there), so the change list
 * cannot show what a plain `git commit` would record: it is marked staged.
 */
function stagedOnly([, head, workdir, stage]: StatusRow): boolean {
  return stage === 3 || (stage === 0 && head === 1 && workdir !== 0);
}

/**
 * The index holds content that is in neither HEAD nor the working file
 * (STAGE 3): putting its entry back to HEAD would lose that staged version.
 * Any other entry (HEAD's, the working file's, or absent) resets losslessly.
 */
function stagedUnique(row: StatusRow): boolean {
  return row[3] === 3;
}

function changeOf(row: StatusRow): FileChange | null {
  const [path, head, workdir, stage] = row;
  const staged = stagedOnly(row) ? { staged: true as const } : {};
  if (workdir === 2) return { path, kind: head === 0 ? "added" : "modified", ...staged };
  if (workdir === 0 && head === 1) return { path, kind: "deleted", ...staged };
  if (!stagedChanged(row)) return null;
  // The working file is HEAD's (or absent from both); only the index differs, so the change is the index's.
  return { path, kind: head === 0 ? "added" : stage === 0 ? "deleted" : "modified", staged: true };
}

/** At most this many bytes of packs stay in isomorphic-git's cache after an operation that reads history or the network. */
export const MAX_PACK_CACHE_BYTES = 32 * 1024 * 1024;

function parentOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/**
 * The working files a checkout of `writes` changes: an LFS object's file the
 * target lacks (`target` gives each path's id there, null when absent) stays,
 * since `StorageFs` never removes one; it is only untracked.
 */
function writtenPaths(writes: readonly string[], target: ReadonlyMap<string, string | null>): string[] {
  return writes.filter((path) => !(lfsObjectId(path) && target.get(path) === null));
}

async function blobOid(entry: WalkerEntry | null | undefined): Promise<string | null> {
  return entry && (await entry.type()) === "blob" ? ((await entry.oid()) ?? null) : null;
}

/** A file that differs between two commits. */
interface Differing {
  path: string;
  /** Blob ids, null when absent. */
  from: string | null;
  to: string | null;
}

/**
 * Opens the Git working copy already in `storage`, on the branch its HEAD
 * names: the checked-out branch is this device's, never the project's. A
 * detached HEAD (another Git app left it) is refused, since commits would
 * move no branch.
 */
export async function openRepository(options: Omit<GitRepositoryOptions, "branch">): Promise<GitRepository> {
  installBufferGlobal();
  const branch = await git.currentBranch({ fs: new StorageFs(options.storage), gitdir: GITDIR });
  if (!branch) {
    throw new SyncError("conflict", "This working copy has no branch checked out. Check out a branch with the Git app that left it, then open the project again.", { code: "detached-head" });
  }
  // Objects downloaded for reading are removed once read; one is left only when the app was killed first.
  // Nothing reads the folder before an operation runs. A failure leaves it to the next open.
  if (await options.storage.exists(LFS_SCRATCH).catch(() => false)) await options.storage.remove(LFS_SCRATCH).catch(() => undefined);
  return new GitRepository({ ...options, branch });
}

/**
 * Makes the project folder `storage` is bound to a new working copy with no
 * commits, whose `origin` is `repositoryUrl` (Publish: the first push creates
 * the remote branch), adopted as Haptic's. A folder that already has `.git` is
 * refused, unless `replace` (the caller decided the `.git` is an interrupted
 * Publish's) removes it first.
 */
export async function initRepository(options: GitRepositoryOptions & { replace?: boolean }): Promise<GitRepository> {
  installBufferGlobal();
  const repository = new GitRepository(options);
  await repository.init(options.replace ?? false);
  return repository;
}

/**
 * Clones `repositoryUrl`'s branch into the empty project folder `storage` is
 * bound to, adopted as Haptic's. A cancel (download or checkout) rejects with
 * `cancelled`; the caller removes the folder.
 */
export async function cloneRepository(options: GitRepositoryOptions & TransferOptions & { depth?: number }): Promise<GitRepository> {
  installBufferGlobal();
  const repository = new GitRepository(options);
  await repository.clone(options.depth ?? DEFAULT_CLONE_DEPTH, options.signal);
  return repository;
}

/**
 * The project folder's Git working copy through isomorphic-git, with `.blobs`
 * files as Git LFS objects (see `StorageFs`). Operations run one at a time.
 * Clones are shallow and single-branch; history deepens on demand.
 */
export class GitRepository implements SyncPort {
  /** Storage and network traffic of the last finished operation. */
  lastOperation: OperationCounters = {
    storage: { workingReads: 0, pointerReads: 0, smudgedPointers: 0 },
    transfer: { sent: 0, received: 0 },
  };
  private readonly storage: ProjectStorage;
  private readonly http: HttpClient;
  private readonly files: FileTransferClient | null;
  private readonly credential: CredentialSource;
  private readonly repositoryUrl: string;
  private readonly url: string;
  private readonly now: () => number;
  /**
   * isomorphic-git's object and index cache: packs are immutable and the
   * index is checked by stat. It holds every pack an operation read, whole,
   * until `releaseCaches` replaces it: when the app goes to the background,
   * and after an operation that reads history or the network (fetch, pull,
   * push, log, branches) once the packs it holds pass `packCacheBytes`. Status
   * and commit never release it, so repeated status calls keep their packs.
   */
  private cache: object = {};
  /** Pack bytes read into `cache` since it was last replaced. */
  private cachedPackBytes = 0;
  private readonly packCacheBytes: number;
  private queue: Promise<unknown> = Promise.resolve();
  /** The checked-out branch: HEAD's, moved only by a switch or a new branch. */
  private current: string;

  constructor(options: GitRepositoryOptions) {
    const location = parseRepositoryUrl(options.repositoryUrl);
    if (!location) throw new SyncError("not-found", `Invalid repository URL: ${options.repositoryUrl}`);
    this.url = repositoryCloneUrl(location);
    this.repositoryUrl = options.repositoryUrl;
    this.current = options.branch;
    this.storage = options.storage;
    this.http = options.http;
    this.files = options.files ?? null;
    this.credential = options.credential;
    this.now = options.now ?? Date.now;
    this.packCacheBytes = options.packCacheBytes ?? MAX_PACK_CACHE_BYTES;
  }

  get branch(): string {
    return this.current;
  }

  private get localRef() {
    return `refs/heads/${this.current}`;
  }

  private get remoteRef() {
    return `refs/remotes/origin/${this.current}`;
  }

  /** @internal Use `cloneRepository`. */
  clone(depth: number, signal?: AbortSignal): Promise<void> {
    return this.run(async (op) => {
      const existing = (await this.storage.readdir("")).filter((entry) => !CLONE_IGNORES.has(entry.name));
      if (existing.length > 0) throw new SyncError("conflict", "A clone needs an empty project folder.", { code: "not-empty" });
      await git.clone({ ...op.git, http: op.http, url: this.url, ref: this.current, singleBranch: true, depth, noCheckout: true, noTags: true });
      await this.configureNew(op);
      const head = await this.resolve(op, this.localRef);
      if (!head) throw new SyncError("not-found", `The repository has no branch ${this.current}.`);
      await this.downloadMissing(op, head, null);
      await git.checkout({ ...op.git, ref: this.current, force: true });
      // Checkout starts every write at once, so the last ones can land after a cancel.
      throwIfCancelled(signal);
    }, signal);
  }

  /** @internal Use `initRepository`. */
  init(replace: boolean): Promise<void> {
    return this.run(async (op) => {
      if (replace) {
        if (await this.storage.exists(".git")) await this.storage.remove(".git");
      } else if (await this.storage.exists(".git/HEAD")) {
        throw new SyncError("conflict", "This folder already has a Git repository.", { code: "repository-exists" });
      }
      await git.init({ ...op.git, defaultBranch: this.current });
      await git.addRemote({ ...op.git, remote: "origin", url: this.url });
      await this.configureNew(op);
    });
  }

  /** A working copy Haptic made: project storage keeps no file modes, and the copy is Haptic's (`ADOPTION_CONFIG`). */
  private async configureNew(op: Op): Promise<void> {
    await git.setConfig({ ...op.git, path: "core.filemode", value: false });
    await git.setConfig({ ...op.git, path: ADOPTION_CONFIG, value: true });
  }

  status(): Promise<SyncStatus> {
    return this.run(async (op) => {
      const rows = (await git.statusMatrix({ ...op.git })) as StatusRow[];
      return {
        branch: this.current,
        head: await this.resolve(op, this.localRef),
        changes: rows.map(changeOf).filter((change): change is FileChange => change !== null),
      };
    });
  }

  /**
   * Commits the working files of exactly `paths`. Index entries another Git
   * app (or an interrupted operation) staged for other paths are put back to
   * HEAD first, so they are never committed; one whose staged version exists
   * nowhere else (STAGE 3) refuses the commit before anything changes, since
   * putting it back would lose it. Nothing is written before every check passed.
   */
  commit({ paths, message, author }: CommitInput): Promise<CommitResult> {
    return this.run(async (op) => {
      const selected = [...new Set(paths.map(storagePath))].filter((path) => path !== "").sort();
      if (selected.length === 0) throw new Error("Choose the files to commit.");
      const head = await this.resolve(op, this.localRef);
      const rows = new Map(((await git.statusMatrix({ ...op.git, filepaths: selected })) as StatusRow[]).map((row) => [row[0], row]));
      const selectedRows = selected.flatMap((path) => {
        const row = rows.get(path);
        return row ? [row] : [];
      });
      if (!selectedRows.some(workingChanged)) {
        throw new SyncError("conflict", "The chosen files already match the last commit.", { code: "nothing-to-commit" });
      }
      const chosen = new Set(selected);
      const others = await this.stagedOutside(op, head, (path) => chosen.has(path));
      const changed = selectedRows.filter((row) => row[2] === 2).map(([path]) => path);
      const removed = selectedRows.filter((row) => row[2] === 0 && (row[1] === 1 || row[3] !== 0)).map(([path]) => path);
      // Working file as HEAD has it, index not: the commit records the working file.
      const restaged = selectedRows.filter((row) => row[2] === 1 && stagedChanged(row)).map(([path]) => path);
      if (changed.some((path) => lfsObjectId(path) !== null)) {
        await this.requireLfsRule(op, changed.includes(".gitattributes") ? "working" : removed.includes(".gitattributes") ? "removed" : "head");
      }
      await this.resetIndexEntries(op, head, [...others, ...restaged]);
      if (changed.length > 0) await git.add({ ...op.git, filepath: changed });
      for (const path of removed) await git.remove({ ...op.git, filepath: path });
      const signature = this.signature(author);
      const commit = await git.commit({ ...op.git, message, author: signature, committer: signature, disallowEmpty: true });
      return { commit };
    });
  }

  /**
   * Paths outside `inside` whose index entry differs from `commit`'s tree
   * (every entry when there is no commit), from the tree and the index alone:
   * no working file is read. Refuses, as `staged-elsewhere`, when one of them
   * holds a staged version found in neither `commit` nor its working file.
   */
  private async stagedOutside(op: Op, commit: string | null, inside: (path: string) => boolean): Promise<string[]> {
    const trees = commit ? [git.TREE({ ref: commit }), git.STAGE()] : [git.STAGE()];
    const found = (await git.walk({
      ...op.git,
      trees,
      map: async (path, entries) => {
        if (path === ".") return undefined;
        const [tree, stage] = commit ? entries : [null, entries[0]];
        const treeType = tree ? await tree.type() : null;
        const stageType = stage ? await stage.type() : null;
        if (treeType === "tree" && stageType === "tree") return undefined;
        // A file on one side and a folder on the other: no single entry to put back, so it counts as staged work to keep.
        if (treeType === "tree" || stageType === "tree") return { path, mixed: true };
        const treeOid = tree ? ((await tree.oid()) ?? null) : null;
        const stageOid = stage ? ((await stage.oid()) ?? null) : null;
        return treeOid === stageOid ? null : { path, mixed: false };
      },
    })) as Array<{ path: string; mixed: boolean }>;
    const outside = found.filter(({ path }) => !inside(path));
    const paths = outside.filter(({ mixed }) => !mixed).map(({ path }) => path);
    const unique = outside.filter(({ mixed }) => mixed).map(({ path }) => path);
    if (paths.length > 0) {
      const rows = (await git.statusMatrix({ ...op.git, ...(commit ? { ref: commit } : {}), filepaths: paths })) as StatusRow[];
      const wanted = new Set(paths);
      unique.push(...rows.filter((row) => wanted.has(row[0]) && stagedUnique(row)).map(([path]) => path));
    }
    unique.sort();
    if (unique.length > 0) {
      throw new SyncError(
        "conflict",
        `Another Git app staged versions of ${unique.join(", ")} that are in neither the last commit nor the working files. Commit or unstage them in that app first.`,
        { code: "staged-elsewhere", paths: unique },
      );
    }
    return paths;
  }

  /** Puts each path's index entry back to `commit`'s (removed when it has none); working files are never touched. */
  private async resetIndexEntries(op: Op, commit: string | null, paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      if (commit) await git.resetIndex({ ...op.git, filepath: path, ref: commit });
      else await git.remove({ ...op.git, filepath: path });
    }
  }

  fetch(options: TransferOptions = {}): Promise<RemoteState> {
    return this.run(async (op) => {
      await this.fetchBranch(op);
      return this.state(op, true);
    }, options.signal, true);
  }

  remoteState(): Promise<RemoteState> {
    return this.run((op) => this.state(op, false));
  }

  outgoing(options: TransferOptions = {}): Promise<string[]> {
    return this.run(async (op) => {
      await this.refreshRemoteHeads(op);
      const local = await this.resolve(op, this.localRef);
      const remote = await this.resolve(op, this.remoteRef);
      if (!local || local === remote) return [];
      // What a push sends: the branch's work since it left what the remote holds (its own branch, or before its first push every branch the remote has).
      const { base } = await this.relation(op, local, remote ? [remote] : await this.remoteHeads(op), false);
      return (await this.differing(op, base, local)).map((entry) => entry.path);
    }, options.signal, true);
  }

  pull({ author, choices = {}, signal }: PullInput): Promise<PullResult> {
    return this.run(async (op) => {
      await this.fetchBranch(op);
      const local = await this.resolve(op, this.localRef);
      const remote = await this.resolve(op, this.remoteRef);
      if (!remote || remote === local) return { kind: "up-to-date", head: local };
      let base: string | null = null;
      let fastForward = true;
      if (local) {
        const relation = await this.relation(op, local, [remote]);
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
      const byPath = new Map(incoming.map((entry) => [entry.path, entry]));
      const pulled = new Set([...writes, ...kept]);
      // A merge commits the index: what another app staged elsewhere must not ride along (refused before any change when it would be lost).
      const staged = fastForward ? [] : await this.stagedOutside(op, local, (path) => pulled.has(path));

      await this.downloadMissing(op, remote, new Set(writes));
      const checkpoint = await this.pullCheckpoint(op, writes.map((path) => byPath.get(path)!), mine);
      try {
        await this.resetIndexEntries(op, local, staged);
        if (writes.length > 0) await git.checkout({ ...op.git, ref: remote, filepaths: writes, force: true, noUpdateHead: true });
        const theirs = new Map(incoming.map((entry) => [entry.path, entry.theirs]));
        const changedPaths = writtenPaths(writes, theirs);
        // A kept file stays in the working tree. Its index entry takes what the branch records: the remote's version when only
        // the working file differed (the branch never changed it, so the edit stays an uncommitted change against the result), else
        // this branch's committed version (a merge keeps it). A fast-forward has no commits of its own, so always the remote's.
        for (const path of kept) {
          const entry = byPath.get(path)!;
          const oid = fastForward || entry.head === entry.base ? entry.theirs : entry.head;
          if (oid) await git.updateIndex({ ...op.git, filepath: path, oid, add: true });
          else await git.updateIndex({ ...op.git, filepath: path, remove: true, force: true });
        }
        if (fastForward) {
          await git.writeRef({ ...op.git, ref: this.localRef, value: remote, force: true });
          return { kind: "fast-forward", head: remote, changedPaths };
        }
        const signature = this.signature(author);
        const head = await git.commit({
          ...op.git,
          message: `Merge remote-tracking branch 'origin/${this.current}'`,
          author: signature,
          committer: signature,
          parent: [local!, remote],
        });
        return { kind: "merged", head, changedPaths };
      } catch (error) {
        // HEAD moves last: one that moved means the pull finished, so nothing is undone.
        if ((await this.resolve(op, this.localRef).catch(() => local)) === local) await this.rollBack(checkpoint);
        throw error;
      }
    }, signal, true);
  }

  /**
   * What a pull's rollback restores, recorded before it changes anything: the
   * index file's bytes, and for each working file it may write (LFS objects
   * excepted: one is never rewritten, and a new one is only untracked) the
   * version there now. A file at a committed version is recorded by its blob
   * id, which the object store keeps; only an uncommitted edit the pull
   * replaces (a "theirs" choice) is held as bytes.
   */
  private async pullCheckpoint(op: Op, writes: readonly Incoming[], mine: ReadonlyMap<string, string | null>): Promise<PullCheckpoint> {
    const index = await this.storage.readBinary(".git/index").catch((error: unknown) => {
      if (isStorageNotFound(error)) return null;
      throw error;
    });
    const files: PullCheckpoint["files"] = [];
    for (const entry of writes) {
      if (lfsObjectId(entry.path)) continue;
      const current = mine.get(entry.path) ?? null;
      if (current === null) files.push({ path: entry.path, theirs: entry.theirs, was: null });
      else if (current === entry.head || current === entry.base) files.push({ path: entry.path, theirs: entry.theirs, was: { oid: current } });
      else files.push({ path: entry.path, theirs: entry.theirs, was: { bytes: (await op.fs.promises.readFile(entry.path)) as Uint8Array } });
    }
    return { index, files };
  }

  /**
   * Puts back what `pullCheckpoint` recorded, through storage directly (a
   * cancelled operation's own writes are refused). Only a file that holds
   * what the pull wrote, or that the pull may have made, is put back: one
   * changed since by anything else is left as it is. Every file is tried;
   * the first failure is rethrown after the rest.
   */
  private async rollBack(checkpoint: PullCheckpoint): Promise<void> {
    const failures: unknown[] = [];
    const fs = new StorageFs(this.storage);
    for (const { path, theirs, was } of checkpoint.files) {
      try {
        if (await this.storage.exists(path)) {
          const now = await gitBlobSha1((await fs.promises.readFile(path)) as Uint8Array);
          // Still as recorded (the pull never reached it), or changed by something else since: left as it is.
          if (was && "oid" in was && now === was.oid) continue;
          if (now !== theirs) continue;
        } else if (was === null) {
          continue;
        }
        if (was === null) await this.storage.remove(path);
        else if ("bytes" in was) await this.storage.writeBinary(path, was.bytes);
        else await this.storage.writeBinary(path, (await git.readBlob({ fs, dir: WORKTREE, gitdir: GITDIR, oid: was.oid })).blob);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      if (checkpoint.index) await this.storage.writeBinary(".git/index", checkpoint.index);
      else if (await this.storage.exists(".git/index")) await this.storage.remove(".git/index");
    } catch (error) {
      failures.push(error);
    }
    // The index changed under the cache's stat check; the next operation reads it afresh.
    this.releaseCaches();
    if (failures.length > 0) throw failures[0];
  }

  push(options: TransferOptions & { remoteBranch?: string } = {}): Promise<PushResult> {
    return this.run(async (op) => {
      const head = await this.resolve(op, this.localRef);
      if (!head) throw new SyncError("not-found", "There is nothing to push yet.");
      const remoteBranch = options.remoteBranch ?? this.current;
      // A new remote branch starts from what the remote's other branches already hold.
      const remote = await this.resolve(op, `refs/remotes/origin/${remoteBranch}`);
      const { ahead } = await this.relation(op, head, remote ? [remote] : await this.remoteHeads(op), remoteBranch === this.current && remote !== null);
      const objects = await this.introducedObjects(op, ahead);
      // Uploads read the working file (there is no `.git/lfs` store), found by its stats, never read here.
      const uploaded = await op.lfs.upload([...objects.values()].map(({ object }) => object), async (object) => {
        const path = objects.get(object.oid)!.path;
        try {
          const stat = await this.storage.stat(path);
          if (!stat.isDir && stat.size === object.size) return path;
        } catch (error) {
          if (!isStorageNotFound(error)) throw error;
        }
        throw new SyncError("lfs", `${path} is missing, so it cannot be uploaded.`, { code: "lfs-object-missing" });
      });
      await git.push({ ...op.git, http: op.http, remote: "origin", ref: this.current, remoteRef: remoteBranch });
      // The first push of a branch makes the remote's its upstream, as `git push -u` does.
      if (remoteBranch === this.current && !(await git.getConfig({ ...op.git, path: `branch.${this.current}.merge` }))) {
        await this.setUpstream(op, this.current);
      }
      return { head, uploaded };
    }, options.signal, true);
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
      return this.lfsObject(op, path, pointer);
    });
  }

  readLfsObject(path: string, size: number, options: TransferOptions = {}): Promise<Uint8Array> {
    return this.run(async (op) => {
      const oid = lfsObjectId(path);
      if (!oid) throw new Error(`${path} is not an LFS object.`);
      return this.lfsObject(op, path, { oid, size });
    }, options.signal);
  }

  /**
   * An object's bytes: the working copy's file when it has the size (an
   * object never changes under its name), else a download, never written to
   * the working tree (a native one lands in `LFS_SCRATCH` and is removed
   * once read).
   */
  private async lfsObject(op: Op, path: string, object: LfsObject): Promise<Uint8Array> {
    const stat = await this.storage.stat(storagePath(path)).catch((error: unknown) => {
      if (isStorageNotFound(error)) return null;
      throw error;
    });
    // Read only a file of the object's size (or of a size the storage cannot tell): another is damaged and downloaded instead.
    if (stat && !stat.isDir && (stat.size === object.size || stat.size === null)) {
      const local = await this.storage.readBinary(storagePath(path));
      if (local.byteLength === object.size) return local;
    }
    return op.lfs.read(object, `${LFS_SCRATCH}/${object.oid}`);
  }

  downloadLfsObjects(files: readonly LfsFile[], options: TransferOptions = {}): Promise<void> {
    return this.run(async (op) => {
      const wanted = new Map<string, LfsObject>();
      for (const { path, size } of files) {
        const oid = lfsObjectId(path);
        if (!oid) throw new Error(`${path} is not an LFS object.`);
        wanted.set(storagePath(path), { oid, size });
      }
      await this.downloadInto(op, wanted);
      // The batch may leave out an object it lacks; the caller relies on every file being there.
      for (const [path, object] of wanted) {
        const stat = await this.storage.stat(path).catch(() => null);
        if (!stat || stat.isDir || stat.size !== object.size) {
          throw new SyncError("lfs", `The server has no LFS object ${object.oid}.`, { code: "lfs-object-missing" });
        }
      }
    }, options.signal);
  }

  releaseCaches(): void {
    // A running operation keeps the cache it started with; the next one starts empty.
    this.cache = {};
    this.cachedPackBytes = 0;
  }

  removableLfsObjects({ signal, references }: RemovableLfsOptions): Promise<string[]> {
    return this.run(async (op) => {
      // Untracked: no HEAD entry and no index entry (a staged file has one). An untracked file is never hashed.
      const rows = (await git.statusMatrix({ ...op.git, filter: (path) => lfsObjectId(path) !== null })) as StatusRow[];
      const untracked = rows.filter(([, head, workdir, stage]) => head === 0 && workdir === 2 && stage === 0).map(([path]) => path);
      if (untracked.length === 0) return [];
      const held = await this.heldByUnpushed(op, untracked, signal);
      const loose = untracked.filter((path) => !held.has(path));
      if (loose.length === 0) return [];
      const needed = await this.neededByCommittedAssets(op, loose, references, signal);
      return loose.filter((path) => !needed.has(path)).sort();
    }, signal, true);
  }

  /**
   * Which of `paths` a committed `.hasset` names (`references`) while its
   * commit holds no object of that name in their folders (one it holds was
   * committed, so a push uploaded it, or the unpushed rule keeps it). Every
   * commit local history holds is walked, from the local and remote-tracking
   * branches to the shallow boundary; each `.hasset` it changed against its
   * first parent (every one of a commit whose parent this copy lacks) is read
   * once per version, and a commit's tree only along the folders of `paths`,
   * once a version names one of them.
   */
  private async neededByCommittedAssets(
    op: Op,
    paths: readonly string[],
    references: RemovableLfsOptions["references"],
    signal?: AbortSignal,
  ): Promise<Set<string>> {
    const byName = new Map<string, string[]>();
    for (const path of paths) {
      const name = path.slice(path.lastIndexOf("/") + 1);
      byName.set(name, [...(byName.get(name) ?? []), path]);
    }
    const candidateFolders = [...new Set(paths.map(parentOf))];
    const shallow = await this.shallowCommits();
    const queue = [...(await this.remoteHeads(op))];
    for (const name of await git.listBranches({ ...op.git })) {
      const head = await this.resolve(op, `refs/heads/${name}`);
      if (head) queue.push(head);
    }
    const seen = new Set<string>();
    const named = new Map<string, readonly string[]>();
    const needed = new Set<string>();
    while (queue.length > 0 && needed.size < paths.length) {
      throwIfCancelled(signal);
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = await this.readCommit(op, oid);
      if (!commit) continue;
      const first = commit.parent[0];
      const parent = first && !shallow.has(oid) && (await this.readCommit(op, first)) ? first : null;
      if (!shallow.has(oid)) queue.push(...commit.parent);
      let held: Set<string> | null = null;
      for (const { path, to } of await this.differing(op, parent, oid)) {
        if (to === null || !path.endsWith(".hasset")) continue;
        let names = named.get(to);
        if (!names) {
          names = references(path, (await git.readBlob({ ...op.git, oid: to })).blob);
          named.set(to, names);
        }
        for (const name of names) {
          const candidates = byName.get(name);
          if (!candidates) continue;
          if (!held) {
            held = new Set();
            for (const folder of candidateFolders) for (const entry of await this.treeEntries(op, oid, folder)) held.add(entry);
          }
          if (!held.has(name)) for (const candidate of candidates) needed.add(candidate);
        }
      }
    }
    return needed;
  }

  /**
   * Which of `paths` a commit of a local branch holds that no
   * remote-tracking branch reaches (a branch never pushed: every commit),
   * from local refs only. Each such commit's tree is read only along the
   * folders of `paths`.
   */
  private async heldByUnpushed(op: Op, paths: readonly string[], signal?: AbortSignal): Promise<Set<string>> {
    const wanted = new Map<string, Set<string>>();
    for (const path of paths) {
      const folder = parentOf(path);
      wanted.set(folder, (wanted.get(folder) ?? new Set()).add(path.slice(folder.length + 1)));
    }
    const remotes = await this.remoteHeads(op);
    const read = new Set<string>();
    const held = new Set<string>();
    for (const name of await git.listBranches({ ...op.git })) {
      const head = await this.resolve(op, `refs/heads/${name}`);
      if (!head) continue;
      for (const commit of (await this.relation(op, head, remotes, false)).ahead) {
        throwIfCancelled(signal);
        if (read.has(commit)) continue;
        read.add(commit);
        for (const [folder, names] of wanted) {
          for (const entry of await this.treeEntries(op, commit, folder)) {
            if (names.has(entry)) held.add(`${folder}/${entry}`);
          }
        }
      }
    }
    return held;
  }

  /** The names in `folder` of `commit`'s tree; none when it has no such folder. */
  private async treeEntries(op: Op, commit: string, folder: string): Promise<string[]> {
    try {
      return (await git.readTree({ ...op.git, oid: commit, filepath: folder })).tree.map((entry) => entry.path);
    } catch (error) {
      if ((error as { code?: unknown }).code === "NotFoundError") return [];
      throw error;
    }
  }

  log({ limit, skip = 0, path, deepen = false, signal }: LogOptions): Promise<LogPage> {
    return this.run(async (op) => {
      // isomorphic-git walks from HEAD each time; the pages before are read again (from its object cache) and left out.
      const read = async (): Promise<CommitInfo[]> => {
        try {
          const entries = await git.log({ ...op.git, ref: this.localRef, depth: skip + limit, ...(path ? { filepath: storagePath(path) } : {}) });
          // A path's log that stops at `depth` adds the commit it stopped at, which need not change the path.
          return entries.slice(skip, skip + limit).map(({ oid, commit }) => ({
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
      // Older history exists only past a boundary this branch's walk reached, not wherever the copy is shallow (another branch fetched one deep).
      const atBoundary = async (page: readonly CommitInfo[]) => page.length < limit && (await this.reachesShallow(op));
      let commits = await read();
      let shallow = await atBoundary(commits);
      if (deepen && shallow) {
        await this.fetchBranch(op, { deepen: limit });
        commits = await read();
        shallow = await atBoundary(commits);
      }
      return { commits, hasMore: commits.length === limit || shallow, shallow };
    }, signal, true);
  }

  /**
   * Whether the branch's history, walked from its head, reaches a commit
   * whose parents this copy lacks (listed in `.git/shallow`, or missing).
   * Read only when a page ended early, so the walk is the one the log made,
   * from the object cache.
   */
  private async reachesShallow(op: Op): Promise<boolean> {
    const shallow = await this.shallowCommits();
    if (shallow.size === 0) return false;
    const head = await this.resolve(op, this.localRef);
    const queue = head ? [head] : [];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (shallow.has(oid)) return true;
      const commit = await this.readCommit(op, oid);
      if (!commit) return true;
      queue.push(...commit.parent);
    }
    return false;
  }

  commitChanges(commit: string): Promise<FileChange[] | null> {
    return this.run(async (op) => {
      const node = await this.readCommit(op, commit);
      if (!node) throw new SyncError("not-found", `This copy has no commit ${commit}.`);
      const parent = node.parent[0] ?? null;
      if (parent && ((await this.shallowCommits()).has(commit) || !(await this.readCommit(op, parent)))) return null;
      return (await this.differing(op, parent, commit)).map(({ path, from, to }) => ({ path, kind: (from === null ? "added" : to === null ? "deleted" : "modified") satisfies ChangeKind }));
    });
  }

  localBranches(): Promise<string[]> {
    return this.run(async (op) => (await git.listBranches({ ...op.git })).sort());
  }

  remoteBranches(options: TransferOptions = {}): Promise<string[]> {
    return this.run(async (op) => {
      const refs = await git.listServerRefs({ http: op.http, url: this.url, prefix: "refs/heads/" });
      return refs.map((entry) => entry.ref.slice("refs/heads/".length)).filter((name) => name !== "").sort();
    }, options.signal);
  }

  createBranch(name: string): Promise<void> {
    return this.run(async (op) => {
      if (!isValidBranchName(name)) throw new SyncError("conflict", `"${name}" is not a valid branch name.`, { code: "invalid-branch-name" });
      if (!(await this.resolve(op, this.localRef))) throw new SyncError("not-found", "Commit something before starting a branch.");
      if (await this.resolve(op, `refs/heads/${name}`)) throw new SyncError("conflict", `There is already a branch named ${name}.`, { code: "branch-exists" });
      await git.branch({ ...op.git, ref: name, checkout: true });
      this.current = name;
    });
  }

  branchCommit(name: string, options: TransferOptions = {}): Promise<string | null> {
    return this.run(async (op) => {
      const local = await this.resolve(op, `refs/heads/${name}`);
      if (local) return local;
      // As a switch to it fetches it: its newest commit, older history on demand.
      if (!(await this.fetchBranch(op, { branch: name, depth: DEFAULT_CLONE_DEPTH }))) return null;
      return this.resolve(op, `refs/remotes/origin/${name}`);
    }, options.signal, true);
  }

  switchBranch(name: string, options: TransferOptions = {}): Promise<SwitchResult> {
    return this.run(async (op) => {
      const head = await this.resolve(op, this.localRef);
      if (name === this.current) return { head, changedPaths: [] };
      const local = await this.resolve(op, `refs/heads/${name}`);
      // A branch only the remote has comes as a clone's does: its newest commit, older history on demand.
      if (!local && !(await this.fetchBranch(op, { branch: name, depth: DEFAULT_CLONE_DEPTH }))) {
        throw new SyncError("not-found", `There is no branch ${name}.`);
      }
      const target = local ?? (await this.resolve(op, `refs/remotes/origin/${name}`));
      if (!target) throw new SyncError("not-found", `There is no branch ${name}.`);

      const differing = await this.differing(op, head, target);
      const working = await this.workingOids(op, differing.map(({ path, from, to }) => ({ path, base: null, theirs: to, head: from })));
      const mine = (path: string) => working.get(path) ?? null;
      // A file the switch replaces must hold what one of the branches holds; anything else is work it would lose.
      const blocked = differing.filter(({ path, from, to }) => mine(path) !== from && mine(path) !== to).map(({ path }) => path);
      if (blocked.length > 0) throw uncommittedChangesError(name, blocked);

      // An LFS object's file the target lacks stays, untracked: it may be the only copy of an unpushed commit's object.
      // One already there is the object the target names (by name and size), so it is taken as it is.
      const writes = differing.filter(({ path, to }) => mine(path) !== to).map(({ path }) => path);
      await this.downloadMissing(op, target, new Set(writes));
      if (writes.length > 0) await git.checkout({ ...op.git, ref: target, filepaths: writes, force: true, noUpdateHead: true });
      // A file that already holds the other branch's version keeps it; only its index entry moves.
      for (const { path, to } of differing) {
        if (mine(path) !== to) continue;
        if (to) await git.updateIndex({ ...op.git, filepath: path, oid: to, add: true });
        else await git.updateIndex({ ...op.git, filepath: path, remove: true, force: true });
      }
      if (!local) {
        await git.writeRef({ ...op.git, ref: `refs/heads/${name}`, value: target });
        await this.setUpstream(op, name);
      }
      await git.writeRef({ ...op.git, ref: "HEAD", value: `refs/heads/${name}`, symbolic: true, force: true });
      this.current = name;
      return { head: target, changedPaths: writtenPaths(writes, new Map(differing.map(({ path, to }) => [path, to]))) };
    }, options.signal, true);
  }

  /**
   * Runs `work` after the operations before it. Once `signal` aborts, requests
   * and working tree writes are refused and the operation rejects as
   * `cancelled`, whatever the refusal looked like on its way out.
   */
  private run<T>(work: (op: Op) => Promise<T>, signal?: AbortSignal, trimCache = false): Promise<T> {
    const result = this.queue.then(async () => {
      throwIfCancelled(signal);
      const fs = new StorageFs(this.storage, signal);
      const cache = this.cache;
      const transfer: TransferCounters = { sent: 0, received: 0 };
      const http = cancellableHttp(this.http, signal);
      const op: Op = {
        fs,
        git: { fs, dir: WORKTREE, gitdir: GITDIR, cache },
        http: gitHttp(authorizedHttp(this.credential, http, "basic"), transfer),
        lfs: new LfsTransfer({
          repositoryUrl: this.repositoryUrl,
          branch: this.current,
          http,
          credential: this.credential,
          storage: this.storage,
          ...(this.files ? { files: cancellableFiles(this.files, signal) } : {}),
          counters: transfer,
        }),
        commits: new Map(),
      };
      try {
        return await work(op);
      } catch (error) {
        if (signal?.aborted) throw cancelledError();
        throw toSyncError(error);
      } finally {
        this.lastOperation = { storage: { ...fs.counters }, transfer };
        // Counted only while the cache read into is still the current one (a release meanwhile left it).
        if (cache === this.cache) {
          this.cachedPackBytes += fs.packBytes;
          if (trimCache && this.cachedPackBytes > this.packCacheBytes) this.releaseCaches();
        }
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

  /**
   * Fetches `branch` (the checked-out one by default): `deepen` commits older
   * than this copy's oldest, or a branch new to this copy `depth` deep. The
   * shallow list and the remote-tracking ref change only once the pack is
   * stored (`objectsFirst`), so a cancelled fetch leaves history as it was.
   * Resolves false when the remote has no such branch (not pushed yet, or
   * deleted there), whose remote-tracking ref then goes, as `git fetch
   * --prune` drops it.
   */
  private async fetchBranch(op: Op, options: { branch?: string; deepen?: number; depth?: number } = {}): Promise<boolean> {
    const branch = options.branch ?? this.current;
    const remoteRef = `refs/heads/${branch}`;
    const shallowBefore = await this.shallowCommits();
    try {
      await op.fs.objectsFirst(() => git.fetch({
        ...op.git,
        http: op.http,
        remote: "origin",
        ref: branch,
        remoteRef,
        singleBranch: true,
        tags: false,
        ...(options.deepen ? { depth: options.deepen, relative: true } : options.depth ? { depth: options.depth } : {}),
      }));
      await this.trimShallow(op, shallowBefore);
      return true;
    } catch (error) {
      const missing = (error as { code?: unknown; data?: { what?: unknown } }).code === "NotFoundError" && (error as { data?: { what?: unknown } }).data?.what === remoteRef;
      if (!missing) throw error;
      if (await this.resolve(op, `refs/remotes/origin/${branch}`)) await git.deleteRef({ ...op.git, ref: `refs/remotes/origin/${branch}` });
      return false;
    }
  }

  /** Makes the remote's `branch` the local one's upstream, as other Git apps read it. */
  private async setUpstream(op: Op, branch: string): Promise<void> {
    await git.setConfig({ ...op.git, path: `branch.${branch}.remote`, value: "origin" });
    await git.setConfig({ ...op.git, path: `branch.${branch}.merge`, value: `refs/heads/${branch}` });
  }

  /**
   * Brings every remote-tracking branch to what the remote holds now, from
   * one ref advertisement, as `git fetch --prune` would: a branch the remote
   * no longer has loses its ref; one that moved points at its new commit when
   * this copy has it, and is fetched otherwise (only what this copy lacks
   * when a local branch of that name gives the fetch its haves, else as deep
   * as a switch fetches). What a push sends is measured against these, so a
   * stale one (force-pushed or deleted) would leave out paths and their locks.
   */
  private async refreshRemoteHeads(op: Op): Promise<void> {
    const refs = await git.listServerRefs({ http: op.http, url: this.url, prefix: "refs/heads/" });
    const advertised = new Map(refs.map(({ ref, oid }) => [ref.slice("refs/heads/".length), oid]));
    for (const name of await git.listBranches({ ...op.git, remote: "origin" })) {
      if (name === "HEAD") continue;
      const ref = `refs/remotes/origin/${name}`;
      const tip = advertised.get(name);
      if (!tip) {
        await git.deleteRef({ ...op.git, ref });
      } else if (tip !== (await this.resolve(op, ref))) {
        if (await this.readCommit(op, tip)) await git.writeRef({ ...op.git, ref, value: tip, force: true });
        else await this.fetchBranch(op, { branch: name, ...((await this.resolve(op, `refs/heads/${name}`)) ? {} : { depth: DEFAULT_CLONE_DEPTH }) });
      }
    }
  }

  /** Every remote branch this copy has fetched: what a branch not pushed yet is measured against. */
  private async remoteHeads(op: Op): Promise<string[]> {
    const heads: string[] = [];
    for (const name of await git.listBranches({ ...op.git, remote: "origin" })) {
      if (name === "HEAD") continue;
      const oid = await this.resolve(op, `refs/remotes/origin/${name}`);
      if (oid && !heads.includes(oid)) heads.push(oid);
    }
    return heads;
  }

  /**
   * The files that differ between two commits (null: no commit, so every
   * file of the other), sorted, with their blob ids; identical subtrees are
   * skipped, and no working file is read.
   */
  private async differing(op: Op, from: string | null, to: string | null): Promise<Differing[]> {
    if (from === to) return [];
    const sides = [from, to].filter((ref): ref is string => ref !== null);
    const result = (await git.walk({
      ...op.git,
      trees: sides.map((ref) => git.TREE({ ref })),
      map: async (path, entries) => {
        if (path === ".") return undefined;
        const before = from ? entries[0] : null;
        const after = to ? entries[from ? 1 : 0] : null;
        // The same id on both sides: nothing below it differs.
        if ((before ? await before.oid() : null) === (after ? await after.oid() : null)) return null;
        const fromId = await blobOid(before);
        const toId = await blobOid(after);
        if (fromId === null && toId === null) return undefined;
        return { path, from: fromId, to: toId } satisfies Differing;
      },
    })) as Differing[];
    return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /**
   * Drops from `.git/shallow` the commits a fetch added there whose parents
   * this copy held. isomorphic-git means to leave those out, but checks
   * before the fetch's pack is stored, so a branch fetched one deep from a
   * commit this copy already has (a teammate's branch off main) would stay a
   * boundary: every walk would stop at its tip, short of the merge base. A
   * boundary listed `before` the fetch stays even when its parents are here:
   * they may be the objects of a deepen that never finished, past which
   * history is missing.
   */
  private async trimShallow(op: Op, before: ReadonlySet<string>): Promise<void> {
    const shallow = await this.shallowCommits();
    const boundary: string[] = [];
    for (const oid of shallow) {
      if (before.has(oid)) {
        boundary.push(oid);
        continue;
      }
      const commit = await this.readCommit(op, oid);
      let complete = commit !== null;
      for (const parent of commit?.parent ?? []) complete &&= (await this.readCommit(op, parent)) !== null;
      if (!complete) boundary.push(oid);
    }
    if (boundary.length === shallow.size) return;
    if (boundary.length === 0) await op.fs.promises.unlink(`${GITDIR}/shallow`);
    else await op.fs.promises.writeFile(`${GITDIR}/shallow`, `${boundary.join("\n")}\n`);
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

  /** The first `INCOMING_LIMIT` of `oids` (newest first, as `relate` lists them), as the log lists commits. */
  private async commitInfos(op: Op, oids: readonly string[]): Promise<CommitInfo[]> {
    const commits: CommitInfo[] = [];
    for (const oid of oids.slice(0, INCOMING_LIMIT)) {
      const commit = await this.readCommit(op, oid);
      if (!commit) continue;
      commits.push({
        id: oid,
        message: commit.message,
        author: { name: commit.author.name, email: commit.author.email },
        timestamp: commit.author.timestamp,
        parents: commit.parent,
      });
    }
    return commits;
  }

  private async commitNode(op: Op, oid: string): Promise<CommitNode | null> {
    const commit = await this.readCommit(op, oid);
    return commit ? { parents: commit.parent, timestamp: commit.committer.timestamp } : null;
  }

  /** A commit object, read once per operation; null when this (shallow) copy lacks it, which a deepen may change. */
  private async readCommit(op: Op, oid: string): Promise<CommitObject | null> {
    const known = op.commits.get(oid);
    if (known) return known;
    try {
      const { commit } = await git.readCommit({ ...op.git, oid });
      op.commits.set(oid, commit);
      return commit;
    } catch (error) {
      if ((error as { code?: unknown }).code === "NotFoundError") return null;
      throw error;
    }
  }

  /**
   * Splits the history against `remotes`; a fork older than the shallow
   * history deepens the checked-out branch a bounded number of times, unless
   * `deepen` is false (no network, or a branch the remote lacks).
   */
  private async relation(op: Op, local: string, remotes: readonly string[], deepen = true): Promise<Relation> {
    for (let attempt = 0; ; attempt += 1) {
      const relation = await relate(local, remotes, (oid) => this.commitNode(op, oid), await this.shallowCommits());
      if (!deepen || remotes.length === 0 || relation.base || !relation.truncated || attempt >= MAX_DEEPENS) return relation;
      await this.fetchBranch(op, { deepen: DEEPEN_STEP * 2 ** attempt });
    }
  }

  /**
   * Counts and incoming commits against the remote-tracking branch; `deepen`
   * may fetch older history. A branch the remote lacks has nothing to pull,
   * and is ahead by what none of the remote's fetched branches holds.
   */
  private async state(op: Op, deepen: boolean): Promise<RemoteState> {
    const local = await this.resolve(op, this.localRef);
    const remote = await this.resolve(op, this.remoteRef);
    if (!local) {
      const incoming = remote ? (await this.relation(op, remote, [], deepen)).ahead : [];
      return { branch: this.current, local, remote, ahead: 0, behind: incoming.length, incoming: await this.commitInfos(op, incoming) };
    }
    if (!remote) {
      const { ahead } = await this.relation(op, local, await this.remoteHeads(op), false);
      return { branch: this.current, local, remote, ahead: ahead.length, behind: 0, incoming: [] };
    }
    const relation = await this.relation(op, local, [remote], deepen);
    return {
      branch: this.current,
      local,
      remote,
      ahead: relation.ahead.length,
      behind: relation.behind.length,
      incoming: await this.commitInfos(op, relation.behind),
    };
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
    await this.downloadInto(op, await this.lfsEntries(op, commit, paths));
  }

  /**
   * Downloads each object of `wanted` (by working path) whose file is
   * missing or of another size into that file (with a native file transfer,
   * straight to the file); a file of the object's size is never read.
   */
  private async downloadInto(op: Op, wanted: ReadonlyMap<string, LfsObject>): Promise<void> {
    const pathsByOid = new Map<string, string[]>();
    const missing: LfsObject[] = [];
    for (const [path, object] of wanted) {
      const stat = await op.fs.stat(path).catch(() => null);
      if (stat && stat.isFile() && stat.size === object.size) continue;
      if (!pathsByOid.has(object.oid)) missing.push(object);
      pathsByOid.set(object.oid, [...(pathsByOid.get(object.oid) ?? []), path]);
    }
    if (missing.length === 0) return;
    for (const folder of new Set([...pathsByOid.values()].flat().map(parentOf))) await this.storage.mkdir(folder, true);
    await op.lfs.download(missing, (object) => pathsByOid.get(object.oid)!);
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
