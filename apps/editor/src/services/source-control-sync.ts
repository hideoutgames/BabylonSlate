import type { ProjectFolderHandle, ProjectStorage, SourceControlProjectSettings } from "@haptic/core";
import {
  isSyncError,
  withLfsRule,
  type CommitAuthor,
  type CommitInfo,
  type FileLock,
  type PullChoices,
  type PullResult,
  type SyncErrorCode,
  type SyncErrorKind,
  type SyncPort,
} from "@haptic/source-control";
import { commitPaths, groupChanges, type ChangeLookup, type ChangeRow } from "../lib/source-control-changes";
import { integratedBlocker, type IntegratedBlocker } from "../lib/source-control-mode";

/** One status after a burst of editor saves. Status is stat based and cheap; this only coalesces the burst. */
export const STATUS_DEBOUNCE_MS = 800;

/** Network transfer of the operation running now, for its progress display. */
export interface TransferMonitor {
  /** Bytes sent and received so far. */
  bytes(count: number): void;
  /** The running operation's cancellation: once aborted, the next request is refused. */
  signal(): AbortSignal | null;
}

export interface SyncPortRequest {
  storage: ProjectStorage;
  folderId: string;
  repositoryUrl: string;
  branch: string;
  testMode: boolean;
  transfer: TransferMonitor;
}

/**
 * Opens the Git client for a project folder: the Git core on iOS, Android and
 * desktop, `FakeSync` in test mode. The editor loads it (with isomorphic-git)
 * only for an Integrated project; tests pass their own.
 */
export interface SyncPortFactory {
  open(request: SyncPortRequest): Promise<SyncPort>;
  /** A new working copy with no commits, for Publish. */
  init(request: SyncPortRequest): Promise<SyncPort>;
  /** Who commits: the repository host's account on this device. */
  author(repositoryUrl: string, testMode: boolean): Promise<CommitAuthor>;
}

/** Lock checks around a push, from the lock service. */
export interface SyncLocks {
  /** Locks someone else holds on any of `paths`; empty where the host has no locking. Rejects when the check fails. */
  theirs(paths: readonly string[]): Promise<FileLock[]>;
  /** Releases this device's locks on `paths`, except documents with unsaved edits. */
  releaseOwn(paths: readonly string[]): Promise<void>;
}

export type SyncOperationKind = "fetch" | "commit" | "pull" | "push" | "publish";

export interface SyncOperation {
  kind: SyncOperationKind;
  /** Bytes sent and received so far; transfers carry whole bodies, so there is no total. */
  bytes: number;
}

export interface SyncProblem {
  /** What failed, as a title: `Could Not Push`. */
  title: string;
  message: string;
  kind: SyncErrorKind | null;
  code: SyncErrorCode | null;
  /** Push refused: the locks other people hold on what it would push. */
  holders: readonly FileLock[];
}

export interface SyncSnapshot {
  /** Integrated mode runs Haptic's Git client in this folder. */
  readonly active: boolean;
  /** The project's mode is Integrated but this folder cannot run it. */
  readonly blocked: IntegratedBlocker | null;
  readonly branch: string;
  /** Changed assets and files, as the Changes window lists them. */
  readonly rows: readonly ChangeRow[];
  readonly statusReady: boolean;
  readonly ahead: number;
  readonly behind: number;
  /** The newest commits to pull, newest first. */
  readonly incoming: readonly CommitInfo[];
  /** When the last fetch finished (ms), null before the first. */
  readonly lastFetchAt: number | null;
  readonly operation: SyncOperation | null;
  readonly problem: SyncProblem | null;
}

export interface SyncConfigureInput {
  settings: SourceControlProjectSettings;
  folder: ProjectFolderHandle | null;
  storage: ProjectStorage;
  platform: string;
  testMode: boolean;
  /** The registry's view of a changed `.hasset`, for names, icons and blob grouping. */
  lookup: ChangeLookup;
  locks: SyncLocks;
  /** Defaults to the lazily loaded Git client. */
  factory?: SyncPortFactory;
}

const IDLE: SyncSnapshot = {
  active: false,
  blocked: null,
  branch: "",
  rows: [],
  statusReady: false,
  ahead: 0,
  behind: 0,
  incoming: [],
  lastFetchAt: null,
  operation: null,
  problem: null,
};

