import type { TraceFrame } from "@babylonslate/debugger";
import { humanizePropertyLabel } from "@babylonslate/editor-kit";

export type ParsedTraceSnapshot =
  | { status: "ready"; value: unknown }
  | { status: "missing" | "invalid" };

export function parseTraceSnapshot(text: string | undefined): ParsedTraceSnapshot {
  if (text === undefined || text.trim() === "") return { status: "missing" };
  try { return { status: "ready", value: JSON.parse(text) as unknown }; }
  catch { return { status: "invalid" }; }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function exactTraceValue(value: unknown): string {
  if (value === undefined) return "Not Recorded";
  return JSON.stringify(value, null, 2) ?? "Not Recorded";
}

export function traceValuePreview(value: unknown): string {
  if (Array.isArray(value)) return value.length ? `${value.length} Items` : "[]";
  if (record(value)) {
    const count = Object.keys(value).length;
    return count ? `${count} Properties` : "{}";
  }
  const text = exactTraceValue(value);
  return text.length > 100 ? `${text.slice(0, 100)}…` : text;
}

export type TraceValueNode = {
  id: string;
  /** JSON pointer into the selected frame (snapshot is the parsed snapshotText). */
  path: string;
  label: string;
  value: unknown;
  children: TraceValueNode[];
};

const pointerPart = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");

function identityKey(value: unknown, collection: string): string | null {
  if (!record(value)) return null;
  if ((collection === "actors" || collection === "components") && typeof value.guid === "string") return `guid:${value.guid}`;
  if (collection === "bt" && typeof value.slotId === "number") return `slot:${value.slotId}`;
  return null;
}

function collectionEntries(value: unknown[], collection: string) {
  const keys = value.map((entry) => identityKey(entry, collection));
  const counts = new Map<string, number>();
  for (const key of keys) if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  return value.map((entry, index) => ({
    value: entry, index,
    key: keys[index] !== null && counts.get(keys[index]!) === 1 ? keys[index]! : `index:${index}`,
  }));
}

function objectLabel(value: Record<string, unknown>, fallback: string): string {
  const name = record(value.variables) && typeof value.variables.name === "string" ? value.variables.name : null;
  const classId = typeof value.classId === "string" ? value.classId : fallback;
  const guid = typeof value.guid === "string" ? value.guid.slice(0, 8) : "";
  return [name, classId, guid].filter((entry, i, entries) => entry && entries.indexOf(entry) === i).join(" · ");
}

const labels: Record<string, string> = {
  gameInstance: "Game Instance", transform: "Local Transform", rotation: "Rotation (Quaternion)",
  inputEvents: "Input Events", bt: "Behaviour Trees", dt: "Delta Seconds", btNodeId: "Current Node ID",
};

function buildNode(value: unknown, key: string, id: string, path: string, depth = 0): TraceValueNode {
  const node: TraceValueNode = { id, path, value, label: labels[key] ?? humanizePropertyLabel(key), children: [] };
  // Deep values remain inspectable in the exact-value pane and Raw Snapshot.
  if (depth >= 64) return node;
  if (Array.isArray(value)) {
    node.children = collectionEntries(value, key).map((entry) => {
      const child = buildNode(entry.value, `[${entry.index}]`, `${id}/${pointerPart(entry.key)}`, `${path}/${entry.index}`, depth + 1);
      if ((key === "actors" || key === "components") && record(entry.value)) child.label = objectLabel(entry.value, child.label);
      if (key === "bt" && record(entry.value)) child.label = `Slot ${String(entry.value.slotId ?? entry.index)} · ${String(entry.value.status ?? "Unknown")}`;
      if ((key === "position" || key === "scale" || key === "rotation") && entry.index < 4) child.label = ["X", "Y", "Z", "W"][entry.index]!;
      return child;
    });
  } else if (record(value)) {
    const identityFields = ["guid", "classId", "spawnIndex", "assetGuid"];
    const isEntity = typeof value.guid === "string" && typeof value.classId === "string";
    if (isEntity) {
      node.children.push({
        id: `${id}/$identity`, path, label: "Identity", value: Object.fromEntries(identityFields.filter((name) => Object.hasOwn(value, name)).map((name) => [name, value[name]])),
        children: identityFields.filter((name) => Object.hasOwn(value, name)).map((name) => buildNode(value[name], name, `${id}/${pointerPart(name)}`, `${path}/${pointerPart(name)}`, depth + 1)),
      });
    }
    for (const [name, child] of Object.entries(value)) {
      if (isEntity && identityFields.includes(name)) continue;
      node.children.push(buildNode(child, name, `${id}/${pointerPart(name)}`, `${path}/${pointerPart(name)}`, depth + 1));
    }
  }
  return node;
}

export function traceSnapshotRoots(frame: TraceFrame, parsed: ParsedTraceSnapshot): TraceValueNode[] {
  const roots: TraceValueNode[] = [];
  if (parsed.status === "ready") {
    if (record(parsed.value)) {
      for (const [key, value] of Object.entries(parsed.value)) {
        if (key === "tickIndex" || key === "dt") continue;
        roots.push(buildNode(value, key, `/snapshot/${pointerPart(key)}`, `/snapshot/${pointerPart(key)}`));
      }
    } else roots.push(buildNode(parsed.value, "Snapshot", "/snapshot", "/snapshot"));
  }
  for (const key of ["inputEvents", "bt"] as const) {
    // Absent and empty are deliberately different in older recordings.
    roots.push(buildNode(frame[key], key, `/${key}`, `/${key}`));
  }
  return roots;
}

export type TraceSnapshotRow = TraceValueNode & { depth: number; expanded: boolean; hasChildren: boolean };

export function flattenTraceSnapshot(roots: TraceValueNode[], expanded: ReadonlySet<string>, query: string): TraceSnapshotRow[] {
  const q = query.trim().toLowerCase();
  const matches = new Set<string>();
  const mark = (node: TraceValueNode): boolean => {
    const own = `${node.label} ${node.path} ${node.children.length ? "" : exactTraceValue(node.value)}`.toLowerCase().includes(q);
    let childMatches = false;
    for (const child of node.children) childMatches = mark(child) || childMatches;
    if (own || childMatches) matches.add(node.id);
    return own || childMatches;
  };
  if (q) roots.forEach(mark);
  const rows: TraceSnapshotRow[] = [];
  const visit = (node: TraceValueNode, depth: number, parentMatches = false) => {
    if (q && !parentMatches && !matches.has(node.id)) return;
    const ownMatch = !!q && `${node.label} ${node.path}`.toLowerCase().includes(q);
    const open = q ? true : expanded.has(node.id);
    rows.push({ ...node, depth, expanded: open, hasChildren: node.children.length > 0 });
    if (open) for (const child of node.children) visit(child, depth + 1, parentMatches || ownMatch);
  };
  roots.forEach((root) => visit(root, 0));
  return rows;
}

export function findTraceNode(roots: TraceValueNode[], id: string | null): TraceValueNode | undefined {
  if (!id) return undefined;
  const pending = [...roots];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.id === id) return node;
    pending.push(...node.children);
  }
  return undefined;
}

