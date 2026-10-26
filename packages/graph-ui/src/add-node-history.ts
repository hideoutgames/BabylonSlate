/**
 * Learned Add Node picks per dragged pin. Each context (graph scope, source
 * node type, pin and its resolved type) keeps decayed pick scores; nodes
 * picked often enough rise to the top of the pin-filtered palette while every
 * other row keeps its default relevance order. Device-local and disposable:
 * an unreadable or outdated store is discarded rather than migrated.
 */
import type { SerializedPin } from "./graph-types";

/** Graphs that learn from Add Node picks; other graphs keep the default order. */
export type AddNodeHistoryScope = "script" | "material" | "particle";

/** One saved context: last-used day and `[score, day]` per palette node id. */
export interface AddNodeHistoryRecord {
  key: string;
  day: number;
  picks: Record<string, [score: number, day: number]>;
}

/** Persistence port; failures are swallowed by the store. */
export interface AddNodeHistoryBackend {
  loadAll(): Promise<AddNodeHistoryRecord[]>;
  write(put: AddNodeHistoryRecord[], remove: string[]): Promise<void>;
  clear(): Promise<void>;
}

/** A pick loses half its weight every three weeks. */
export const HALF_LIFE_DAYS = 21;
/** Two recent picks are needed before a node moves up. */
export const PROMOTE_MIN_SCORE = 2;
export const MAX_PROMOTED = 5;
export const MAX_PICKS_PER_CONTEXT = 16;
export const MAX_CONTEXTS = 1000;
/** Decayed scores below this are forgotten. */
const MIN_KEPT_SCORE = 0.05;
const SAVE_DELAY_MS = 1000;
const DAY_MS = 86_400_000;

const decayed = (score: number, day: number, today: number) =>
  score * 0.5 ** (Math.max(0, today - day) / HALF_LIFE_DAYS);

function isRecord(value: unknown): value is AddNodeHistoryRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AddNodeHistoryRecord>;
  return (
    typeof record.key === "string" &&
    Number.isFinite(record.day) &&
    Boolean(record.picks) &&
    typeof record.picks === "object" &&
    Object.values(record.picks!).every(
      (pick) =>
        Array.isArray(pick) &&
        pick.length === 2 &&
        Number.isFinite(pick[0]) &&
        Number.isFinite(pick[1]),
    )
  );
}

/** Context key for a pin dragged from `sourceNodeType`. */
export function addNodeHistoryKey(
  scope: AddNodeHistoryScope,
  sourceNodeType: string,
  pin: SerializedPin,
): string {
  return [scope, sourceNodeType, pin.direction, pin.id, JSON.stringify(pin.type)].join("|");
}

export class AddNodeHistory {
  /** Insertion order is recency: the first entry is evicted first. */
  private contexts = new Map<string, AddNodeHistoryRecord>();
  private dirty = new Set<string>();
  private removed = new Set<string>();
  private loading: Promise<void> | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly backend: AddNodeHistoryBackend;
  private readonly now: () => number;

  constructor(backend: AddNodeHistoryBackend, now: () => number = Date.now) {
    this.backend = backend;
    this.now = now;
  }

  private today(): number {
    return Math.floor(this.now() / DAY_MS);
  }

  /** Reads the saved history once; picks made meanwhile are kept. */
  load(): Promise<void> {
    if (this.loading) return this.loading;
    const generation = this.generation;
    this.loading = this.backend
      .loadAll()
      .catch(() => [])
      .then((records) => {
        if (generation !== this.generation) return;
        const loaded = records
          .filter(isRecord)
          .filter((record) => !this.contexts.has(record.key))
          .sort((left, right) => left.day - right.day);
        this.contexts = new Map([
          ...loaded.map((record) => [record.key, record] as const),
          ...this.contexts,
        ]);
        this.evict();
      });
    return this.loading;
  }

  isEmpty(): boolean {
    return this.contexts.size === 0;
  }

