import { isStorageNotFound, type ProjectStorage } from "@haptic/core";
import { relate } from "./git/history";
import { gitBlobSha1, lfsObjectId, lfsPointerText, parseLfsPointer } from "./lfs-pointer";
import { planPull } from "./pull-plan";
import {
  hasLfsRule,
  INCOMING_LIMIT,
  isValidBranchName,
  SyncError,
  throwIfCancelled,
  uncommittedChangesError,
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
  type RemovableLfsOptions,
  type SwitchResult,
  type SyncPort,
  type SyncStatus,
  type TransferOptions,
} from "./sync-port";

/** A commit's files as Git holds them: a `.blobs` file as its LFS pointer, never the object's bytes. */
type Files = ReadonlyMap<string, Uint8Array>;

interface FakeCommit {
  id: string;
  /** Creation order: a parent always comes first, so history walks need no clock. */
  sequence: number;
  parents: string[];
  files: Files;
  message: string;
  author: CommitAuthor;
  timestamp: number;
}

function encode(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

/** Committed content never changes, so each file's id is hashed once. */
const committedIds = new WeakMap<Uint8Array, string>();

/** A committed file's content id, as Git's: an LFS object's is its pointer's. */
async function contentId(bytes: Uint8Array | undefined): Promise<string | null> {
  if (!bytes) return null;
  const known = committedIds.get(bytes);
  if (known) return known;
  const id = await gitBlobSha1(bytes);
  committedIds.set(bytes, id);
  return id;
}

function pointerBytes(oid: string, size: number): Uint8Array {
  return new TextEncoder().encode(lfsPointerText(oid, size));
}

function lfsId(oid: string, size: number): Promise<string> {
  return gitBlobSha1(pointerBytes(oid, size));
}

/** A checkout's paths that change working files: an LFS object's file the target lacks stays, untracked, as the Git core keeps it. */
function writtenPaths(writes: readonly string[], target: Files): string[] {
  return writes.filter((path) => !(lfsObjectId(path) && !target.has(path)));
}

/** A working file as a listing gives it: `.blobs` files are compared by name and size, never read. */
interface WorkingEntry {
  size: number | null;
  mtime: number | null;
}

/**
 * The remote side of `FakeSync`: commits and branches in memory, shared by
 * every fake working copy of it, so a teammate is another `FakeSync` or a
 * direct `commit`. It keeps the LFS objects pushed or seeded, as a server does.
 */
export class FakeRemote {
  readonly branches = new Map<string, string>();
  /** The LFS store: objects pushed or seeded, by oid. */
  readonly lfsObjects = new Map<string, Uint8Array>();
  private readonly commits = new Map<string, FakeCommit>();
  private readonly now: () => number;
  private counter = 0;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Commits `changes` (null removes a file) on top of `branch` as a teammate
   * pushing, a `.blobs` file's bytes into the LFS store; a branch the remote
   * lacks starts from main, as a teammate's new branch would.
   */
  commit(changes: Record<string, string | Uint8Array | null>, message = "Teammate", branch = "main"): string {
    const head = this.branches.get(branch) ?? this.branches.get("main") ?? null;
    const files = new Map(head ? this.get(head).files : []);
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) {
        files.delete(path);
        continue;
      }
      const bytes = encode(content);
      const oid = lfsObjectId(path);
      if (oid) this.lfsObjects.set(oid, bytes);
      files.set(path, oid ? pointerBytes(oid, bytes.byteLength) : bytes);
    }
    const id = this.add({ parents: head ? [head] : [], files, message, author: { name: "Teammate", email: "teammate@example.com" }, timestamp: Math.floor(this.now() / 1000) });
    this.branches.set(branch, id);
    return id;
  }

  /** @internal */
  add(commit: Omit<FakeCommit, "id" | "sequence">): string {
    this.counter += 1;
    const id = this.counter.toString(16).padStart(40, "0");
    this.commits.set(id, { ...commit, id, sequence: this.counter });
    return id;
  }

  /** @internal */
  get(id: string): FakeCommit {
    const commit = this.commits.get(id);
    if (!commit) throw new SyncError("not-found", `No commit ${id}.`);
    return commit;
  }
}

/**
 * `SyncPort` in memory for editor and end-to-end tests: the working tree is
 * real project storage, history lives in a `FakeRemote`. Same results as
 * `GitRepository` for the same steps (the contract test runs both), with no
 * network, no `.git` folder and full history. As in Git, commits hold LFS
 * pointers: an object's bytes are only in working copies and the remote's
 * store, so a push uploads the working file and a checkout takes the
 * working file or the store's.
 */
