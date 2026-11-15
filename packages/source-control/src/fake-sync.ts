import { isStorageNotFound, type ProjectStorage } from "@haptic/core";
import { relate } from "./git/history";
import { gitBlobSha1, lfsObjectId, lfsPointerText } from "./lfs-pointer";
import { planPull } from "./pull-plan";
import {
  hasLfsRule,
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
} from "./sync-port";

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

/** A file's content id as Git sees it: an LFS object's by its name and size. */
async function contentId(path: string, bytes: Uint8Array | undefined): Promise<string | null> {
  if (!bytes) return null;
  const oid = lfsObjectId(path);
  return gitBlobSha1(oid ? new TextEncoder().encode(lfsPointerText(oid, bytes.byteLength)) : bytes);
}

/**
 * The remote side of `FakeSync`: commits and branches in memory, shared by
 * every fake working copy of it, so a teammate is another `FakeSync` or a
 * direct `commit`. It keeps the LFS objects pushed or seeded, as a server does.
 */
export class FakeRemote {
  readonly branches = new Map<string, string>();
  readonly lfsObjects = new Set<string>();
  private readonly commits = new Map<string, FakeCommit>();
  private readonly now: () => number;
  private counter = 0;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Commits `changes` (null removes a file) on top of `branch` as a teammate pushing. */
  commit(changes: Record<string, string | Uint8Array | null>, message = "Teammate", branch = "main"): string {
    const head = this.branches.get(branch) ?? null;
    const files = new Map(head ? this.get(head).files : []);
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) files.delete(path);
      else files.set(path, encode(content));
      const oid = lfsObjectId(path);
      if (oid && content !== null) this.lfsObjects.add(oid);
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
 * network, no `.git` folder and full history.
 */
export class FakeSync implements SyncPort {
  readonly branch: string;
  private readonly storage: ProjectStorage;
  private readonly remote: FakeRemote;
  private readonly now: () => number;
  private head: string | null;
  private tracking: string | null;

  constructor(options: { storage: ProjectStorage; remote: FakeRemote; branch: string; now?: () => number }) {
    this.storage = options.storage;
    this.remote = options.remote;
    this.branch = options.branch;
    this.now = options.now ?? Date.now;
    this.head = options.remote.branches.get(options.branch) ?? null;
    this.tracking = this.head;
  }

  /** A working copy of the remote branch, written into the empty folder `storage` is bound to. */
  static async clone(options: { storage: ProjectStorage; remote: FakeRemote; branch: string; now?: () => number }): Promise<FakeSync> {
    const sync = new FakeSync(options);
    if (!sync.head) throw new SyncError("not-found", `The repository has no branch ${options.branch}.`);
    for (const [path, bytes] of sync.files(sync.head)) await sync.storage.writeBinary(path, bytes);
    return sync;
  }

  async status(): Promise<SyncStatus> {
    const working = await this.workingFiles();
    const committed = this.head ? this.files(this.head) : new Map<string, Uint8Array>();
    const changes: FileChange[] = [];
    for (const path of [...new Set([...working.keys(), ...committed.keys()])].sort()) {
      const before = await contentId(path, committed.get(path));
      const after = await contentId(path, working.get(path));
      if (before === after) continue;
      changes.push({ path, kind: before === null ? "added" : after === null ? "deleted" : "modified" });
    }
    return { branch: this.branch, head: this.head, changes };
  }

  async commit({ paths, message, author }: CommitInput): Promise<CommitResult> {
    const changed = new Set((await this.status()).changes.map((change) => change.path));
    const selected = [...new Set(paths)].filter((path) => changed.has(path));
    if (selected.length === 0) throw new Error("Nothing to commit.");
    const working = await this.workingFiles();
    const files = new Map(this.head ? this.files(this.head) : []);
    for (const path of selected) {
      const bytes = working.get(path);
      if (bytes) files.set(path, bytes);
      else files.delete(path);
    }
    if (selected.some((path) => lfsObjectId(path) && working.has(path)) && !hasLfsRule(new TextDecoder().decode(files.get(".gitattributes") ?? new Uint8Array()))) {
      throw new SyncError("lfs", "Add the .blobs rule to .gitattributes before committing asset blobs.", { code: "missing-lfs-rule" });
    }
    this.head = this.remote.add({ parents: this.head ? [this.head] : [], files, message, author, timestamp: Math.floor(this.now() / 1000) });
    return { commit: this.head };
  }

  async fetch(): Promise<RemoteState> {
    this.tracking = this.remote.branches.get(this.branch) ?? null;
    const relation = this.head ? await this.relation(this.head, this.tracking) : null;
    return {
      branch: this.branch,
      local: this.head,
      remote: this.tracking,
      ahead: relation?.ahead.length ?? 0,
      behind: relation ? relation.behind.length : this.tracking ? (await this.relation(this.tracking, null)).ahead.length : 0,
    };
  }

