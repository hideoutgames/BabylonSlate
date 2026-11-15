import type { AssetDiff } from "@haptic/assets/asset-diff";
import { whenEditorAwake } from "../lib/editor-quiet";
import type { SourceControlSyncService, SyncSnapshot } from "./source-control-sync";

/** One side of a diff: the working copy, HEAD, the remote branch as last fetched, or a commit. */
export type DiffRef =
  | { kind: "working" }
  | { kind: "head" }
  | { kind: "remote" }
  | { kind: "commit"; id: string };

export const WORKING_COPY: DiffRef = { kind: "working" };
export const HEAD: DiffRef = { kind: "head" };
export const REMOTE: DiffRef = { kind: "remote" };

/** The asset a diff shows and the two versions it compares. */
export interface DiffTarget {
  path: string;
  name: string;
  /** Its registry type, for icons and the **Open <Kind>** label; null for a file that is not an asset. */
  type: string | null;
  base: DiffRef;
  compare: DiffRef;
}

export interface DiffState {
  target: DiffTarget | null;
  /** The item the Actors window chose: an actor, a graph or member, a group. */
  selection: string | null;
  phase: "idle" | "loading" | "ready" | "error";
  diff: AssetDiff | null;
  error: string | null;
}

const IDLE: DiffState = { target: null, selection: null, phase: "idle", diff: null, error: null };

/** The commit a ref names now: null for the working copy and for a side with no commit (no remote branch yet). */
export function refCommit(ref: DiffRef, snapshot: Pick<SyncSnapshot, "head" | "remoteHead">): string | null {
  if (ref.kind === "head") return snapshot.head;
  if (ref.kind === "remote") return snapshot.remoteHead;
  if (ref.kind === "commit") return ref.id;
  return null;
}

export function shortId(commit: string | null): string {
  return commit ? commit.slice(0, 7) : "None";
}

/** `Working Copy`, `main · 8f3c2a1`, `origin/main · 1a2b3c4`, `8f3c2a1`. */
export function refLabel(ref: DiffRef, snapshot: Pick<SyncSnapshot, "head" | "remoteHead" | "branch">): string {
  switch (ref.kind) {
    case "working": return "Working Copy";
    case "head": return `${snapshot.branch || "HEAD"} · ${shortId(snapshot.head)}`;
    case "remote": return `origin/${snapshot.branch || "HEAD"} · ${shortId(snapshot.remoteHead)}`;
    case "commit": return shortId(ref.id);
  }
}

function sameRef(a: DiffRef, b: DiffRef): boolean {
  return a.kind === b.kind && (a.kind !== "commit" || a.id === (b as { id: string }).id);
}

/** The commits a loaded diff shows: when one moves (a commit, pull or fetch), it loads again. */
function commitsShown(target: DiffTarget, snapshot: SyncSnapshot): string {
  return `${refCommit(target.base, snapshot)}\n${refCommit(target.compare, snapshot)}`;
}

function showsWorkingCopy(target: DiffTarget): boolean {
  return target.base.kind === "working" || target.compare.kind === "working";
}

/** The asset's own working files: the `.hasset` and the changed blobs its Changes row carries. */
function workingPaths(target: DiffTarget, snapshot: SyncSnapshot): readonly string[] {
  return snapshot.rows.find((row) => row.id === target.path)?.paths ?? [target.path];
}

/**
 * A file written this close before its stats were read may change again
 * within the same time stamp (coarse file system clocks), so it counts as
 * changed once more, as Git's racy check does.
 */
const RACY_MS = 2000;

/**
 * How long the worker and its decoded versions outlive the last window that
 * showed the diff: a look at another tab keeps them, leaving the Source
 * Control tab frees them.
 */
export const DIFF_IDLE_MS = 60_000;

/** The diff's heavy part (worker client, reads), loaded with the first diff. */
export interface DiffLoader {
  load(target: DiffTarget, commits: { base: string | null; compare: string | null }, signal: AbortSignal): Promise<AssetDiff>;
  dispose(): void;
}