export type TraceChange = { id: string; path: string; label: string; kind: "Added" | "Removed" | "Changed"; before: unknown; after: unknown };

/** Compare recorded world values; GUID collections retain identity when reordered. */
export function compareTraceSnapshots(before: unknown, after: unknown): TraceChange[] {
  const changes: TraceChange[] = [];
  const walk = (left: unknown, right: unknown, path: string, key: string, depth: number) => {
    if (Object.is(left, right)) return;
    if (depth < 64 && Array.isArray(left) && Array.isArray(right)) {
      const a = new Map(collectionEntries(left, key).map((entry) => [entry.key, entry]));
      const b = new Map(collectionEntries(right, key).map((entry) => [entry.key, entry]));
      for (const entryKey of new Set([...a.keys(), ...b.keys()])) {
        const previous = a.get(entryKey), current = b.get(entryKey);
        walk(previous?.value, current?.value, `${path}/${pointerPart(entryKey)}`, `[${current?.index ?? previous?.index ?? 0}]`, depth + 1);
      }
    } else if (depth < 64 && record(left) && record(right)) {
      for (const name of new Set([...Object.keys(left), ...Object.keys(right)])) {
        walk(left[name], right[name], `${path}/${pointerPart(name)}`, name, depth + 1);
      }
    } else if (JSON.stringify(left) !== JSON.stringify(right)) {
      changes.push({ id: path, path, label: humanizePropertyLabel(key), kind: left === undefined ? "Added" : right === undefined ? "Removed" : "Changed", before: left, after: right });
    }
  };
  // Tick metadata changes every frame and obscures meaningful world changes.
  const world = (value: unknown) => record(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "tickIndex" && key !== "dt")) : value;
  walk(world(before), world(after), "/snapshot", "Snapshot", 0);
  return changes;
}