export class FakeSync implements SyncPort {
  private readonly storage: ProjectStorage;
  private readonly remote: FakeRemote;
  private readonly now: () => number;
  /** The checked-out branch, this copy's own (as HEAD is). */
  private current: string;
  /** Local branches with a commit, as `refs/heads`. */
  private readonly heads = new Map<string, string>();
  /** The remote's branches as this copy last fetched them, as `refs/remotes/origin`. */
  private readonly fetched = new Map<string, string>();
  /**
   * Content ids of working files by size and mtime, as Git's index keeps
   * them, so a status reads only files whose stats changed. An entry is
   * trusted only for an mtime older than when it was hashed (Git's racy
   * check), so a same-size rewrite in that millisecond is read again.
   */
  private readonly statCache = new Map<string, { size: number; mtime: number; id: string; hashedAt: number }>();

  constructor(options: { storage: ProjectStorage; remote: FakeRemote; branch: string; now?: () => number }) {
    this.storage = options.storage;
    this.remote = options.remote;
    this.current = options.branch;
    this.now = options.now ?? Date.now;
    const head = options.remote.branches.get(options.branch);
    if (head) {
      this.heads.set(options.branch, head);
      this.fetched.set(options.branch, head);
    }
  }

  get branch(): string {
    return this.current;
  }

  private get head(): string | null {
    return this.heads.get(this.current) ?? null;
  }

  private set head(commit: string) {
    this.heads.set(this.current, commit);
  }

  private get tracking(): string | null {
    return this.fetched.get(this.current) ?? null;
  }

  /** Records what the remote holds for `branch` now (none: the ref goes, as a pruning fetch drops it). */
  private fetchRef(branch: string): string | null {
    const remote = this.remote.branches.get(branch) ?? null;
    if (remote) this.fetched.set(branch, remote);
    else this.fetched.delete(branch);
    return remote;
  }

  /**
   * A working copy of the remote branch, written into the empty folder
   * `storage` is bound to; a cancel stops the writes and rejects as `cancelled`.
   */
  static async clone(options: TransferOptions & { storage: ProjectStorage; remote: FakeRemote; branch: string; now?: () => number }): Promise<FakeSync> {
    throwIfCancelled(options.signal);
    const sync = new FakeSync(options);
    if (!sync.head) throw new SyncError("not-found", `The repository has no branch ${options.branch}.`);
    const files = sync.files(sync.head);
    for (const { path, bytes } of await sync.checkoutWrites([...files.keys()], files, new Map())) {
      throwIfCancelled(options.signal);
      if (bytes) await sync.storage.writeBinary(path, bytes);
    }
    throwIfCancelled(options.signal);
    return sync;
  }

  /** A working copy with no commits in the folder `storage` is bound to, as Publish starts one; the first push creates the branch. */
  static init(options: { storage: ProjectStorage; remote: FakeRemote; branch: string; now?: () => number }): FakeSync {
    const sync = new FakeSync(options);
    sync.heads.clear();
    sync.fetched.clear();
    return sync;
  }

  async status(): Promise<SyncStatus> {
    const working = await this.workingEntries();
    const committed = this.head ? this.files(this.head) : new Map<string, Uint8Array>();
    const changes: FileChange[] = [];
    for (const path of [...new Set([...working.keys(), ...committed.keys()])].sort()) {
      const before = await contentId(committed.get(path));
      const after = await this.workingId(path, working.get(path));
      if (before === after) continue;
      changes.push({ path, kind: before === null ? "added" : after === null ? "deleted" : "modified" });
    }
    return { branch: this.branch, head: this.head, changes };
  }

  async commit({ paths, message, author }: CommitInput): Promise<CommitResult> {
    const changed = new Set((await this.status()).changes.map((change) => change.path));
    const selected = [...new Set(paths)].filter((path) => changed.has(path));
    if (selected.length === 0) throw new Error("Nothing to commit.");
    const working = await this.workingEntries();
    const files = new Map(this.head ? this.files(this.head) : []);
    for (const path of selected) {
      const entry = working.get(path);
      const oid = lfsObjectId(path);
      // An LFS object is committed as its pointer, from its name and size: never read.
      if (!entry) files.delete(path);
      else files.set(path, oid ? pointerBytes(oid, await this.workingSize(path, entry)) : await this.storage.readBinary(path));
    }
    if (selected.some((path) => lfsObjectId(path) && working.has(path)) && !hasLfsRule(new TextDecoder().decode(files.get(".gitattributes") ?? new Uint8Array()))) {
      throw new SyncError("lfs", "Add the .blobs rule to .gitattributes before committing asset blobs.", { code: "missing-lfs-rule" });
    }
    this.head = this.remote.add({ parents: this.head ? [this.head] : [], files, message, author, timestamp: Math.floor(this.now() / 1000) });
    return { commit: this.head };
  }