/**
 * The Source Control tab's open diff: which asset, which two versions and
 * which item is chosen, with the loaded result. The Changes window, Pull
 * Conflicts and the toolbar's Base and Compare pickers set it; Actors and
 * Diff read it, and load it only while one of them is on screen (`watch`).
 * The worker and the reads load with the first diff; a diff waits while a
 * game covers the editor, and loads again when a version it shows moves: a
 * commit it names (a commit, a pull, a fetch), or, for the working copy, the
 * asset's own files (a status after a save of another asset reloads
 * nothing). While no window shows it, a move only marks it stale, checked
 * when one does; `DIFF_IDLE_MS` after the last one went, the worker, its
 * decoded versions and the loaded result go. Closing the project closes it.
 */
export class SourceControlDiffService {
  private state: DiffState = IDLE;
  private readonly listeners = new Set<() => void>();
  private loader: Promise<DiffLoader> | null = null;
  private running: AbortController | null = null;
  /** The commits the loaded diff shows. */
  private loadedFor: string | null = null;
  /** The working files' stats when the loaded diff read them, and when that was. */
  private stamp: { key: string; at: number } | null = null;
  /** The status rows last checked, so only a new status checks the files again. */
  private rowsSeen: SyncSnapshot["rows"] | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Windows on screen that show the diff (Actors, Diff). */
  private viewers = 0;
  /** A version it shows may have moved while no window showed it. */
  private stale = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly sync: SourceControlSyncService;
  private readonly createLoader: (sync: SourceControlSyncService) => Promise<DiffLoader>;

  constructor(
    sync: SourceControlSyncService,
    createLoader: (sync: SourceControlSyncService) => Promise<DiffLoader> = (service) =>
      import("./source-control-diff-loader").then((module) => module.createDiffLoader(service)),
  ) {
    this.sync = sync;
    this.createLoader = createLoader;
  }

