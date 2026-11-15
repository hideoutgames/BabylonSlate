/**
 * The working copy's Git sync as Integrated mode uses it. `GitRepository`
 * (subpath `./git`) implements it with isomorphic-git; `FakeSync` (subpath
 * `./fake-sync`) in memory for editor and end-to-end tests. One contract test
 * runs against both. Paths are repository-relative with `/` separators; the
 * project folder is the repository root.
 */
export interface SyncPort {
  /** The checked-out branch: the working copy's own (Git's HEAD), never a project setting. */
  readonly branch: string;
  /** Uncommitted changes against HEAD, from stat data: unchanged files are never read. */
  status(): Promise<SyncStatus>;
  /** Commits exactly `paths` (changed or deleted) on the current branch. */
  commit(input: CommitInput): Promise<CommitResult>;
  /** Fetches the branch, counts commits on each side and lists the newest incoming ones. */
  fetch(options?: TransferOptions): Promise<RemoteState>;
  /**
   * The counts and incoming commits against the remote branch as last fetched,
   * from local refs only: what a pull, push or commit leaves, with no network.
   */
  remoteState(): Promise<RemoteState>;
  /**
   * Paths whose committed content differs between the branch and the remote
   * branch as last fetched (every committed path when the remote has no
   * branch yet), sorted: what a push would change. Reads no network.
   */
  outgoing(): Promise<string[]>;
  /**
   * Fetches, then integrates the remote branch: fast-forward, or a merge commit
   * when both sides have commits. Paths changed on both sides (the working
   * tree, committed or not, against the remote, since the merge base) are
   * whole-file conflicts: without a choice for each, nothing changes and they
   * are returned. Every call recomputes them, so stale choices never apply.
   */
  pull(input: PullInput): Promise<PullResult>;
  /** Uploads the LFS objects the server lacks, then updates the remote branch. */
  push(options?: TransferOptions): Promise<PushResult>;
  /** A file's bytes at a commit (an LFS object's own bytes), or null when the commit has no such file. */
  readFile(path: string, commit: string): Promise<Uint8Array | null>;
  /**
   * An LFS object's bytes by its `.blobs/<sha256>` path and size, as a
   * `.hasset` chunk entry names them, so no commit is read: the working
   * copy's file when it has that size (an object never changes under its
   * name), otherwise downloaded and checked. Never written: the working copy
   * would keep a file no asset of it uses. One the server lacks is
   * `lfs` / `lfs-object-missing`.
   */
  readLfsObject(path: string, size: number, options?: TransferOptions): Promise<Uint8Array>;
  /** The branch's commits, newest first; `deepen` fetches older history once when a shallow clone ends early. */
  log(options: LogOptions): Promise<LogPage>;
  /**
   * The files `commit` changed against its first parent (every file of a root
   * commit), sorted; null when this shallow copy lacks the parent.
   */
  commitChanges(commit: string): Promise<FileChange[] | null>;
  /** The working copy's branches, sorted. Reads no network. */
  localBranches(): Promise<string[]>;
  /**
   * The remote's branches, sorted, from its Git ref advertisement: one
   * request and no host REST API, so every Git host lists them.
   */
  remoteBranches(options?: TransferOptions): Promise<string[]>;
  /**
   * Starts `name` at HEAD and checks it out; no working file changes. The
   * next push creates it on the remote and makes that its upstream. Refuses
   * an invalid name (`conflict` / `invalid-branch-name`), a local branch of
   * that name (`conflict` / `branch-exists`) and a copy with no commit yet.
   */
  createBranch(name: string): Promise<void>;
  /**
   * Checks out `name`: a local branch, or the remote's (fetched first, as
   * shallow as a clone). Files that differ between the branches take the
   * other branch's version; uncommitted changes to other files stay. Refuses
   * (`conflict` / `uncommitted-changes`, with the paths) when one of those
   * files has an uncommitted change the switch would overwrite; then nothing
   * changes. The current branch is a no-op.
   */
  switchBranch(name: string, options?: TransferOptions): Promise<SwitchResult>;
}

/**
 * An operation that talks to the remote. Once `signal` aborts, no further
 * request is sent and no further working file is written, and the operation
 * rejects with a `cancelled` `SyncError`; a request already sent still
 * finishes (native HTTP cannot stop one).
 */
export interface TransferOptions {
  signal?: AbortSignal;
}

export type ChangeKind = "added" | "modified" | "deleted";

export interface FileChange {
  path: string;
  kind: ChangeKind;
}

export interface SyncStatus {
  branch: string;
  /** Null before the first commit. */
  head: string | null;
  /** Sorted by path. */
  changes: FileChange[];
}

export interface CommitAuthor {
  name: string;
  email: string;
}

export interface CommitInput {
  paths: string[];
  message: string;
  author: CommitAuthor;
}

export interface CommitResult {
  commit: string;
}

export interface RemoteState {
  branch: string;
  local: string | null;
  remote: string | null;
  /** Local commits the remote lacks. */
  ahead: number;
  /** Remote commits not yet pulled. */
  behind: number;
  /** The newest of those commits, newest first, at most {@link INCOMING_LIMIT}. */
  incoming: CommitInfo[];
}

/** Incoming commits a fetch lists; `behind` still counts them all. */
export const INCOMING_LIMIT = 50;

/** Per conflicting path: keep the working tree's file, or take the remote's. */
export type PullChoice = "mine" | "theirs";
export type PullChoices = Readonly<Record<string, PullChoice>>;

export interface PullInput extends TransferOptions {
  /** Signs the merge commit when both sides have commits. */
  author: CommitAuthor;
  choices?: PullChoices;
}