  async fetch(options: TransferOptions = {}): Promise<RemoteState> {
    throwIfCancelled(options.signal);
    this.fetchRef(this.current);
    return this.remoteState();
  }

  async remoteState(): Promise<RemoteState> {
    const head = this.head;
    const tracking = this.tracking;
    // A branch the remote lacks has nothing to pull, and is ahead by what none of the fetched remote branches holds.
    const relation = head ? await this.relation(head, tracking ? [tracking] : [...this.fetched.values()]) : null;
    const incoming = !tracking ? [] : relation ? relation.behind : (await this.relation(tracking, [])).ahead;
    return {
      branch: this.current,
      local: head,
      remote: tracking,
      ahead: relation?.ahead.length ?? 0,
      behind: incoming.length,
      // `relate` lists them newest first.
      incoming: incoming
        .slice(0, INCOMING_LIMIT)
        .map((id) => this.remote.get(id))
        .map((commit) => ({ id: commit.id, message: commit.message, author: commit.author, timestamp: commit.timestamp, parents: commit.parents })),
    };
  }

  async outgoing(options: TransferOptions = {}): Promise<string[]> {
    throwIfCancelled(options.signal);
    // Every remote-tracking branch as the remote holds it now (a deleted one goes), as the Git core refreshes them.
    for (const name of [...this.fetched.keys()]) this.fetchRef(name);
    const head = this.head;
    const tracking = this.tracking;
    if (!head || head === tracking) return [];
    // What a push sends: the branch's work since it left what the remote holds (its own branch, or before its first push every branch the remote has).
    const { base } = await this.relation(head, tracking ? [tracking] : [...this.fetched.values()]);
    return (await this.differing(base, head)).map((entry) => entry.path);
  }

  async pull({ author, choices, signal }: PullInput): Promise<PullResult> {
    throwIfCancelled(signal);
    const remote = this.fetchRef(this.current);
    if (!remote || remote === this.head) return { kind: "up-to-date", head: this.head };
    const relation = this.head ? await this.relation(this.head, [remote]) : null;
    if (relation && relation.behind.length === 0) return { kind: "up-to-date", head: this.head };
    const base = relation?.base ?? null;
    const baseFiles = base ? this.files(base) : new Map<string, Uint8Array>();
    const theirsFiles = this.files(remote);
    const working = await this.workingEntries();
    const incoming = [];
    for (const path of [...new Set([...baseFiles.keys(), ...theirsFiles.keys()])].sort()) {
      const baseId = await contentId(baseFiles.get(path));
      const theirs = await contentId(theirsFiles.get(path));
      if (baseId !== theirs) incoming.push({ path, base: baseId, theirs, mine: await this.workingId(path, working.get(path)) });
    }
    const plan = planPull(incoming, choices);
    if (!plan.ready) return { kind: "conflicts", conflicts: plan.conflicts };
    for (const { path, bytes } of await this.checkoutWrites(plan.writes, theirsFiles, working)) {
      // As checkout: a cancel stops the writes and leaves the branch where it was.
      throwIfCancelled(signal);
      if (bytes) await this.storage.writeBinary(path, bytes);
      else if (working.has(path)) await this.storage.remove(path);
    }
    const changedPaths = writtenPaths(plan.writes, theirsFiles);
    if (!relation || relation.ahead.length === 0) {
      this.head = remote;
      return { kind: "fast-forward", head: remote, changedPaths };
    }
    const files = new Map(this.files(this.head!));
    for (const path of plan.writes) {
      const bytes = theirsFiles.get(path);
      if (bytes) files.set(path, bytes);
      else files.delete(path);
    }
    this.head = this.remote.add({
      parents: [this.head!, remote],
      files,
      message: `Merge remote-tracking branch 'origin/${this.current}'\n`,
      author,
      timestamp: Math.floor(this.now() / 1000),
    });
    return { kind: "merged", head: this.head, changedPaths };
  }