  /**
   * Follows the project's sync (loads again when a shown version moves,
   * closes when the project does) until the returned function detaches it,
   * which also closes the diff. The editor attaches it in an effect.
   */
  attach(): () => void {
    this.unsubscribe?.();
    const unsubscribe = this.sync.subscribe(() => this.syncChanged());
    this.unsubscribe = unsubscribe;
    return () => {
      unsubscribe();
      if (this.unsubscribe === unsubscribe) this.unsubscribe = null;
      this.close();
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): DiffState => this.state;

  /**
   * A window that shows the diff is on screen until the returned function is
   * called: the diff loads (or checks what moved while hidden) when the first
   * one appears, and frees its worker `DIFF_IDLE_MS` after the last one goes.
   */
  watch(): () => void {
    this.viewers += 1;
    this.clearIdle();
    if (this.viewers === 1) this.shown();
    let watching = true;
    return () => {
      if (!watching) return;
      watching = false;
      this.viewers -= 1;
      if (this.viewers === 0) this.idleTimer = setTimeout(() => this.idle(), DIFF_IDLE_MS);
    };
  }

  /** Shows `path`'s diff, by default HEAD against the working copy. */
  open(target: Omit<DiffTarget, "base" | "compare"> & Partial<Pick<DiffTarget, "base" | "compare">>): void {
    this.set({ ...IDLE, target: { base: HEAD, compare: WORKING_COPY, ...target } });
    void this.load();
  }

  /** Another base or compare version for the open diff. */
  setRefs(refs: Partial<Pick<DiffTarget, "base" | "compare">>): void {
    const target = this.state.target;
    if (!target) return;
    const next = { ...target, ...refs };
    if (sameRef(next.base, target.base) && sameRef(next.compare, target.compare)) return;
    this.set({ ...this.state, target: next });
    void this.load();
  }

  select(selection: string | null): void {
    if (selection !== this.state.selection) this.set({ ...this.state, selection });
  }

  close(): void {
    this.cancel();
    this.clearIdle();
    this.loadedFor = null;
    this.stamp = null;
    this.stale = false;
    this.set(IDLE);
    // The worker and its decoded versions go with the diff.
    this.disposeLoader();
  }

  private disposeLoader(): void {
    void this.loader?.then((loader) => loader.dispose(), () => undefined);
    this.loader = null;
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** The first window showing the diff appeared: load it, or check what moved while none did. */
  private shown(): void {
    const target = this.state.target;
    if (!target) return;
    if (this.loadedFor === null) {
      void this.load();
      return;
    }
    if (!this.stale) return;
    this.stale = false;
    this.followSync(target);
  }

  /** No window has shown the diff for `DIFF_IDLE_MS`: the worker, its decoded versions and the result go; showing it loads it again. */
  private idle(): void {
    this.idleTimer = null;
    if (this.viewers > 0) return;
    this.cancel();
    this.disposeLoader();
    this.loadedFor = null;
    this.stamp = null;
    this.stale = false;
    if (this.state.target) this.set({ ...this.state, phase: "loading", diff: null, error: null });
  }

  private cancel(): void {
    this.running?.abort();
    this.running = null;
  }

  private syncChanged(): void {
    const snapshot = this.sync.getSnapshot();
    const target = this.state.target;
    if (!target) return;
    if (!snapshot.active) {
      this.close();
      return;
    }
    if (this.loadedFor === null) return;
    // Hidden (another tab, an Auto-Save of a large Scene): nothing is read until a window shows it.
    if (this.viewers === 0) {
      this.stale = true;
      return;
    }
    this.followSync(target);
  }

  /** Loads again what moved since the diff loaded: a commit it shows, or the asset's own working files. */
  private followSync(target: DiffTarget): void {
    const snapshot = this.sync.getSnapshot();
    // A commit, pull or fetch that moved a commit this diff shows.
    if (commitsShown(target, snapshot) !== this.loadedFor) {
      void this.load();
      return;
    }
    // A status ran: only a change to the asset's own files loads the working copy again.
    if (showsWorkingCopy(target) && snapshot.rows !== this.rowsSeen) {
      this.rowsSeen = snapshot.rows;
      void this.reloadIfWorkingChanged(target);
    }
  }

  private async reloadIfWorkingChanged(target: DiffTarget): Promise<void> {
    const stamp = this.stamp;
    let changed = true;
    try {
      const now = stamp ? await this.sync.workingStamp(workingPaths(target, this.sync.getSnapshot())) : null;
      changed = !stamp || !now || now.key !== stamp.key || now.newest >= stamp.at - RACY_MS;
    } catch {
      // Unreadable stats: load again, which reports what is wrong.
    }
    if (changed && this.state.target === target && this.stamp === stamp) void this.load();
  }

  private async load(): Promise<void> {
    const target = this.state.target;
    if (!target) return;
    this.cancel();
    if (this.viewers === 0) {
      // Nothing shows it: the first window that does loads it.
      this.loadedFor = null;
      this.stamp = null;
      this.set({ ...this.state, phase: "loading", error: null });
      return;
    }
    const controller = new AbortController();
    this.running = controller;
    const snapshot = this.sync.getSnapshot();
    this.loadedFor = commitsShown(target, snapshot);
    this.rowsSeen = snapshot.rows;
    this.stamp = null;
    this.set({ ...this.state, phase: "loading", error: null });
    try {
      await whenEditorAwake(controller.signal);
      if (showsWorkingCopy(target)) {
        // Read before the files, so a save during the load still counts as a change after it.
        const at = Date.now();
        const stamp = await this.sync.workingStamp(workingPaths(target, snapshot)).catch(() => null);
        if (this.running === controller) this.stamp = stamp ? { key: stamp.key, at } : null;
      }
      this.loader ??= this.createLoader(this.sync);
      const loader = await this.loader;
      controller.signal.throwIfAborted();
      const diff = await loader.load(target, { base: refCommit(target.base, snapshot), compare: refCommit(target.compare, snapshot) }, controller.signal);
      if (this.running !== controller) return;
      this.running = null;
      this.set({ ...this.state, phase: "ready", diff, error: null, selection: this.state.selection ?? firstChange(diff) });
    } catch (error) {
      if (this.running !== controller) return;
      this.running = null;
      this.set({ ...this.state, phase: "error", diff: null, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private set(next: DiffState): void {
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

/** The first changed item, chosen when the diff opens: an actor, or the first graph that changed. */
function firstChange(diff: AssetDiff): string | null {
  const view = diff.view;
  if (view.kind === "scene") return view.rows.find((row) => row.kind === "actor" && row.status !== "unchanged")?.id ?? null;
  if (view.kind === "graph") return view.sections.find((section) => section.status !== "unchanged")?.id ?? null;
  return null;
}