  async pull({ author, choices }: PullInput): Promise<PullResult> {
    const remote = this.remote.branches.get(this.branch) ?? null;
    this.tracking = remote;
    if (!remote || remote === this.head) return { kind: "up-to-date", head: this.head };
    const relation = this.head ? await this.relation(this.head, remote) : null;
    if (relation && relation.behind.length === 0) return { kind: "up-to-date", head: this.head };
    const base = relation?.base ?? null;
    const baseFiles = base ? this.files(base) : new Map<string, Uint8Array>();
    const theirsFiles = this.files(remote);
    const working = await this.workingFiles();
    const incoming = [];
    for (const path of [...new Set([...baseFiles.keys(), ...theirsFiles.keys()])].sort()) {
      const baseId = await contentId(path, baseFiles.get(path));
      const theirs = await contentId(path, theirsFiles.get(path));
      if (baseId !== theirs) incoming.push({ path, base: baseId, theirs, mine: await contentId(path, working.get(path)) });
    }
    const plan = planPull(incoming, choices);
    if (!plan.ready) return { kind: "conflicts", conflicts: plan.conflicts };
    for (const path of plan.writes) {
      const bytes = theirsFiles.get(path);
      if (bytes) await this.storage.writeBinary(path, bytes);
      else if (working.has(path)) await this.storage.remove(path);
    }
    if (!relation || relation.ahead.length === 0) {
      this.head = remote;
      return { kind: "fast-forward", head: remote, changedPaths: plan.writes };
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
      message: `Merge remote-tracking branch 'origin/${this.branch}'\n`,
      author,
      timestamp: Math.floor(this.now() / 1000),
    });
    return { kind: "merged", head: this.head, changedPaths: plan.writes };
  }

  async push(): Promise<PushResult> {
    if (!this.head) throw new SyncError("not-found", "There is nothing to push yet.");
    const remote = this.remote.branches.get(this.branch) ?? null;
    const { ahead, base } = await this.relation(this.head, remote);
    if (remote && base !== remote) {
      throw new SyncError("conflict", "The remote branch has commits this copy lacks. Pull first.", { code: "push-rejected" });
    }
    let uploaded = 0;
    for (const id of ahead) {
      for (const path of this.files(id).keys()) {
        const oid = lfsObjectId(path);
        if (oid && !this.remote.lfsObjects.has(oid)) {
          this.remote.lfsObjects.add(oid);
          uploaded += 1;
        }
      }
    }
    this.remote.branches.set(this.branch, this.head);
    this.tracking = this.head;
    return { head: this.head, uploaded };
  }

  async readFile(path: string, commit: string): Promise<Uint8Array | null> {
    return this.files(commit).get(path) ?? null;
  }

  async log({ limit, path }: LogOptions): Promise<LogPage> {
    const commits: CommitInfo[] = [];
    const seen = new Set<string>();
    const queue = this.head ? [this.head] : [];
    let more = false;
    while (queue.length > 0) {
      queue.sort((a, b) => this.remote.get(b).sequence - this.remote.get(a).sequence);
      const commit = this.remote.get(queue.shift()!);
      if (seen.has(commit.id)) continue;
      seen.add(commit.id);
      queue.push(...commit.parents);
      const parent = commit.parents[0] ? this.files(commit.parents[0]) : new Map<string, Uint8Array>();
      if (path && (await contentId(path, commit.files.get(path))) === (await contentId(path, parent.get(path)))) continue;
      if (commits.length === limit) {
        more = true;
        break;
      }
      commits.push({ id: commit.id, message: commit.message, author: commit.author, timestamp: commit.timestamp, parents: commit.parents });
    }
    return { commits, hasMore: more || commits.length >= limit };
  }

  private files(id: string): Files {
    return this.remote.get(id).files;
  }

  private relation(local: string, remote: string | null) {
    return relate(local, remote, async (id) => {
      const commit = this.remote.get(id);
      return { parents: commit.parents, timestamp: commit.sequence };
    }, new Set());
  }

  /** Every working file Git would see: `.git` and `.gitignore`d names left out. */
  private async workingFiles(): Promise<Map<string, Uint8Array>> {
    const ignored = await this.ignoreRules();
    const out = new Map<string, Uint8Array>();
    const walk = async (dir: string) => {
      for (const entry of await this.storage.readdir(dir)) {
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (path === ".git" || ignored.some((rule) => rule.test(entry.name) || rule.test(path))) continue;
        if (entry.isDir) await walk(path);
        else out.set(path, await this.storage.readBinary(path));
      }
    };
    await walk("");
    return out;
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