  async push(options: TransferOptions = {}): Promise<PushResult> {
    throwIfCancelled(options.signal);
    const head = this.head;
    if (!head) throw new SyncError("not-found", "There is nothing to push yet.");
    const remote = this.remote.branches.get(this.current) ?? null;
    // A new remote branch starts from what the remote's other branches already hold.
    const { ahead, base } = await this.relation(head, remote ? [remote] : [...this.remote.branches.values()]);
    if (remote && base !== remote) {
      throw new SyncError("conflict", "The remote branch has commits this copy lacks. Pull first.", { code: "push-rejected" });
    }
    // The objects the pushed commits introduce (against their first parent), uploaded from the working copy: commits hold only pointers.
    const objects = new Map<string, { path: string; size: number }>();
    for (const id of ahead) {
      const commit = this.remote.get(id);
      const parent = commit.parents[0] ? this.files(commit.parents[0]) : new Map<string, Uint8Array>();
      for (const [path, bytes] of commit.files) {
        const pointer = lfsObjectId(path) ? parseLfsPointer(bytes) : null;
        if (!pointer || this.remote.lfsObjects.has(pointer.oid) || (await contentId(parent.get(path))) === (await contentId(bytes))) continue;
        if (!objects.has(pointer.oid)) objects.set(pointer.oid, { path, size: pointer.size });
      }
    }
    let uploaded = 0;
    for (const [oid, { path, size }] of objects) {
      throwIfCancelled(options.signal);
      const bytes = await this.workingObject(path, size);
      if (!bytes) throw new SyncError("lfs", `${path} is missing, so it cannot be uploaded.`, { code: "lfs-object-missing" });
      this.remote.lfsObjects.set(oid, bytes);
      uploaded += 1;
    }
    this.remote.branches.set(this.current, head);
    this.fetched.set(this.current, head);
    return { head, uploaded };
  }

  async readFile(path: string, commit: string): Promise<Uint8Array | null> {
    const bytes = this.files(commit).get(path) ?? null;
    const pointer = bytes && lfsObjectId(path) ? parseLfsPointer(bytes) : null;
    return pointer ? ((await this.workingObject(path, pointer.size)) ?? this.storedObject(pointer.oid, pointer.size)) : bytes;
  }

  async readLfsObject(path: string, size: number, options: TransferOptions = {}): Promise<Uint8Array> {
    throwIfCancelled(options.signal);
    const oid = lfsObjectId(path);
    if (!oid) throw new Error(`${path} is not an LFS object.`);
    return (await this.workingObject(path, size)) ?? this.storedObject(oid, size);
  }

  /** The working copy's file for an LFS object of `size` (an object never changes under its name), or null. */
  private async workingObject(path: string, size: number): Promise<Uint8Array | null> {
    try {
      const local = await this.storage.readBinary(path);
      return local.byteLength === size ? local : null;
    } catch (error) {
      if (isStorageNotFound(error)) return null;
      throw error;
    }
  }

  /** An LFS object as the server holds it: only what was seeded or pushed (a commit never pushed uploaded nothing). */
  private storedObject(oid: string, size: number): Uint8Array {
    const stored = this.remote.lfsObjects.get(oid);
    if (!stored || stored.byteLength !== size) throw new SyncError("lfs", `The server has no LFS object ${oid}.`, { code: "lfs-object-missing" });
    return stored;
  }