export interface PullConflict {
  path: string;
  /** What each side did to the file since the merge base. */
  mine: ChangeKind;
  theirs: ChangeKind;
}

export type PullResult =
  | { kind: "up-to-date"; head: string | null }
  | {
      kind: "fast-forward" | "merged";
      head: string;
      /** Working tree files the pull wrote or removed, for the external-change reload. */
      changedPaths: string[];
    }
  | { kind: "conflicts"; conflicts: PullConflict[] };

export interface PushResult {
  head: string;
  /** LFS objects uploaded (the server already had the rest). */
  uploaded: number;
}

export interface SwitchResult {
  /** The branch's commit, null for a branch with none. */
  head: string | null;
  /** Working tree files the switch wrote or removed, for the external-change reload. */
  changedPaths: string[];
}

export interface LogOptions {
  limit: number;
  /** Commits to leave out first: the ones earlier pages listed. */
  skip?: number;
  /** Only commits that change this path. */
  path?: string;
  deepen?: boolean;
}

export interface CommitInfo {
  id: string;
  message: string;
  author: CommitAuthor;
  /** Seconds since the epoch. */
  timestamp: number;
  parents: string[];
}

export interface LogPage {
  commits: CommitInfo[];
  /** False only when the branch's first commit was reached. */
  hasMore: boolean;
  /** The page ended at this shallow copy's oldest commit: older ones come with `deepen`. */
  shallow: boolean;
}

/** Git's branch name rules (`git check-ref-format --branch`), so both clients and the editor refuse the same names. */
// eslint-disable-next-line no-control-regex -- Git refuses control characters in ref names.
const BAD_REF = /(^|[/.])([/.]|$)|^@$|@\{|[\x00-\x20\x7f~^:?*[\\]|\.lock(\/|$)/;

export function isValidBranchName(name: string): boolean {
  return name !== "" && !name.startsWith("-") && !BAD_REF.test(name);
}

/**
 * `auth`: no or refused credential. `network`: the host could not be reached.
 * `conflict`: the remote moved (push) or histories cannot be joined.
 * `not-found`: repository, branch or object missing. `lfs`: an LFS transfer or
 * rule failed. `cancelled`: the operation's signal aborted.
 */
export type SyncErrorKind = "auth" | "network" | "conflict" | "not-found" | "lfs" | "cancelled";

/** What exactly failed, where the kind alone does not say. */
export type SyncErrorCode =
  | "push-rejected"
  | "unrelated-histories"
  | "missing-lfs-rule"
  | "lfs-object-missing"
  | "lfs-object-corrupt"
  | "not-empty"
  | "repository-exists"
  | "uncommitted-changes"
  | "branch-exists"
  | "invalid-branch-name"
  | "detached-head";

export class SyncError extends Error {
  readonly kind: SyncErrorKind;
  readonly code?: SyncErrorCode;
  readonly status?: number;
  /** The files a refusal is about (`uncommitted-changes`), sorted. */
  readonly paths?: readonly string[];

  constructor(kind: SyncErrorKind, message: string, options: { code?: SyncErrorCode; status?: number; paths?: readonly string[]; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SyncError";
    this.kind = kind;
    if (options.code) this.code = options.code;
    if (options.status !== undefined) this.status = options.status;
    if (options.paths) this.paths = options.paths;
  }
}

/** A switch refused because `paths` (sorted) have uncommitted changes it would overwrite. */
export function uncommittedChangesError(branch: string, paths: readonly string[]): SyncError {
  const named = paths.slice(0, 3).join(", ") + (paths.length > 3 ? ` and ${paths.length - 3} more` : "");
  return new SyncError("conflict", `Commit or revert your changes to ${named} before switching to ${branch}.`, { code: "uncommitted-changes", paths });
}

export function isSyncError(error: unknown): error is SyncError {
  return error instanceof SyncError;
}

/** What an operation whose signal aborted rejects with. */
export function cancelledError(): SyncError {
  return new SyncError("cancelled", "Cancelled.");
}

/** Rejects the operation once `signal` has aborted. */
export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledError();
}

/** The `.gitattributes` line Publish writes: `.blobs` files are LFS objects. */
export const GITATTRIBUTES_LFS_RULE = "**/.blobs/** filter=lfs diff=lfs merge=lfs -text";

/** `.gitignore` entries Publish writes: one person's dock layout and storage's temporary files. */
export const GITIGNORE_ENTRIES = ["layout.json", ".haptic-*.tmp", ".haptic-move-*"] as const;

/** Whether `.gitattributes` text stores `.blobs` files through LFS. */
export function hasLfsRule(gitattributes: string): boolean {
  return gitattributes.split(/\r?\n/).some((line) => {
    const [pattern, ...attributes] = line.trim().split(/\s+/);
    return pattern === "**/.blobs/**" && attributes.includes("filter=lfs");
  });
}

/** `text` with the LFS rule added when it lacks one. */
export function withLfsRule(gitattributes: string): string {
  if (hasLfsRule(gitattributes)) return gitattributes;
  const base = gitattributes === "" || gitattributes.endsWith("\n") ? gitattributes : `${gitattributes}\n`;
  return `${base}${GITATTRIBUTES_LFS_RULE}\n`;
}

/** `text` with every Publish entry added that it lacks. */
export function withIgnoreEntries(gitignore: string): string {
  const present = new Set(gitignore.split(/\r?\n/).map((line) => line.trim()));
  const missing = GITIGNORE_ENTRIES.filter((entry) => !present.has(entry));
  if (missing.length === 0) return gitignore;
  const base = gitignore === "" || gitignore.endsWith("\n") ? gitignore : `${gitignore}\n`;
  return `${base}${missing.join("\n")}\n`;
}
