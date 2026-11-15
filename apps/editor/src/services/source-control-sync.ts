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
import { editorQuiet, subscribeEditorQuiet } from "../lib/editor-quiet";
import { folderBoundStorage } from "../lib/folder-bound-storage";
import { TransferBytes } from "../lib/transfer-bytes";
import { commitPaths, groupChanges, type ChangeLookup, type ChangeRow } from "../lib/source-control-changes";
import { asksAdoption, integratedBlocker, type IntegratedBlocker } from "../lib/source-control-mode";

/** One status after a burst of editor saves. Status is stat based and cheap; this only coalesces the burst. */
export const STATUS_DEBOUNCE_MS = 800;

/** Network transfer of the operation running now, for its progress display. */
export interface TransferMonitor {
  /** Bytes one request sent and received. */
  bytes(count: number): void;
}

export interface SyncPortRequest {
  /** Bound to the project folder: refuses every call once another folder is open. */
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
  /** A new working copy with no commits, for Publish; `replace` replaces a `.git` an interrupted Publish left. */
  init(request: SyncPortRequest & { replace: boolean }): Promise<SyncPort>;
  /** Who commits: the repository host's account on this device. */
  author(repositoryUrl: string, testMode: boolean): Promise<CommitAuthor>;
  /**
   * Whether this device made Haptic the Git client of the working copy in the
   * folder `storage` is bound to (`haptic.integrated` in its `.git/config`).
   * Asked only on desktop (`asksAdoption`); it loads the Git core.
   */
  readAdoption(storage: ProjectStorage): Promise<boolean>;
  /** Records or clears it; nothing in `project.json` changes. */
  setAdoption(storage: ProjectStorage, adopted: boolean): Promise<void>;
}

/** Lock checks around a push, from the lock service. */
export interface SyncLocks {
  /** Locks someone else holds on any of `paths`; empty where the host has no locking. Rejects when the check fails. */
  theirs(paths: readonly string[]): Promise<FileLock[]>;
  /** Releases this device's locks on `paths`, except documents with unsaved edits. */
  releaseOwn(paths: readonly string[]): Promise<void>;
}

export type SyncOperationKind = "fetch" | "commit" | "pull" | "push" | "publish";

/** The running operation; its bytes are in `SourceControlSyncService.transfer`, which only transfer labels read. */
export interface SyncOperation {
  kind: SyncOperationKind;
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

/** A push refused before it started: someone else locks part of what it would send. */
class LockedByOthersError extends Error {
  readonly holders: readonly FileLock[];

  constructor(holders: readonly FileLock[]) {
    super(`Locked by someone else: ${holders.map((lock) => `${lock.path} (${lock.ownerName})`).join(", ")}.`);
    this.name = "LockedByOthersError";
    this.holders = holders;
  }
}

function problemFrom(title: string, error: unknown): SyncProblem {
  return {
    title,
    message: error instanceof Error ? error.message : String(error),
    kind: isSyncError(error) ? error.kind : null,
    code: isSyncError(error) ? error.code ?? null : null,
    holders: error instanceof LockedByOthersError ? error.holders : [],
  };
}

/** What an operation works with: everything belongs to the project it started in. */
interface Operation {
  port: SyncPort;
  input: SyncConfigureInput;
  /** The project folder's storage; refuses every call once another folder is open. */
  storage: ProjectStorage;
  /** Aborts when the project closes or changes mode. */
  signal: AbortSignal;
  /** Merges `patch` into the snapshot while the operation's project is still open; a late result changes nothing. */
  update: (patch: Partial<SyncSnapshot>) => void;
}

/**
 * The open project's Git sync in Integrated mode: one `SyncPort` per project
 * folder, opened lazily, and a stable snapshot for the Source Control tab,
 * the status bar and the phone's More Tools. Off and Manual load and request
 * nothing. Status is recomputed after editor saves (debounced) and on
 * foreground, the remote is fetched on open, foreground, Refresh and after a
 * push; nothing polls. Each operation belongs to the project it started in:
 * its port works on that folder only, its results reach the snapshot only
 * while the project is open, and a close cancels its transfer.
 */
export class SourceControlSyncService {
  private snapshot: SyncSnapshot = IDLE;
  private readonly listeners = new Set<() => void>();
  private port: SyncPort | null = null;
  /** The open folder's storage, bound to it. */
  private storage: ProjectStorage | null = null;
  private identity = "";
  /** Advances on every stop: operations of an earlier revision change nothing. */
  private revision = 0;
  private input: SyncConfigureInput | null = null;
  private factory: SyncPortFactory | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  /** The app is in the background. */
  private hidden = false;
  /** A status came due while away; it runs once the editor and the app are back. */
  private statusHeld = false;
  private wake: (() => void) | null = null;
  /** Operations run one at a time, so the snapshot always follows the last one. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The running operation's cancel. */
  private running: AbortController | null = null;
  /** Bytes the running operation has sent and received, apart from the snapshot: only transfer labels read it. */
  readonly transfer = new TransferBytes();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): SyncSnapshot => this.snapshot;

