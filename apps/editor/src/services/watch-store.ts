import type { BreakpointLocation } from "@haptic/bridge";

/**
 * Watches: editor state per project, never stored in an asset, like breakpoints. A pin watch is in the
 * compiler's terms (the Class asset path, the graph a script reports under and the node id) plus the pin;
 * a variable watch names a variable of the Class's objects. Each keeps the names it was added with, for
 * the Watches window to list assets that are not open.
 */
export type PinWatch = BreakpointLocation & {
  kind: "pin";
  pinId: string;
  direction: "in" | "out";
  label: { className: string; graphName: string; nodeTitle: string; pinName: string };
};
export type VariableWatch = { kind: "variable"; assetGuid: string; name: string; label: { className: string } };
export type WatchEntry = PinWatch | VariableWatch;

/** The saved form, versioned so a later change can read older files. */
type WatchFile = { version: 1; watches: WatchEntry[] };

const keyOf = (entry: WatchEntry) => entry.kind === "pin"
  ? JSON.stringify(["pin", entry.assetGuid, entry.graphId, entry.nodeId, entry.pinId, entry.direction])
  : JSON.stringify(["variable", entry.assetGuid, entry.name]);

const isString = (value: unknown): value is string => typeof value === "string";

function isEntry(value: unknown): value is WatchEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  const label = entry.label as Record<string, unknown> | undefined;
  if (!isString(entry.assetGuid) || typeof label !== "object" || label === null || !isString(label.className)) return false;
  if (entry.kind === "variable") return isString(entry.name);
  return entry.kind === "pin" && isString(entry.graphId) && isString(entry.nodeId) && isString(entry.pinId) &&
    (entry.direction === "in" || entry.direction === "out") &&
    isString(label.graphName) && isString(label.nodeTitle) && isString(label.pinName);
}

/** The watches in a saved file; anything unreadable is dropped. */
export function parseWatchFile(text: string): WatchEntry[] {
  try {
    const file = JSON.parse(text) as Partial<WatchFile>;
    return file.version === 1 && Array.isArray(file.watches) ? file.watches.filter(isEntry) : [];
  } catch {
    return [];
  }
}

export function serializeWatchFile(entries: readonly WatchEntry[]): string {
  const file: WatchFile = { version: 1, watches: [...entries] };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** An external store: React reads it with `useSyncExternalStore`, the project provider saves its changes. */
export class WatchStore {
  private entries = new Map<string, WatchEntry>();
  private snapshot: readonly WatchEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly changeListeners = new Set<(entries: readonly WatchEntry[]) => void>();

  /** Every watch, in the order it was added. A new array after each change. */
  list = (): readonly WatchEntry[] => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Runs after each change made here, not after `hydrate`: what saving needs. */
  onChange(listener: (entries: readonly WatchEntry[]) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  has(entry: WatchEntry): boolean {
    return this.entries.has(keyOf(entry));
  }

  /** Replaces every watch with saved ones, without saving them again. */
  hydrate(entries: readonly WatchEntry[]): void {
    this.entries = new Map(entries.map((entry) => [keyOf(entry), entry]));
    this.publish(false);
  }

  add(entry: WatchEntry): void {
    const key = keyOf(entry);
    if (this.entries.has(key)) return;
    this.entries.set(key, entry);
    this.publish();
  }

  remove(entry: WatchEntry): void {
    if (this.entries.delete(keyOf(entry))) this.publish();
  }

  removeAll(): void {
    if (this.entries.size === 0) return;
    this.entries.clear();
    this.publish();
  }

  /** A Class asset moved or was renamed: its watches follow it. */
  renameAsset(fromPath: string, toPath: string): void {
    this.rekey((entry) => entry.assetGuid === fromPath ? { ...entry, assetGuid: toPath } : entry);
  }

  /** A function was renamed, so its graph reports under a new name: its pin watches follow it. */
  renameGraph(assetGuid: string, fromGraphId: string, toGraphId: string, graphName: string): void {
    this.rekey((entry) => entry.kind === "pin" && entry.assetGuid === assetGuid && entry.graphId === fromGraphId
      ? { ...entry, graphId: toGraphId, label: { ...entry.label, graphName } }
      : entry);
  }

  private rekey(change: (entry: WatchEntry) => WatchEntry): void {
    let changed = false;
    const next = new Map<string, WatchEntry>();
    for (const entry of this.entries.values()) {
      const updated = change(entry);
      if (updated !== entry) changed = true;
      next.set(keyOf(updated), updated);
    }
    if (!changed) return;
    this.entries = next;
    this.publish();
  }

  private publish(save = true): void {
    this.snapshot = [...this.entries.values()];
    if (save) for (const listener of this.changeListeners) listener(this.snapshot);
    for (const listener of this.listeners) listener();
  }
}