function loadFactory(): Promise<SyncPortFactory> {
  return import("./source-control-sync-port").then((module) => module.syncPortFactory);
}

function problemFrom(title: string, error: unknown, holders: readonly FileLock[] = []): SyncProblem {
  return {
    title,
    message: error instanceof Error ? error.message : String(error),
    kind: isSyncError(error) ? error.kind : null,
    code: isSyncError(error) ? error.code ?? null : null,
    holders,
  };
}

/**
 * The open project's Git sync in Integrated mode: one `SyncPort` per project
 * folder, opened lazily, and a stable snapshot for the Source Control tab,
 * the status bar and the phone's More Tools. Off and Manual load and request
 * nothing. Status is recomputed after editor saves (debounced) and on
 * foreground, the remote is fetched on open, foreground, Refresh and after a
 * push; nothing polls.
 */
export class SourceControlSyncService {
  private snapshot: SyncSnapshot = IDLE;
  private readonly listeners = new Set<() => void>();
  private port: SyncPort | null = null;
  private identity = "";
  private revision = 0;
  private input: SyncConfigureInput | null = null;
  private factory: SyncPortFactory | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  /** Operations run one at a time, so the snapshot always follows the last one. */
  private queue: Promise<unknown> = Promise.resolve();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): SyncSnapshot => this.snapshot;

  /** True while a debounced status waits; tests check that nothing is left scheduled. */
  get statusPending(): boolean {
    return this.statusTimer !== null;
  }

  /**
   * Off and Manual return before loading anything. Integrated opens the
   * folder's Git client once per folder, repository and branch, then reads
   * status and fetches.
   */
  async configure(input: SyncConfigureInput): Promise<void> {
    const { settings, folder } = input;
    if (settings.mode !== "integrated" || !folder) {
      this.input = input;
      if (this.identity !== "" || this.snapshot !== IDLE) this.stop();
      return;
    }
    const identity = [folder.id, settings.repositoryUrl, settings.branch, input.testMode ? "t" : ""].join("\n");
    // The same folder, repository and branch keep their client (and a Publish in progress).
    this.input = input;
    if (identity === this.identity) return;
    this.stop();
    const revision = this.revision;
    this.identity = identity;
    const hasGit = input.testMode || (await input.storage.exists(".git/HEAD").catch(() => false));
    if (revision !== this.revision) return;
    const blocked = integratedBlocker({ platform: input.platform, testMode: input.testMode, tier: folder.tier, hasGit });
    if (blocked) {
      this.set({ ...IDLE, blocked });
      return;
    }
    let port: SyncPort;
    try {
      this.factory = input.factory ?? await loadFactory();
      port = await this.factory.open(this.request(input));
    } catch (error) {
      if (revision !== this.revision) return;
      this.set({ ...IDLE, active: true, branch: settings.branch, problem: problemFrom("Could Not Open The Repository", error) });
      return;
    }
    if (revision !== this.revision) return;
    this.port = port;
    this.set({ ...IDLE, active: true, branch: settings.branch });
    await this.refresh();
  }

  /** Back to nothing: the project closed, or its mode is no longer Integrated. */
  stop(): void {
    this.revision += 1;
    this.clearTimer();
    this.port = null;
    this.identity = "";
    this.queue = Promise.resolve();
    this.set(IDLE);
  }

  dispose(): void {
    this.stop();
    this.input = null;
  }

  /** An editor save changed files: one status once the burst settles. */
  noteSaved(): void {
    if (!this.port) return;
    this.clearTimer();
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      void this.refreshStatus();
    }, STATUS_DEBOUNCE_MS);
  }

  /** Status from file stats; unchanged files are never read. */
  refreshStatus(): Promise<void> {
    this.clearTimer();
    return this.run(null, async (port) => {
      const status = await port.status();
      this.set({ ...this.snapshot, branch: status.branch, rows: this.group(status.changes).rows, statusReady: true });
    }, "Could Not Read Changes");
  }

  /** Refresh, foreground and opening the project: status, then what the remote has. */
  async refresh(): Promise<void> {
    await this.refreshStatus();
    await this.fetch();
  }

  /** Counts the commits on each side and lists the incoming ones. */
  fetch(): Promise<void> {
    return this.run("fetch", async (port) => {
      const remote = await port.fetch();
      this.set({ ...this.snapshot, ahead: remote.ahead, behind: remote.behind, incoming: remote.incoming, lastFetchAt: Date.now() });
    }, "Could Not Check For Changes");
  }

  /**
   * Commits the chosen rows (each asset with its blobs) with `message`, then
   * pushes when asked. Returns whether the commit was made.
   */
  async commit({ rowIds, message, push }: { rowIds: ReadonlySet<string>; message: string; push: boolean }): Promise<boolean> {
    let committed = false;
    await this.run("commit", async (port, input) => {
      const status = await port.status();
      const paths = commitPaths(this.group(status.changes), rowIds, input.lookup);
      if (paths.length === 0) throw new Error("Choose the assets to commit.");
      const author = await this.author(input);
      await port.commit({ paths, message, author });
      committed = true;
      const after = await port.status();
      this.set({ ...this.snapshot, rows: this.group(after.changes).rows, ahead: this.snapshot.ahead + 1, statusReady: true });
    }, "Could Not Commit");
    if (committed && push) await this.push();
    return committed;
  }

  /**
   * Pulls (fetch first). Without a choice for every asset changed on both
   * sides nothing changes and the conflicts come back. The caller saves or
   * discards unsaved documents first, runs it in the project write queue and
   * reloads `changedPaths` afterwards.
   */
  async pull(choices?: PullChoices): Promise<PullResult | null> {
    let result: PullResult | null = null;
    await this.run("pull", async (port, input) => {
      result = await port.pull({ author: await this.author(input), ...(choices ? { choices } : {}) });
      if (result.kind === "conflicts") return;
      const status = await port.status();
      const remote = await port.fetch();
      this.set({
        ...this.snapshot,
        rows: this.group(status.changes).rows,
        statusReady: true,
        ahead: remote.ahead,
        behind: remote.behind,
        incoming: remote.incoming,
        lastFetchAt: Date.now(),
      });
    }, "Could Not Pull");
    return result;
  }

  /**
   * Checks the locks on what the push sends and refuses paths someone else
   * holds; then uploads the LFS objects and moves the remote branch; then,
   * with Release Locks After Push, releases this device's locks on pushed
   * assets that have no further change. Fetches afterwards.
   */
  push(): Promise<void> {
    return this.run("push", async (port, input) => {
      const outgoing = await port.outgoing();
      const holders = await input.locks.theirs(outgoing);
      if (holders.length > 0) {
        const names = holders.map((lock) => `${lock.path} (${lock.ownerName})`).join(", ");
        this.set({ ...this.snapshot, problem: problemFrom("Could Not Push", new Error(`Locked by someone else: ${names}.`), holders) });
        return;
      }
      await port.push();
      const status = await port.status();
      const remote = await port.fetch();
      const rows = this.group(status.changes).rows;
      this.set({ ...this.snapshot, rows, statusReady: true, ahead: remote.ahead, behind: remote.behind, incoming: remote.incoming, lastFetchAt: Date.now() });
      if (input.settings.releaseLocksAfterPush) {
        const changed = new Set(rows.flatMap((row) => row.paths));
        await input.locks.releaseOwn(outgoing.filter((path) => !changed.has(path)));
      }
    }, "Could Not Push");
  }

  /**
   * Adds the `.blobs` rule to `.gitattributes` and commits only that file, so
   * asset blobs can be committed in a repository Haptic did not publish.
   */
  addLfsRule(): Promise<void> {
    return this.run("commit", async (port, input) => {
      const exists = await input.storage.exists(".gitattributes");
      const text = exists ? await input.storage.readText(".gitattributes") : "";
      await input.storage.writeText(".gitattributes", withLfsRule(text));
      await port.commit({ paths: [".gitattributes"], message: "Store asset blobs with Git LFS", author: await this.author(input) });
      const status = await port.status();
      this.set({ ...this.snapshot, rows: this.group(status.changes).rows, ahead: this.snapshot.ahead + 1, statusReady: true });
    }, "Could Not Add The Git LFS Rule");
  }

  /**
   * Publish: makes the open folder a new working copy of `repositoryUrl` and
   * holds it, so the Integrated mode that `beforeCommit` then saves finds it
   * open; commits every file and pushes. The caller has created the empty
   * repository and written `.gitattributes` and `.gitignore`.
   */
  async publish(request: {
    input: SyncConfigureInput;
    repositoryUrl: string;
    branch: string;
    beforeCommit: () => Promise<void>;
  }): Promise<void> {
    const { input, repositoryUrl, branch } = request;
    if (!input.folder) throw new Error("Open the project first.");
    this.stop();
    const revision = this.revision;
    this.input = { ...input, settings: { ...input.settings, mode: "integrated", repositoryUrl, branch } };
    this.identity = [input.folder.id, repositoryUrl, branch, input.testMode ? "t" : ""].join("\n");
    let port: SyncPort;
    try {
      this.factory = input.factory ?? await loadFactory();
      port = await this.factory.init(this.request(this.input));
    } catch (error) {
      if (revision === this.revision) this.stop();
      throw error;
    }
    if (revision !== this.revision) throw new Error("The project closed while publishing.");
    this.port = port;
    this.set({ ...IDLE, active: true, branch });
    await request.beforeCommit();
    let failure: unknown = null;
    await this.run("publish", async (open, live) => {
      const status = await open.status();
      if (status.changes.length === 0) throw new Error("There is nothing to publish.");
      await open.commit({ paths: status.changes.map((change) => change.path), message: "Publish project", author: await this.author(live) });
      await open.push();
      const after = await open.status();
      const remote = await open.fetch();
      this.set({ ...this.snapshot, rows: this.group(after.changes).rows, statusReady: true, ahead: remote.ahead, behind: remote.behind, incoming: remote.incoming, lastFetchAt: Date.now() });
    }, "Could Not Publish", (error) => {
      failure = error;
    });
    if (failure) throw failure;
  }

  private request(input: SyncConfigureInput): SyncPortRequest {
    return {
      storage: input.storage,
      folderId: input.folder!.id,
      repositoryUrl: input.settings.repositoryUrl,
      branch: input.settings.branch,
      testMode: input.testMode,
      transfer: {
        bytes: (count) => {
          const operation = this.snapshot.operation;
          if (operation) this.set({ ...this.snapshot, operation: { ...operation, bytes: operation.bytes + count } });
        },
        // Pull, push and publish run to the end; only Clone offers Cancel.
        signal: () => null,
      },
    };
  }

  private author(input: SyncConfigureInput): Promise<CommitAuthor> {
    return this.factory!.author(input.settings.repositoryUrl, input.testMode);
  }

  private group(changes: Parameters<typeof groupChanges>[0]) {
    return groupChanges(changes, this.input?.lookup ?? (() => null));
  }

  /**
   * Runs `work` on the open port after the operations before it. A
   * superseded revision (the project closed or changed mode) drops its
   * result. Failures become the snapshot's problem; `onError` sees them too.
   */
  private run(
    kind: SyncOperationKind | null,
    work: (port: SyncPort, input: SyncConfigureInput) => Promise<void>,
    title: string,
    onError?: (error: unknown) => void,
  ): Promise<void> {
    const revision = this.revision;
    const next = this.queue.then(async () => {
      const port = this.port;
      const input = this.input;
      if (!port || !input || revision !== this.revision) return;
      if (kind) this.set({ ...this.snapshot, operation: { kind, bytes: 0 }, problem: kind === "fetch" ? this.snapshot.problem : null });
      try {
        await work(port, input);
        if (revision === this.revision && kind === "fetch" && this.snapshot.problem?.title === title) this.set({ ...this.snapshot, problem: null });
      } catch (error) {
        onError?.(error);
        if (revision === this.revision) this.set({ ...this.snapshot, problem: problemFrom(title, error) });
      } finally {
        if (kind && revision === this.revision) this.set({ ...this.snapshot, operation: null });
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private clearTimer(): void {
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    this.statusTimer = null;
  }

  private set(next: SyncSnapshot): void {
    if (next === this.snapshot) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