  /** True while a debounced or held status waits; tests check that nothing is left scheduled. */
  get statusPending(): boolean {
    return this.statusTimer !== null || this.statusHeld;
  }

  /**
   * Off and Manual return before loading anything. Integrated opens the
   * folder's Git client once per folder, repository and branch, then reads
   * status and fetches; a blocked folder (`integratedBlocker`, with a desktop
   * working copy's adoption read first) opens nothing.
   */
  async configure(input: SyncConfigureInput): Promise<void> {
    const { settings, folder } = input;
    if (settings.mode !== "integrated" || !folder) {
      if (this.identity !== "" || this.input || this.snapshot !== IDLE) this.stop();
      return;
    }
    const identity = [folder.id, settings.repositoryUrl, settings.branch, input.testMode ? "t" : ""].join("\n");
    // The same folder, repository and branch keep their client (and a Publish in progress).
    if (identity === this.identity) {
      this.input = input;
      return;
    }
    this.stop();
    const revision = this.revision;
    this.identity = identity;
    this.input = input;
    const storage = folderBoundStorage(input.storage, folder.id);
    const hasGit = input.testMode || (await storage.exists(".git/HEAD").catch(() => false));
    if (revision !== this.revision) return;
    const where = { platform: input.platform, testMode: input.testMode, tier: folder.tier, hasGit };
    let port: SyncPort;
    try {
      // Only a desktop working copy asks first. Its answer is in its Git config, so reading it loads the Git core, as opening it would.
      const adopted = asksAdoption(where) && (await (await this.factoryFor(input)).readAdoption(storage));
      if (revision !== this.revision) return;
      const blocked = integratedBlocker({ ...where, adopted });
      if (blocked) {
        this.set({ ...IDLE, blocked });
        return;
      }
      port = await (await this.factoryFor(input)).open(this.request(input, storage, revision));
    } catch (error) {
      if (revision !== this.revision) return;
      // Not opened: Refresh, foreground or the next configure tries again.
      this.identity = "";
      this.set({ ...IDLE, active: true, branch: settings.branch, problem: problemFrom("Could Not Open The Repository", error) });
      return;
    }
    if (revision !== this.revision) return;
    this.port = port;
    this.storage = storage;
    this.set({ ...IDLE, active: true, branch: settings.branch });
    await this.refresh();
  }

  /**
   * Records whether this device lets Haptic run Git in the open folder's
   * working copy: the answer to the one-Git-app warning on desktop, kept in
   * the working copy's own Git config (`project.json` is untouched). No
   * operation of the folder's client runs while it is written. In Integrated
   * mode the folder then decides again: accepting opens the client, Stop
   * Using closes it and shows the blocker. Rejects when it cannot be written.
   */
  async setAdopted(input: SyncConfigureInput, adopted: boolean): Promise<void> {
    const { folder } = input;
    if (!folder) return;
    this.stop();
    await this.settled();
    try {
      await (await this.factoryFor(input)).setAdoption(folderBoundStorage(input.storage, folder.id), adopted);
    } finally {
      if (input.settings.mode === "integrated") {
        // A configure that ran meanwhile read the folder before the write; read it again.
        this.stop();
        await this.configure(input);
      }
    }
  }

