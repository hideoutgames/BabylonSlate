/**
 * The working copy's Git sync as Integrated mode uses it. `GitRepository`
 * (subpath `./git`) implements it with isomorphic-git; `FakeSync` (subpath
 * `./fake-sync`) in memory for editor and end-to-end tests. One contract test
 * runs against both. Paths are repository-relative with `/` separators; the
 * project folder is the repository root.
 */
export interface SyncPort {
  /** Uncommitted changes against HEAD, from stat data: unchanged files are never read. */
  status(): Promise<SyncStatus>;
  /** Commits exactly `paths` (changed or deleted) on the current branch. */
  commit(input: CommitInput): Promise<CommitResult>;
  /** Fetches the branch, counts commits on each side and lists the newest incoming ones. */
  fetch(): Promise<RemoteState>;
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
  push(): Promise<PushResult>;
  /** A file's bytes at a commit (an LFS object's own bytes), or null when the commit has no such file. */
  readFile(path: string, commit: string): Promise<Uint8Array | null>;
  /** The branch's commits, newest first; `deepen` fetches older history once when a shallow clone ends early. */
  log(options: LogOptions): Promise<LogPage>;
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

export interface PullInput {
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

export interface LogOptions {
  limit: number;
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
}

/**
 * `auth`: no or refused credential. `network`: the host could not be reached.
 * `conflict`: the remote moved (push) or histories cannot be joined.
 * `not-found`: repository, branch or object missing. `lfs`: an LFS transfer or
 * rule failed.
 */
export type SyncErrorKind = "auth" | "network" | "conflict" | "not-found" | "lfs";

/** What exactly failed, where the kind alone does not say. */
export type SyncErrorCode =
  | "push-rejected"
  | "unrelated-histories"
  | "missing-lfs-rule"
  | "lfs-object-missing"
  | "lfs-object-corrupt"
  | "not-empty"
  | "repository-exists";

export class SyncError extends Error {
  readonly kind: SyncErrorKind;
  readonly code?: SyncErrorCode;
  readonly status?: number;

  constructor(kind: SyncErrorKind, message: string, options: { code?: SyncErrorCode; status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SyncError";
    this.kind = kind;
    if (options.code) this.code = options.code;
    if (options.status !== undefined) this.status = options.status;
  }
}

export function isSyncError(error: unknown): error is SyncError {
  return error instanceof SyncError;
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
