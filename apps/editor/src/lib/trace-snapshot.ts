import type { TraceFrame } from "@haptic/debugger";
import { humanizePropertyLabel } from "@haptic/editor-kit";

export type ParsedTraceSnapshot =
  { status: "ready"; value: unknown } | { status: "missing" | "invalid" };

export function parseTraceSnapshot(
  text: string | undefined,
): ParsedTraceSnapshot {
  if (text === undefined || text.trim() === "") return { status: "missing" };
  try {
    return { status: "ready", value: JSON.parse(text) as unknown };
  } catch {
    return { status: "invalid" };
  }
}

const PARSED_FRAMES = 4;
const parsedFrames = new WeakMap<object, Map<TraceFrame, ParsedTraceSnapshot>>();

/**
 * A recorded frame's snapshot, parsed once while it is among the last few its trace showed, so a step
 * parses only the frame it reaches and Changes reuses the frame before it.
 */
export function parseTraceFrame(
  payload: { frames: readonly TraceFrame[] },
  frame: TraceFrame | undefined,
): ParsedTraceSnapshot {
  if (!frame) return { status: "missing" };
  let recent = parsedFrames.get(payload);
  if (!recent) {
    recent = new Map();
    parsedFrames.set(payload, recent);
  }
  const cached = recent.get(frame);
  recent.delete(frame);
  const parsed = cached ?? parseTraceSnapshot(frame.snapshotText);
  recent.set(frame, parsed);
  if (recent.size > PARSED_FRAMES) recent.delete(recent.keys().next().value!);
  return parsed;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function exactTraceValue(value: unknown): string {
  if (value === undefined) return "Not Recorded";
  return JSON.stringify(value, null, 2) ?? "Not Recorded";
}

export function traceValuePreview(value: unknown): string {
  if (Array.isArray(value))
    return value.length ? `${value.length} Items` : "[]";
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

const pointerPart = (key: string) =>
  key.replace(/~/g, "~0").replace(/\//g, "~1");

/** Recorded world objects keyed by guid (subsystems follow the Game Instance). */
const GUID_COLLECTIONS = new Set(["subsystems", "actors", "components"]);

function identityKey(value: unknown, collection: string): string | null {
  if (!record(value)) return null;
  if (GUID_COLLECTIONS.has(collection) && typeof value.guid === "string")
    return `guid:${value.guid}`;
  if (collection === "bt" && typeof value.slotId === "number")
    return `slot:${value.slotId}`;
  if (collection === "voices" && typeof value.voiceId === "string")
    return `voice:${value.voiceId}`;
  if (collection === "sprites" && typeof value.actorGuid === "string")
    return `actor:${value.actorGuid}`;
  if (collection === "animGraphs" && typeof value.componentGuid === "string")
    return `component:${value.componentGuid}`;
  return null;
}

function collectionEntries(value: unknown[], collection: string) {
  const keys = value.map((entry) => identityKey(entry, collection));
  const counts = new Map<string, number>();
  for (const key of keys)
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  return value.map((entry, index) => ({
    value: entry,
    index,
    key:
      keys[index] !== null && counts.get(keys[index]!) === 1
        ? keys[index]!
        : `index:${index}`,
  }));
}

function objectLabel(
  value: Record<string, unknown>,
  fallback: string,
  collection: string,
): string {
  const name =
    record(value.variables) && typeof value.variables.name === "string"
      ? value.variables.name
      : null;
  const classId = typeof value.classId === "string" ? value.classId : fallback;
  // A subsystem is the only instance of its class and its guid is derived
  // from the class id, so a guid prefix adds nothing.
  const guid =
    collection !== "subsystems" && typeof value.guid === "string"
      ? value.guid.slice(0, 8)
      : "";
  return [name, classId, guid]
    .filter((entry, i, entries) => entry && entries.indexOf(entry) === i)
    .join(" · ");
}

function isEntityCollection(path: string): boolean {
  return (
    path === "/snapshot/subsystems" ||
    path === "/snapshot/actors" ||
    path === "/bt" ||
    path === "/audio/voices" ||
    path === "/sprites" ||
    path === "/animGraphs" ||
    /^\/snapshot\/actors\/[^/]+\/components$/.test(path)
  );
}

/** Field names recur across every object of a snapshot; each is humanized once. */
const FIELD_LABELS = new Map<string, string>();

function snapshotLabel(key: string, path: string): string {
  if (path === "/snapshot/gameInstance") return "Game Instance";
  if (path === "/inputEvents") return "Input Events";
  if (path === "/bt") return "Behaviour Trees";
  if (path === "/sprites") return "Sprite Clips";
  if (path === "/animGraphs") return "Animation Graphs";
  if (/^\/snapshot\/actors\/[^/]+\/transform$/.test(path))
    return "Local Transform";
  if (/^\/snapshot\/actors\/[^/]+\/transform\/rotation$/.test(path))
    return "Rotation (Quaternion)";
  if (/^\/bt\/[^/]+\/btNodeId$/.test(path)) return "Current Node ID";
  let label = FIELD_LABELS.get(key);
  if (label === undefined) {
    label = humanizePropertyLabel(key);
    FIELD_LABELS.set(key, label);
  }
  return label;
}

/** The recorded actors' names, for labelling the voices, sprite clips and graphs that refer to them. */
type TraceNames = {
  actor(guid: unknown): string | undefined;
  component(guid: unknown): string | undefined;
};

function traceNames(snapshot: unknown): TraceNames {
  const actors = new Map<string, string>();
  const components = new Map<string, string>();
  if (record(snapshot) && Array.isArray(snapshot.actors)) {
    for (const actor of snapshot.actors) {
      if (!record(actor) || typeof actor.guid !== "string") continue;
      const name = objectLabel(actor, actor.guid, "actors");
      actors.set(actor.guid, name);
      // A component is named for its actor.
      if (Array.isArray(actor.components))
        for (const component of actor.components)
          if (record(component) && typeof component.guid === "string")
            components.set(component.guid, name);
    }
  }
  return {
    actor: (guid) => (typeof guid === "string" ? actors.get(guid) : undefined),
    component: (guid) =>
      typeof guid === "string" ? components.get(guid) : undefined,
  };
}

/** A label for an entry of the state a frame records beside its snapshot, or null for the default. */
function frameStateLabel(
  path: string,
  value: Record<string, unknown>,
  index: number,
  names: () => TraceNames,
): string | null {
  if (path === "/bt")
    return `Slot ${String(value.slotId ?? index)} · ${String(value.status ?? "Unknown")}`;
  if (path === "/audio/voices") {
    const voice = String(value.voiceId ?? index);
    const emitter = names().actor(value.emitterActorGuid);
    return emitter ? `${voice} · ${emitter}` : voice;
  }
  if (path === "/sprites")
    return `${names().actor(value.actorGuid) ?? String(value.actorGuid ?? index)} · ${String(value.clipName ?? "")}`;
  if (path === "/animGraphs") {
    const guid = String(value.componentGuid ?? index);
    const owner = names().component(value.componentGuid);
    return owner ? `${owner} · ${guid.slice(0, 8)}` : guid;
  }
  return null;
}

/** Whether a value has fields or items to list under it. */
function hasEntries(value: unknown): boolean {
  return Array.isArray(value)
    ? value.length > 0
    : record(value) && Object.keys(value).length > 0;
}

/** A node whose children are built when first read, so a step builds only what is shown. */
function buildNode(
  value: unknown,
  key: string,
  id: string,
  path: string,
  names: () => TraceNames,
  depth = 0,
): TraceValueNode {
  let children: TraceValueNode[] | undefined;
  return {
    id,
    path,
    value,
    label: snapshotLabel(key, path),
    get children() {
      // Deep values remain inspectable in the exact-value pane and Raw Snapshot.
      children ??=
        depth >= 64 ? [] : childNodes(value, key, id, path, names, depth);
      return children;
    },
  };
}

function childNodes(
  value: unknown,
  key: string,
  id: string,
  path: string,
  names: () => TraceNames,
  depth: number,
): TraceValueNode[] {
  if (Array.isArray(value)) {
    const entityCollection = isEntityCollection(path);
    return collectionEntries(value, entityCollection ? key : "").map(
      (entry) => {
        const child = buildNode(
          entry.value,
          `[${entry.index}]`,
          `${id}/${pointerPart(entry.key)}`,
          `${path}/${entry.index}`,
          names,
          depth + 1,
        );
        if (
          entityCollection &&
          GUID_COLLECTIONS.has(key) &&
          record(entry.value)
        )
          child.label = objectLabel(entry.value, child.label, key);
        const stateLabel = record(entry.value)
          ? frameStateLabel(path, entry.value, entry.index, names)
          : null;
        if (stateLabel !== null) child.label = stateLabel;
        if (
          /^\/snapshot\/actors\/[^/]+\/transform\/(position|scale|rotation)$/.test(
            path,
          ) &&
          entry.index < 4
        )
          child.label = ["X", "Y", "Z", "W"][entry.index]!;
        return child;
      },
    );
  }
  if (!record(value)) return [];
  const nodes: TraceValueNode[] = [];
  const identityFields = ["guid", "classId", "spawnIndex", "assetGuid"];
  const isEntity =
    typeof value.guid === "string" &&
    typeof value.classId === "string" &&
    (path === "/snapshot/gameInstance" ||
      /^\/snapshot\/subsystems\/[^/]+$/.test(path) ||
      /^\/snapshot\/actors\/[^/]+(\/components\/[^/]+)?$/.test(path));
  if (isEntity) {
    nodes.push({
      id: `${id}/$identity`,
      path,
      label: "Identity",
      value: Object.fromEntries(
        identityFields
          .filter((name) => Object.hasOwn(value, name))
          .map((name) => [name, value[name]]),
      ),
      children: identityFields
        .filter((name) => Object.hasOwn(value, name))
        .map((name) =>
          buildNode(
            value[name],
            name,
            `${id}/${pointerPart(name)}`,
            `${path}/${pointerPart(name)}`,
            names,
            depth + 1,
          ),
        ),
    });
  }
  for (const [name, child] of Object.entries(value)) {
    if (isEntity && identityFields.includes(name)) continue;
    nodes.push(
      buildNode(
        child,
        name,
        `${id}/${pointerPart(name)}`,
        `${path}/${pointerPart(name)}`,
        names,
        depth + 1,
      ),
    );
  }
  return nodes;
}

export function traceSnapshotRoots(
  frame: TraceFrame,
  parsed: ParsedTraceSnapshot,
): TraceValueNode[] {
  const roots: TraceValueNode[] = [];
  let names: TraceNames | undefined;
  const namesOf = () =>
    (names ??= traceNames(parsed.status === "ready" ? parsed.value : null));
  if (parsed.status === "ready") {
    if (record(parsed.value)) {
      for (const [key, value] of Object.entries(parsed.value)) {
        if (key === "tickIndex" || key === "dt") continue;
        roots.push(
          buildNode(
            value,
            key,
            `/snapshot/${pointerPart(key)}`,
            `/snapshot/${pointerPart(key)}`,
            namesOf,
          ),
        );
      }
    } else
      roots.push(
        buildNode(parsed.value, "Snapshot", "/snapshot", "/snapshot", namesOf),
      );
  }
  for (const key of ["inputEvents", "bt"] as const) {
    // Absent and empty are deliberately different in older recordings.
    roots.push(buildNode(frame[key], key, `/${key}`, `/${key}`, namesOf));
  }
  // Recorded since restoring a trace resumes them; older recordings have none to show.
  for (const key of ["audio", "sprites", "animGraphs"] as const) {
    if (frame[key] !== undefined)
      roots.push(buildNode(frame[key], key, `/${key}`, `/${key}`, namesOf));
  }
  return roots;
}

export type TraceSnapshotRow = TraceValueNode & {
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
};

export function flattenTraceSnapshot(
  roots: TraceValueNode[],
  expanded: ReadonlySet<string>,
  query: string,
): TraceSnapshotRow[] {
  const q = query.trim().toLowerCase();
  const matches = new Set<string>();
  const mark = (node: TraceValueNode): boolean => {
    const own =
      `${node.label} ${node.path} ${node.children.length ? "" : exactTraceValue(node.value)}`
        .toLowerCase()
        .includes(q);
    let childMatches = false;
    for (const child of node.children)
      childMatches = mark(child) || childMatches;
    if (own || childMatches) matches.add(node.id);
    return own || childMatches;
  };
  if (q) roots.forEach(mark);
  const rows: TraceSnapshotRow[] = [];
  const visit = (
    node: TraceValueNode,
    depth: number,
    parentMatches = false,
  ) => {
    if (q && !parentMatches && !matches.has(node.id)) return;
    const ownMatch =
      !!q && `${node.label} ${node.path}`.toLowerCase().includes(q);
    const open = q ? true : expanded.has(node.id);
    // Copying the node would build its children; a row reads them only when asked.
    rows.push({
      id: node.id,
      path: node.path,
      label: node.label,
      value: node.value,
      get children() {
        return node.children;
      },
      depth,
      expanded: open,
      hasChildren: hasEntries(node.value),
    });
    if (open)
      for (const child of node.children)
        visit(child, depth + 1, parentMatches || ownMatch);
  };
  roots.forEach((root) => visit(root, 0));
  return rows;
}

export function findTraceNode(
  roots: TraceValueNode[],
  id: string | null,
): TraceValueNode | undefined {
  if (!id) return undefined;
  // Follow the id down: a node's id prefixes its descendants', except the
  // identity fields, which an entity lists under its Identity node.
  const pending = [...roots];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.id === id) return node;
    if (id.startsWith(`${node.id}/`) || node.id.endsWith("/$identity"))
      pending.push(...node.children);
  }
  return undefined;
}

export type TraceChange = {
  id: string;
  path: string;
  label: string;
  kind: "Added" | "Removed" | "Changed";
  before: unknown;
  after: unknown;
};

type JsonPrimitive = string | number | boolean | null | undefined;

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** `JSON.stringify(left) === JSON.stringify(right)`; primitives compare without serializing. */
function sameJson(left: unknown, right: unknown): boolean {
  if (isJsonPrimitive(left) && isJsonPrimitive(right)) {
    // JSON writes null, NaN and the infinities alike, and -0 as 0.
    const writesNull = (value: JsonPrimitive) =>
      value === null || (typeof value === "number" && !Number.isFinite(value));
    if (writesNull(left) || writesNull(right))
      return writesNull(left) && writesNull(right);
    return left === right;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

const entityTexts = new WeakMap<object, string>();

/** An entity's JSON, written once per parsed object, so an unchanged entity is skipped without walking it. */
function entityText(value: Record<string, unknown>): string {
  let text = entityTexts.get(value);
  if (text === undefined) {
    text = JSON.stringify(value);
    entityTexts.set(value, text);
  }
  return text;
}

/** Compare recorded world values; GUID collections retain identity when reordered. */
export function compareTraceSnapshots(
  before: unknown,
  after: unknown,
): TraceChange[] {
  // Tick metadata changes every frame and obscures meaningful world changes.
  const world = (value: unknown) =>
    record(value)
      ? Object.fromEntries(
          Object.entries(value).filter(
            ([key]) => key !== "tickIndex" && key !== "dt",
          ),
        )
      : value;
  return compareTraceValues(world(before), world(after), "/snapshot", "Snapshot");
}

/** The state a frame records beside its world snapshot, which Changes also compares. */
const FRAME_STATE = ["bt", "audio", "sprites", "animGraphs"] as const;

/** Compare two recorded frames: the world, then Behaviour Trees, audio voices, sprite clips and Animation Graphs. */
export function compareTraceFrames(
  before: { frame: TraceFrame; snapshot: unknown },
  after: { frame: TraceFrame; snapshot: unknown },
): TraceChange[] {
  return [
    ...compareTraceSnapshots(before.snapshot, after.snapshot),
    ...FRAME_STATE.flatMap((key) =>
      compareTraceValues(before.frame[key], after.frame[key], `/${key}`, key),
    ),
  ];
}

function compareTraceValues(
  before: unknown,
  after: unknown,
  rootPath: string,
  rootKey: string,
): TraceChange[] {
  const changes: TraceChange[] = [];
  const walk = (
    left: unknown,
    right: unknown,
    path: string,
    key: string,
    depth: number,
  ) => {
    if (Object.is(left, right)) return;
    if (depth < 64 && Array.isArray(left) && Array.isArray(right)) {
      const collection = isEntityCollection(path) ? key : "";
      const a = new Map(
        collectionEntries(left, collection).map((entry) => [entry.key, entry]),
      );
      const b = new Map(
        collectionEntries(right, collection).map((entry) => [entry.key, entry]),
      );
      for (const entryKey of new Set([...a.keys(), ...b.keys()])) {
        const previous = a.get(entryKey),
          current = b.get(entryKey);
        if (
          collection &&
          record(previous?.value) &&
          record(current?.value) &&
          entityText(previous.value) === entityText(current.value)
        )
          continue;
        walk(
          previous?.value,
          current?.value,
          `${path}/${pointerPart(entryKey)}`,
          `[${current?.index ?? previous?.index ?? 0}]`,
          depth + 1,
        );
      }
    } else if (depth < 64 && record(left) && record(right)) {
      for (const name of new Set([
        ...Object.keys(left),
        ...Object.keys(right),
      ])) {
        walk(
          Object.hasOwn(left, name) ? left[name] : undefined,
          Object.hasOwn(right, name) ? right[name] : undefined,
          `${path}/${pointerPart(name)}`,
          name,
          depth + 1,
        );
      }
    } else if (!sameJson(left, right)) {
      changes.push({
        id: path,
        path,
        label: humanizePropertyLabel(key),
        kind:
          left === undefined
            ? "Added"
            : right === undefined
              ? "Removed"
              : "Changed",
        before: left,
        after: right,
      });
    }
  };
  walk(before, after, rootPath, rootKey, 0);
  return changes;
}
