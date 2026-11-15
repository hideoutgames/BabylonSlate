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
    case "head": return `${snapshot.branch} · ${shortId(snapshot.head)}`;
    case "remote": return `origin/${snapshot.branch} · ${shortId(snapshot.remoteHead)}`;
    case "commit": return shortId(ref.id);
  }
}

function sameRef(a: DiffRef, b: DiffRef): boolean {
  return a.kind === b.kind && (a.kind !== "commit" || a.id === (b as { id: string }).id);
}

/** What a loaded diff depends on: a change in it loads the diff again. */
function dependency(target: DiffTarget, snapshot: SyncSnapshot): unknown[] {
  const working = target.base.kind === "working" || target.compare.kind === "working";
  return [refCommit(target.base, snapshot), refCommit(target.compare, snapshot), working ? snapshot.rows : null];
}

/** The diff's heavy part (worker client, reads), loaded with the first diff. */
export interface DiffLoader {
  load(target: DiffTarget, commits: { base: string | null; compare: string | null }, signal: AbortSignal): Promise<AssetDiff>;
  dispose(): void;
}

/**
 * The Source Control tab's open diff: which asset, which two versions and
 * which item is chosen, with the loaded result. The Changes window, Pull
 * Conflicts and the toolbar's Base and Compare pickers set it; Actors and
 * Diff read it. The worker and the reads load with the first diff; a diff
 * waits while a game covers the editor, and loads again when a version it
 * shows moves (a save, a commit, a fetch). Closing the project closes it.
 */
export class SourceControlDiffService {
  private state: DiffState = IDLE;
  private readonly listeners = new Set<() => void>();
  private loader: Promise<DiffLoader> | null = null;
  private running: AbortController | null = null;
  private loadedFor: unknown[] | null = null;
  private readonly unsubscribe: () => void;
  private readonly sync: SourceControlSyncService;
  private readonly createLoader: (sync: SourceControlSyncService) => Promise<DiffLoader>;

  constructor(
    sync: SourceControlSyncService,
    createLoader: (sync: SourceControlSyncService) => Promise<DiffLoader> = (service) =>
      import("./source-control-diff-loader").then((module) => module.createDiffLoader(service)),
  ) {
    this.sync = sync;
    this.createLoader = createLoader;
    this.unsubscribe = sync.subscribe(() => this.syncChanged());
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): DiffState => this.state;

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

  /** Loads the open diff again (after a revert wrote its file). */
  reload(): void {
    if (this.state.target) void this.load();
  }

  close(): void {
    this.cancel();
    this.loadedFor = null;
    this.set(IDLE);
    // The worker and its decoded versions go with the diff.
    void this.loader?.then((loader) => loader.dispose(), () => undefined);
    this.loader = null;
  }

  dispose(): void {
    this.close();
    this.unsubscribe();
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
    // A save, commit, pull or fetch that moved a version this diff shows.
    const now = dependency(target, snapshot);
    if (this.loadedFor && now.some((value, index) => value !== this.loadedFor![index])) void this.load();
  }

  private async load(): Promise<void> {
    const target = this.state.target;
    if (!target) return;
    this.cancel();
    const controller = new AbortController();
    this.running = controller;
    const snapshot = this.sync.getSnapshot();
    this.loadedFor = dependency(target, snapshot);
    this.set({ ...this.state, phase: "loading", error: null });
    try {
      await whenEditorAwake(controller.signal);
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