  /**
   * Back to nothing: the project closed, or its mode is no longer Integrated.
   * The running operation's transfer is cancelled and nothing still running
   * reaches the snapshot; await `settled()` before releasing the folder.
   */
  stop(): void {
    this.revision += 1;
    this.running?.abort();
    this.running = null;
    this.clearTimer();
    this.dropHeldStatus();
    this.port = null;
    this.storage = null;
    this.identity = "";
    this.input = null;
    this.transfer.reset();
    this.set(IDLE);
  }

  /** Resolves once every operation started so far has ended (after `stop()`, soon: transfers are cancelled). */
  settled(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  dispose(): void {
    this.stop();
  }

  /**
   * An editor save changed files: one status once the burst settles. While a
   * game covers the editor (`editorQuiet`) or the app is hidden, the status
   * waits and runs once on return.
   */
  noteSaved(): void {
    if (!this.port) return;
    if (this.away()) {
      this.holdStatus();
      return;
    }
    this.clearTimer();
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      if (this.away()) this.holdStatus();
      else void this.refreshStatus();
    }, STATUS_DEBOUNCE_MS);
  }

  /** The app went to the background or came back (the editor-quiet flag is read directly). */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.resumeStatus();
  }

  /** Status from file stats; unchanged files are never read. */
  async refreshStatus(): Promise<void> {
    this.clearTimer();
    this.dropHeldStatus();
    await this.run(null, "Could Not Read Changes", async ({ port, input, update }) => {
      const status = await port.status();
      update({ branch: status.branch, rows: groupChanges(status.changes, input.lookup).rows, statusReady: true });
    });
  }

  /** Refresh, foreground and opening the project: status, then what the remote has. A client that could not open opens again. */
  async refresh(): Promise<void> {
    if (!this.port && this.identity === "" && this.input?.settings.mode === "integrated") {
      await this.configure(this.input);
      return;
    }
    await this.refreshStatus();
    await this.fetch();
  }

  /** Counts the commits on each side and lists the incoming ones. */
  fetch(): Promise<void> {
    return this.fetchFor(this.revision);
  }

  /**
   * Commits the chosen rows (each asset with its blobs) with `message`, then
   * pushes when asked. Returns whether the commit was made.
   */
  async commit({ rowIds, message, push }: { rowIds: ReadonlySet<string>; message: string; push: boolean }): Promise<boolean> {
    const revision = this.revision;
    let committed = false;
    await this.run("commit", "Could Not Commit", async ({ port, input }) => {
      const status = await port.status();
      const paths = commitPaths(groupChanges(status.changes, input.lookup), rowIds, input.lookup);
      if (paths.length === 0) throw new Error("Choose the assets to commit.");
      await port.commit({ paths, message, author: await this.author(input) });
      committed = true;
    }, revision);
    if (!committed) return false;
    await this.readLocal(revision);
    // Only while the project that committed is open: never another project's push.
    if (push) await this.pushFor(revision);
    return true;
  }

  /**
   * Pulls (fetch first). Without a choice for every asset changed on both
   * sides nothing changes and the conflicts come back. The caller saves or
   * discards unsaved documents first, runs it in the project write queue and
   * reloads `changedPaths` afterwards. The counts come from what the pull
   * fetched; nothing asks the remote again.
   */
  async pull(choices?: PullChoices): Promise<PullResult | null> {
    const revision = this.revision;
    let result: PullResult | null = null;
    await this.run("pull", "Could Not Pull", async ({ port, input, signal, update }) => {
      result = await port.pull({ author: await this.author(input), signal, ...(choices ? { choices } : {}) });
      update({ lastFetchAt: Date.now() });
    }, revision);
    if (result) await this.readLocal(revision);
    return result;
  }

  /**
   * Checks the locks on what the push sends and refuses paths someone else
   * holds; then uploads the LFS objects and moves the remote branch. Each step
   * after a push that went through has its own problem title, so none of them
   * reports the push as failed: the counts and changes from local refs, then,
   * with Release Locks After Push, this device's locks on pushed assets that
   * have no further change, then a fetch.
   */
  push(): Promise<void> {
    return this.pushFor(this.revision);
  }

  /** The push of the project open at `revision`; nothing runs once another is open. */
  private async pushFor(revision: number): Promise<void> {
    let pushed: string[] | null = null;
    await this.run("push", "Could Not Push", async ({ port, input, signal }) => {
      const outgoing = await port.outgoing();
      const holders = await input.locks.theirs(outgoing);
      if (holders.length > 0) throw new LockedByOthersError(holders);
      await port.push({ signal });
      pushed = outgoing;
    }, revision);
    if (!pushed) return;
    const outgoing: readonly string[] = pushed;
    const rows = await this.readLocal(revision);
    // Without the changes it cannot tell which pushed assets changed again, so it releases nothing.
    if (rows) {
      await this.run(null, "Could Not Release Locks", async ({ input }) => {
        if (!input.settings.releaseLocksAfterPush) return;
        const changed = new Set(rows.flatMap((row) => row.paths));
        await input.locks.releaseOwn(outgoing.filter((path) => !changed.has(path)));
      }, revision);
    }
    await this.fetchFor(revision);
  }

  private async fetchFor(revision: number): Promise<void> {
    await this.run("fetch", "Could Not Check For Changes", async ({ port, signal, update }) => {
      const remote = await port.fetch({ signal });
      update({ ahead: remote.ahead, behind: remote.behind, incoming: remote.incoming, lastFetchAt: Date.now() });
    }, revision);
  }

  /**
   * Adds the `.blobs` rule to `.gitattributes` and commits only that file, so
   * asset blobs can be committed in a repository Haptic did not publish.
   */
  async addLfsRule(): Promise<void> {
    const revision = this.revision;
    let committed = false;
    await this.run("commit", "Could Not Add The Git LFS Rule", async ({ port, input, storage }) => {
      const exists = await storage.exists(".gitattributes");
      const text = exists ? await storage.readText(".gitattributes") : "";
      await storage.writeText(".gitattributes", withLfsRule(text));
      await port.commit({ paths: [".gitattributes"], message: "Store asset blobs with Git LFS", author: await this.author(input) });
      committed = true;
    }, revision);
    if (committed) await this.readLocal(revision);
  }

  /**
   * Publish: makes the open folder a new working copy of `repositoryUrl` and
   * holds it, so the Integrated mode that `beforeCommit` then saves finds it
   * open; commits every file and pushes. The caller has created the empty
   * repository and written `.gitattributes` and `.gitignore`. `replace`
   * replaces a `.git` an interrupted Publish left (the mode rules decide).
   */
  async publish(request: {
    input: SyncConfigureInput;
    repositoryUrl: string;
    branch: string;
    replace: boolean;
    beforeCommit: () => Promise<void>;
  }): Promise<void> {
    const { input, repositoryUrl, branch } = request;
    if (!input.folder) throw new Error("Open the project first.");
    this.stop();
    const revision = this.revision;
    const live = { ...input, settings: { ...input.settings, mode: "integrated" as const, repositoryUrl, branch } };
    this.input = live;
    this.identity = [input.folder.id, repositoryUrl, branch, input.testMode ? "t" : ""].join("\n");
    const storage = folderBoundStorage(input.storage, input.folder.id);
    let port: SyncPort;
    try {
      const factory = await this.factoryFor(input);
      // In the queue, so a close waits for the new `.git` to be written.
      port = await this.enqueue(() => factory.init({ ...this.request(live, storage, revision), replace: request.replace }));
    } catch (error) {
      if (revision === this.revision) this.stop();
      throw error;
    }
    if (revision !== this.revision) throw new Error("The project closed while publishing.");
    this.port = port;
    this.storage = storage;
    this.set({ ...IDLE, active: true, branch });
    await request.beforeCommit();
    const published = await this.run("publish", "Could Not Publish", async ({ port: open, input: current, signal }) => {
      const status = await open.status();
      if (status.changes.length === 0) throw new Error("There is nothing to publish.");
      await open.commit({ paths: status.changes.map((change) => change.path), message: "Publish project", author: await this.author(current) });
      await open.push({ signal });
    }, revision, { rethrow: true });
    if (!published) throw new Error("The project closed while publishing.");
    await this.readLocal(revision);
    await this.fetchFor(revision);
  }

  private request(input: SyncConfigureInput, storage: ProjectStorage, revision: number): SyncPortRequest {
    return {
      storage,
      folderId: input.folder!.id,
      repositoryUrl: input.settings.repositoryUrl,
      branch: input.settings.branch,
      testMode: input.testMode,
      transfer: {
        bytes: (count) => {
          if (revision === this.revision && this.snapshot.operation) this.transfer.add(count);
        },
      },
    };
  }

  /** The Git client module (loaded on first use), or the one the input names. */
  private async factoryFor(input: SyncConfigureInput): Promise<SyncPortFactory> {
    this.factory = input.factory ?? await loadFactory();
    return this.factory;
  }

  private author(input: SyncConfigureInput): Promise<CommitAuthor> {
    return this.factory!.author(input.settings.repositoryUrl, input.testMode);
  }

  /**
   * The changes and the counts from local refs, after a commit, pull or push
   * (no network): its own step, so a failure here never reports the
   * operation before it as failed. Resolves to the rows, or null when it failed.
   */
  private async readLocal(revision: number): Promise<readonly ChangeRow[] | null> {
    let rows: readonly ChangeRow[] | null = null;
    await this.run(null, "Could Not Read Changes", async ({ port, input, update }) => {
      const status = await port.status();
      const remote = await port.remoteState();
      rows = groupChanges(status.changes, input.lookup).rows;
      update({ branch: status.branch, rows, statusReady: true, ahead: remote.ahead, behind: remote.behind, incoming: remote.incoming });
    }, revision);
    return rows;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Runs `work` after the operations before it, if `revision` is still the
   * open project's. Its failure becomes the snapshot's problem under `title`;
   * its success clears a problem with that title. Resolves to whether it ran
   * and succeeded (`rethrow` rejects with the failure instead).
   */
  private run(
    kind: SyncOperationKind | null,
    title: string,
    work: (operation: Operation) => Promise<void>,
    revision = this.revision,
    options: { rethrow?: boolean } = {},
  ): Promise<boolean> {
    return this.enqueue(async () => {
      const { port, input, storage } = this;
      if (!port || !input || !storage || revision !== this.revision) return false;
      const controller = new AbortController();
      this.running = controller;
      const update = (patch: Partial<SyncSnapshot>) => {
        if (revision === this.revision) this.set({ ...this.snapshot, ...patch });
      };
      // Starting a commit, pull, push or publish replaces the last problem; a fetch keeps it.
      if (kind) {
        this.transfer.reset();
        update({ operation: { kind }, ...(kind === "fetch" ? {} : { problem: null }) });
      }
      try {
        await work({ port, input, storage, signal: controller.signal, update });
        if (this.snapshot.problem?.title === title) update({ problem: null });
        return true;
      } catch (error) {
        update({ problem: problemFrom(title, error) });
        if (options.rethrow && revision === this.revision) throw error;
        return false;
      } finally {
        if (this.running === controller) this.running = null;
        if (kind) update({ operation: null });
      }
    });
  }

  private clearTimer(): void {
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    this.statusTimer = null;
  }

  private away(): boolean {
    return this.hidden || editorQuiet();
  }

  /** A status came due while away: no timer runs; it waits for the editor and the app to be back. */
  private holdStatus(): void {
    this.clearTimer();
    this.statusHeld = true;
    this.wake ??= subscribeEditorQuiet(() => this.resumeStatus());
  }

  private resumeStatus(): void {
    if (!this.statusHeld || this.away()) return;
    this.dropHeldStatus();
    this.noteSaved();
  }

  private dropHeldStatus(): void {
    this.statusHeld = false;
    this.wake?.();
    this.wake = null;
  }

  private set(next: SyncSnapshot): void {
    if (next === this.snapshot) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
