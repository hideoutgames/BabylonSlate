import type { BreakpointLocation } from "@haptic/bridge";
import { KeyedListStore } from "./keyed-list-store";

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

/** The project's watches, in the order they were added. */
export class WatchStore extends KeyedListStore<WatchEntry> {
  constructor() {
    super(keyOf);
  }

  has(entry: WatchEntry): boolean {
    return this.entries.has(keyOf(entry));
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

  /** A function was renamed, so its graph reports under a new name: its pin watches follow it. */
  renameGraph(assetGuid: string, fromGraphId: string, toGraphId: string, graphName: string): void {
    this.rekey((entry) => entry.kind === "pin" && entry.assetGuid === assetGuid && entry.graphId === fromGraphId
      ? { ...entry, graphId: toGraphId, label: { ...entry.label, graphName } }
      : entry);
  }
}
