import type { CommitInfo } from "@haptic/source-control";
import type { SourceControlSyncService } from "./source-control-sync";

/** Commits read per page: one screen or two, never the whole history. */
export const HISTORY_PAGE = 50;

/** Lists kept: History's two scopes and the few assets diffs moved between lately. */
const KEPT_LISTS = 8;

/** One asset's commits (or every asset's), newest first, as far as they were read. */
export interface CommitList {
  /** What it was read for: the asset (or none), the branch and its commit. */
  readonly key: string;
  readonly commits: readonly CommitInfo[];
  /** The first page arrived (or failed). */
  readonly ready: boolean;
  readonly hasMore: boolean;
  /** The last page ended at this shallow copy's oldest commit. */
  readonly shallow: boolean;
  readonly loadingOlder: boolean;
  readonly error: string | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The commit lists History and the Diff's **Base** and **Compare** pickers
 * share: one per asset (and one for every asset), for the branch and commit
 * checked out, read a page of `HISTORY_PAGE` at a time from
 * `SourceControlSyncService.history` and only when one of them asks
 * (`load`), so a menu opened on the asset History shows reads nothing, and
 * a commit History reached is in the menus. **Load Older** (either of them)
 * reads the next page, downloading older history at the end of a shallow
 * copy. A commit, pull or branch switch moves the key, so the list is read
 * again on the next ask. A few lists are kept, the last used.
 */
export class CommitHistory {
  private readonly lists = new Map<string, CommitList>();
  private readonly listeners = new Set<() => void>();
  private readonly sync: SourceControlSyncService;

  constructor(sync: SourceControlSyncService) {
    this.sync = sync;
  }

  /** Lists change, and so does the commit they belong to (a list read for another commit reads as none). */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    const unsubscribe = this.sync.subscribe(listener);
    return () => {
      this.listeners.delete(listener);
      unsubscribe();
    };
  };

  /** `path`'s list (null: every asset) for the branch and commit checked out now; null before `load` asked for it. */
  list(path: string | null): CommitList | null {
    const entry = this.lists.get(path ?? "");
    return entry && entry.key === this.keyOf(path) ? entry : null;
  }

  /**
   * Reads the first page of `path`'s list, unless it is read or being read
   * for the branch and commit checked out now; a first page that failed is
   * read again.
   */
  load(path: string | null): void {
    const key = this.keyOf(path);
    const known = this.list(path);
    if (known && !(known.error !== null && known.commits.length === 0)) {
      // Kept as the most recently used.
      this.lists.delete(path ?? "");
      this.lists.set(path ?? "", known);
      return;
    }
    this.put(path, { key, commits: [], ready: false, hasMore: false, shallow: false, loadingOlder: false, error: null });
    this.sync.history({ limit: HISTORY_PAGE, ...(path ? { path } : {}) }).then(
      (page) => this.patch(path, key, { commits: page.commits, hasMore: page.hasMore, shallow: page.shallow, ready: true }),
      (error: unknown) => this.patch(path, key, { ready: true, error: messageOf(error) }),
    );
  }

  /**
   * The next page of `path`'s list (History's **Load Older History**, the
   * pickers' **Load Older**). After a page that ended at a shallow copy's
   * oldest commit the pages are read again, longer: older history may show
   * that commit did not change the asset.
   */
  async loadOlder(path: string | null): Promise<void> {
    const entry = this.list(path);
    if (!entry?.ready || entry.loadingOlder || !entry.hasMore) return;
    const { key } = entry;
    this.patch(path, key, { loadingOlder: true });
    const scope = path ? { path } : {};
    try {
      const next = entry.shallow
        ? await this.sync.history({ limit: entry.commits.length + HISTORY_PAGE, deepen: true, ...scope })
        : await this.sync.history({ limit: HISTORY_PAGE, skip: entry.commits.length, deepen: true, ...scope });
      const known = new Set(entry.commits.map((commit) => commit.id));
      const commits = entry.shallow ? next.commits : [...entry.commits, ...next.commits.filter((commit) => !known.has(commit.id))];
      this.patch(path, key, { commits, hasMore: next.hasMore, shallow: next.shallow, loadingOlder: false, error: null });
    } catch (error) {
      this.patch(path, key, { loadingOlder: false, error: messageOf(error) });
    }
  }

  private keyOf(path: string | null): string {
    const { branch, head } = this.sync.getSnapshot();
    return [path ?? "", branch, head ?? ""].join("\n");
  }

  private put(path: string | null, entry: CommitList): void {
    this.lists.delete(path ?? "");
    this.lists.set(path ?? "", entry);
    for (const old of this.lists.keys()) {
      if (this.lists.size <= KEPT_LISTS) break;
      this.lists.delete(old);
    }
    this.emit();
  }

  /** Changes the list read for `key`; one read for another commit since is left alone. */
  private patch(path: string | null, key: string, patch: Partial<CommitList>): void {
    const entry = this.lists.get(path ?? "");
    if (entry?.key !== key) return;
    this.lists.set(path ?? "", { ...entry, ...patch });
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