  /**
   * Moves up to `MAX_PROMOTED` nodes picked often enough in `key` to the
   * front, highest decayed score first (ties keep the given order); every
   * other node keeps its place in the given order.
   */
  rank<T extends { id: string }>(key: string, ordered: readonly T[]): T[] {
    const context = this.contexts.get(key);
    if (!context) return [...ordered];
    const today = this.today();
    const scores = new Map<string, number>();
    for (const [id, [score, day]] of Object.entries(context.picks)) {
      const value = decayed(score, day, today);
      if (value >= PROMOTE_MIN_SCORE) scores.set(id, value);
    }
    if (scores.size === 0) return [...ordered];
    const promoted = ordered
      .filter((node) => scores.has(node.id))
      .sort((left, right) => scores.get(right.id)! - scores.get(left.id)!)
      .slice(0, MAX_PROMOTED);
    const front = new Set(promoted);
    return [...promoted, ...ordered.filter((node) => !front.has(node))];
  }

  record(key: string, nodeId: string): void {
    const today = this.today();
    const context = this.contexts.get(key) ?? { key, day: today, picks: {} };
    const previous = context.picks[nodeId];
    const picked: [number, number] = [
      (previous ? decayed(previous[0], previous[1], today) : 0) + 1,
      today,
    ];
    // The pick just made always stays; key order is recency, so the stable
    // sort lets the more recent of two equal scores survive the cap.
    const others = Object.entries(context.picks)
      .filter(([id]) => id !== nodeId)
      .map(([id, [score, day]]) => [id, decayed(score, day, today), score, day] as const)
      .filter(([, value]) => value >= MIN_KEPT_SCORE)
      .sort((left, right) => right[1] - left[1])
      .slice(0, MAX_PICKS_PER_CONTEXT - 1);
    context.picks = Object.fromEntries([
      [nodeId, picked],
      ...others.map(([id, , score, day]): [string, [number, number]] => [id, [score, day]]),
    ]);
    context.day = today;
    this.contexts.delete(key);
    this.contexts.set(key, context);
    this.dirty.add(key);
    this.removed.delete(key);
    this.evict();
    this.scheduleSave();
  }

  /** Forgets every context, saved or not. */
  async clear(): Promise<void> {
    this.generation++;
    this.loading = Promise.resolve();
    this.contexts.clear();
    this.dirty.clear();
    this.removed.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.backend.clear().catch(() => undefined);
  }

  /** Saves changed contexts now (page hide, tests). */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.dirty.size === 0 && this.removed.size === 0) return;
    const put = [...this.dirty].flatMap((key) => {
      const context = this.contexts.get(key);
      return context ? [context] : [];
    });
    const remove = [...this.removed];
    this.dirty.clear();
    this.removed.clear();
    await this.backend.write(put, remove).catch(() => undefined);
  }

  private evict(): void {
    for (const key of this.contexts.keys()) {
      if (this.contexts.size <= MAX_CONTEXTS) break;
      this.contexts.delete(key);
      this.dirty.delete(key);
      this.removed.add(key);
    }
  }

  private scheduleSave(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), SAVE_DELAY_MS);
  }
}

const DB_NAME = "haptic-add-node-history";
/** Bump to discard saved history whose format no longer matches. */
const DB_VERSION = 1;
const STORE = "contexts";

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** IndexedDB keeps the history out of the small `localStorage` quota that holds settings. */
function indexedDbBackend(): AddNodeHistoryBackend | null {
  if (typeof indexedDB === "undefined") return null;
  let database: Promise<IDBDatabase> | null = null;
  const open = () => {
    if (!database) {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
        db.createObjectStore(STORE, { keyPath: "key" });
      };
      database = settle(request);
    }
    return database;
  };
  const update = async (change: (store: IDBObjectStore) => void) => {
    const transaction = (await open()).transaction(STORE, "readwrite");
    change(transaction.objectStore(STORE));
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  };
  return {
    loadAll: async () =>
      settle((await open()).transaction(STORE).objectStore(STORE).getAll()),
    write: (put, remove) =>
      update((store) => {
        for (const record of put) store.put(record);
        for (const key of remove) store.delete(key);
      }),
    clear: () => update((store) => store.clear()),
  };
}

const memoryBackend: AddNodeHistoryBackend = {
  loadAll: async () => [],
  write: async () => undefined,
  clear: async () => undefined,
};

let shared: AddNodeHistory | null = null;

/** The device's history, loading on first use; memory-only without IndexedDB. */
export function getAddNodeHistory(): AddNodeHistory {
  if (!shared) {
    const history = new AddNodeHistory(indexedDbBackend() ?? memoryBackend);
    shared = history;
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", () => void history.flush());
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") void history.flush();
      });
    }
    void history.load();
  }
  return shared;
}