  async removableLfsObjects({ signal, references }: RemovableLfsOptions): Promise<string[]> {
    throwIfCancelled(signal);
    const committed = this.head ? this.files(this.head) : new Map<string, Uint8Array>();
    // No index: untracked is what HEAD lacks.
    const untracked = [...(await this.workingEntries()).keys()].filter((path) => lfsObjectId(path) && !committed.has(path)).sort();
    if (untracked.length === 0) return [];
    // What a commit of a local branch holds that no fetched remote branch reaches (a branch never pushed: every commit).
    const remotes = [...this.fetched.values()];
    const held = new Set<string>();
    for (const head of new Set(this.heads.values())) {
      throwIfCancelled(signal);
      for (const id of (await this.relation(head, remotes)).ahead) {
        const files = this.files(id);
        for (const path of untracked) if (files.has(path)) held.add(path);
      }
    }
    // What a committed asset names while its commit holds no object of that name in their folders:
    // every commit this copy reaches, each changed `.hasset` read.
    const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
    const folders = [...new Set(untracked.map((path) => path.slice(0, path.lastIndexOf("/"))))];
    const queue = [...this.heads.values(), ...remotes];
    const seen = new Set<string>();
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      throwIfCancelled(signal);
      if (seen.has(id)) continue;
      seen.add(id);
      const commit = this.remote.get(id);
      queue.push(...commit.parents);
      for (const { path, to } of await this.differing(commit.parents[0] ?? null, id)) {
        if (to === null || !path.endsWith(".hasset")) continue;
        for (const name of references(path, commit.files.get(path)!)) {
          if (folders.some((folder) => commit.files.has(`${folder}/${name}`))) continue;
          for (const candidate of untracked) if (nameOf(candidate) === name) held.add(candidate);
        }
      }
    }
    return untracked.filter((path) => !held.has(path));
  }

  async log({ limit, skip = 0, path, signal }: LogOptions): Promise<LogPage> {
    throwIfCancelled(signal);
    const commits: CommitInfo[] = [];
    const seen = new Set<string>();
    const queue = this.head ? [this.head] : [];
    let skipped = 0;
    let more = false;
    while (queue.length > 0) {
      queue.sort((a, b) => this.remote.get(b).sequence - this.remote.get(a).sequence);
      const commit = this.remote.get(queue.shift()!);
      if (seen.has(commit.id)) continue;
      seen.add(commit.id);
      queue.push(...commit.parents);
      const parent = commit.parents[0] ? this.files(commit.parents[0]) : new Map<string, Uint8Array>();
      if (path && (await contentId(commit.files.get(path))) === (await contentId(parent.get(path)))) continue;
      if (skipped < skip) {
        skipped += 1;
        continue;
      }
      if (commits.length === limit) {
        more = true;
        break;
      }
      commits.push({ id: commit.id, message: commit.message, author: commit.author, timestamp: commit.timestamp, parents: commit.parents });
    }
    // Full history: never shallow.
    return { commits, hasMore: more || commits.length >= limit, shallow: false };
  }

  async commitChanges(commit: string): Promise<FileChange[] | null> {
    const parent = this.remote.get(commit).parents[0] ?? null;
    return (await this.differing(parent, commit)).map(({ path, from, to }) => ({ path, kind: from === null ? "added" : to === null ? "deleted" : "modified" }));
  }

  async localBranches(): Promise<string[]> {
    return [...this.heads.keys()].sort();
  }

  async remoteBranches(options: TransferOptions = {}): Promise<string[]> {
    throwIfCancelled(options.signal);
    return [...this.remote.branches.keys()].sort();
  }

  async createBranch(name: string): Promise<void> {
    if (!isValidBranchName(name)) throw new SyncError("conflict", `"${name}" is not a valid branch name.`, { code: "invalid-branch-name" });
    const head = this.head;
    if (!head) throw new SyncError("not-found", "Commit something before starting a branch.");
    if (this.heads.has(name)) throw new SyncError("conflict", `There is already a branch named ${name}.`, { code: "branch-exists" });
    this.heads.set(name, head);
    this.current = name;
  }

  async branchCommit(name: string, options: TransferOptions = {}): Promise<string | null> {
    throwIfCancelled(options.signal);
    return this.heads.get(name) ?? this.fetchRef(name);
  }

  async switchBranch(name: string, options: TransferOptions = {}): Promise<SwitchResult> {
    throwIfCancelled(options.signal);
    const head = this.head;
    if (name === this.current) return { head, changedPaths: [] };
    const local = this.heads.get(name) ?? null;
    // A branch only the remote has is fetched first.
    const target = local ?? this.fetchRef(name);
    if (!target) throw new SyncError("not-found", `There is no branch ${name}.`);
    const differing = await this.differing(head, target);
    const working = await this.workingEntries();
    const mine = new Map<string, string | null>();
    for (const { path } of differing) mine.set(path, await this.workingId(path, working.get(path)));
    // A file the switch replaces must hold what one of the branches holds; anything else is work it would lose.
    const blocked = differing.filter(({ path, from, to }) => mine.get(path) !== from && mine.get(path) !== to).map(({ path }) => path);
    if (blocked.length > 0) throw uncommittedChangesError(name, blocked);
    const writes = differing.filter(({ path, to }) => mine.get(path) !== to).map(({ path }) => path);
    const files = this.files(target);
    for (const { path, bytes } of await this.checkoutWrites(writes, files, working)) {
      // As checkout: a cancel stops the writes and leaves the branch where it was.
      throwIfCancelled(options.signal);
      if (bytes) await this.storage.writeBinary(path, bytes);
      else await this.storage.remove(path);
    }
    this.heads.set(name, target);
    this.current = name;
    return { head: target, changedPaths: writtenPaths(writes, files) };
  }

  private files(id: string): Files {
    return this.remote.get(id).files;
  }

  /**
   * What checking out `paths` from `files` writes (null: remove), worked out
   * before any write, as the Git core downloads first. An LFS object's file
   * stays when the target lacks it (it may be the object's only copy) or
   * already holds it (by name and size); a missing one comes from the
   * remote's store, never from a commit, and one the store lacks is
   * `lfs-object-missing`.
   */
  private async checkoutWrites(paths: readonly string[], files: Files, working: ReadonlyMap<string, WorkingEntry>): Promise<{ path: string; bytes: Uint8Array | null }[]> {
    const out: { path: string; bytes: Uint8Array | null }[] = [];
    for (const path of paths) {
      const committed = files.get(path) ?? null;
      if (!lfsObjectId(path)) {
        out.push({ path, bytes: committed });
        continue;
      }
      const pointer = committed ? parseLfsPointer(committed) : null;
      if (!pointer) continue;
      const entry = working.get(path);
      if (entry && (await this.workingSize(path, entry)) === pointer.size) continue;
      out.push({ path, bytes: this.storedObject(pointer.oid, pointer.size) });
    }
    return out;
  }

  private async workingSize(path: string, entry: WorkingEntry): Promise<number> {
    return entry.size ?? (await this.storage.stat(path)).size ?? 0;
  }

  /** The files that differ between two commits (null: no commit), sorted, with their content ids. */
  private async differing(from: string | null, to: string | null): Promise<{ path: string; from: string | null; to: string | null }[]> {
    const before = from ? this.files(from) : new Map<string, Uint8Array>();
    const after = to ? this.files(to) : new Map<string, Uint8Array>();
    const out = [];
    for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const fromId = await contentId(before.get(path));
      const toId = await contentId(after.get(path));
      if (fromId !== toId) out.push({ path, from: fromId, to: toId });
    }
    return out;
  }

  private relation(local: string, remotes: readonly string[]) {
    return relate(local, remotes, async (id) => {
      const commit = this.remote.get(id);
      return { parents: commit.parents, timestamp: commit.sequence };
    }, new Set());
  }

  /** Every working file Git would see (`.git` and `.gitignore`d names left out), from listings alone. */
  private async workingEntries(): Promise<Map<string, WorkingEntry>> {
    const ignored = await this.ignoreRules();
    const out = new Map<string, WorkingEntry>();
    const walk = async (dir: string) => {
      for (const entry of await this.storage.readdir(dir)) {
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (path === ".git" || ignored.some((rule) => rule.test(entry.name) || rule.test(path))) continue;
        if (entry.isDir) await walk(path);
        else out.set(path, { size: entry.size ?? null, mtime: entry.mtime ?? null });
      }
    };
    await walk("");
    return out;
  }

  /** A working file's content id: a `.blobs` file's from its name and size (as the Git core's clean filter), any other's from its bytes. */
  private async workingId(path: string, entry: WorkingEntry | undefined): Promise<string | null> {
    if (!entry) return null;
    const oid = lfsObjectId(path);
    if (oid) return lfsId(oid, await this.workingSize(path, entry));
    const cached = this.statCache.get(path);
    if (cached && cached.size === entry.size && cached.mtime === entry.mtime && cached.mtime < cached.hashedAt) return cached.id;
    const hashedAt = Date.now();
    const id = await gitBlobSha1(await this.storage.readBinary(path));
    if (entry.size !== null && entry.mtime !== null) this.statCache.set(path, { size: entry.size, mtime: entry.mtime, id, hashedAt });
    return id;
  }

  /** `.gitignore` lines as name or path globs (`*` within a segment); enough for the entries Publish writes. */
  private async ignoreRules(): Promise<RegExp[]> {
    let text = "";
    try {
      text = new TextDecoder().decode(await this.storage.readBinary(".gitignore"));
    } catch (error) {
      if (!isStorageNotFound(error)) throw error;
    }
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => new RegExp(`^${line.replace(/^\//, "").replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`));
  }
}
