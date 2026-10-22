import type { BreakpointLocation } from "@haptic/bridge";
import type { GraphBreakpoints, GraphBreakpointState } from "@haptic/graph-ui";

/**
 * Node breakpoints: editor state per project, never stored in an asset, so setting one never makes a
 * document dirty and nothing reaches an export. A location is the compiler's: the Class asset path,
 * the graph a script reports under (`event-graph`, or a function's export name) and the node id, so
 * the session and a stop speak the same terms. Each entry keeps the names it was set with, for the
 * Breakpoints window to list Classes that are not open.
 */
export type BreakpointEntry = BreakpointLocation & {
  enabled: boolean;
  /** The Class, graph and node names when the breakpoint was set or last seen. */
  label: { className: string; graphName: string; nodeTitle: string };
};

/** The saved form, versioned so a later change can read older files. */
type BreakpointFile = { version: 1; breakpoints: BreakpointEntry[] };

const keyOf = ({ assetGuid, graphId, nodeId }: BreakpointLocation) => JSON.stringify([assetGuid, graphId, nodeId]);

function isEntry(value: unknown): value is BreakpointEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<BreakpointEntry>;
  const label = entry.label as Partial<BreakpointEntry["label"]> | undefined;
  return typeof entry.assetGuid === "string" && typeof entry.graphId === "string" && typeof entry.nodeId === "string" &&
    typeof entry.enabled === "boolean" && typeof label === "object" && label !== null &&
    typeof label.className === "string" && typeof label.graphName === "string" && typeof label.nodeTitle === "string";
}

/** The breakpoints in a saved file; anything unreadable is dropped. */
export function parseBreakpointFile(text: string): BreakpointEntry[] {
  try {
    const file = JSON.parse(text) as Partial<BreakpointFile>;
    return file.version === 1 && Array.isArray(file.breakpoints) ? file.breakpoints.filter(isEntry) : [];
  } catch {
    return [];
  }
}

export function serializeBreakpointFile(entries: readonly BreakpointEntry[]): string {
  const file: BreakpointFile = { version: 1, breakpoints: [...entries] };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** An external store: React reads it with `useSyncExternalStore`, sessions subscribe to its changes. */
export class BreakpointStore {
  private entries = new Map<string, BreakpointEntry>();
  private snapshot: readonly BreakpointEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly changeListeners = new Set<(entries: readonly BreakpointEntry[]) => void>();

  /** Every breakpoint, in the order they were set. A new array after each change. */
  list = (): readonly BreakpointEntry[] => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Runs after each change made here, not after `hydrate`: what saving needs. */
  onChange(listener: (entries: readonly BreakpointEntry[]) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  get(location: BreakpointLocation): BreakpointEntry | undefined {
    return this.entries.get(keyOf(location));
  }

  /** What a session checks: the enabled breakpoints. */
  enabledLocations(): BreakpointLocation[] {
    return this.snapshot.filter((entry) => entry.enabled)
      .map(({ assetGuid, graphId, nodeId }) => ({ assetGuid, graphId, nodeId }));
  }

  /** Replaces every breakpoint with saved ones, without saving them again. */
  hydrate(entries: readonly BreakpointEntry[]): void {
    this.entries = new Map(entries.map((entry) => [keyOf(entry), entry]));
    this.publish(false);
  }

  /** Adds an enabled breakpoint, or removes the one at the location. */
  toggle(location: BreakpointLocation, label: BreakpointEntry["label"]): void {
    const key = keyOf(location);
    if (this.entries.has(key)) this.entries.delete(key);
    else this.entries.set(key, { ...pickLocation(location), enabled: true, label });
    this.publish();
  }

  setEnabled(location: BreakpointLocation, enabled: boolean): void {
    const key = keyOf(location);
    const entry = this.entries.get(key);
    if (!entry || entry.enabled === enabled) return;
    this.entries.set(key, { ...entry, enabled });
    this.publish();
  }

  remove(location: BreakpointLocation): void {
    if (this.entries.delete(keyOf(location))) this.publish();
  }

  setAllEnabled(enabled: boolean): void {
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (entry.enabled === enabled) continue;
      this.entries.set(key, { ...entry, enabled });
      changed = true;
    }
    if (changed) this.publish();
  }

  removeAll(): void {
    if (this.entries.size === 0) return;
    this.entries.clear();
    this.publish();
  }

  /** A Class asset moved or was renamed: its breakpoints follow it. */
  renameAsset(fromPath: string, toPath: string): void {
    this.rekey((entry) => entry.assetGuid === fromPath ? { ...entry, assetGuid: toPath } : entry);
  }

  /** A function was renamed, so its graph reports under a new name: its breakpoints follow it. */
  renameGraph(assetGuid: string, fromGraphId: string, toGraphId: string, graphName: string): void {
    this.rekey((entry) => entry.assetGuid === assetGuid && entry.graphId === fromGraphId
      ? { ...entry, graphId: toGraphId, label: { ...entry.label, graphName } }
      : entry);
  }

  /** The canvas's view of one graph's breakpoints. Memoize it per graph. */
  graphView(
    assetGuid: string,
    graphId: string,
    labelFor: (nodeId: string) => BreakpointEntry["label"],
  ): GraphBreakpoints {
    return {
      state: (nodeId): GraphBreakpointState | null => {
        const entry = this.entries.get(keyOf({ assetGuid, graphId, nodeId }));
        return entry ? (entry.enabled ? "enabled" : "disabled") : null;
      },
      subscribe: this.subscribe,
      toggle: (nodeId) => this.toggle({ assetGuid, graphId, nodeId }, labelFor(nodeId)),
    };
  }

  private rekey(change: (entry: BreakpointEntry) => BreakpointEntry): void {
    let changed = false;
    const next = new Map<string, BreakpointEntry>();
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

function pickLocation({ assetGuid, graphId, nodeId }: BreakpointLocation): BreakpointLocation {
  return { assetGuid, graphId, nodeId };
}
