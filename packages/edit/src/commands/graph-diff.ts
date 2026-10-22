import type { SerializedGraph } from "@haptic/core";
import {
  AddEdgeCommand,
  AddNodeCommand,
  MoveNodeCommand,
  RemoveEdgeCommand,
  RemoveNodeCommand,
  SetGraphMembersCommand,
  SetGraphActorDefaultsCommand,
  SetGraphComponentsCommand,
  SetGraphFunctionGraphsCommand,
  SetNodeDataCommand,
} from "./graph";

function positionsEqual(
  a: { x: number; y: number },
  b: { x: number; y: number },
): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Same own keys with identical values; node data and edge fields are flat. */
function shallowEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((key) => Object.is(a[key], b[key]));
}

interface RowPlan<T> {
  /** Highest `before` index first, so a reversed (Undo) batch re-inserts lowest first. */
  removed: Array<{ item: T; index: number }>;
  /** Lowest `after` index first, so each insert lands at its final index. */
  added: Array<{ item: T; index: number }>;
  /** Ids of rows that stay in place. */
  kept: Set<string>;
}

/**
 * Plans an ordered row list as removes, then inserts. A row stays in place
 * only when `keep` accepts it and it belongs to the longest run of such rows
 * already in `after` order; every other row leaves and returns at its final
 * index. Replaying the plan on `before` reproduces `after`'s rows and order,
 * and the reversed inverses restore `before`.
 */
function planRows<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
  keep: (previous: T, next: T) => boolean,
): RowPlan<T> {
  const beforeIndex = new Map(before.map((item, index) => [item.id, index]));
  // `before` indices of keepable rows, in `after` order.
  const candidates: Array<{ id: string; index: number }> = [];
  for (const item of after) {
    const index = beforeIndex.get(item.id);
    if (index !== undefined && keep(before[index]!, item)) {
      candidates.push({ id: item.id, index });
    }
  }
  // Longest increasing run of `before` indices (patience sorting).
  const tails: number[] = [];
  const previous: number[] = [];
  for (let i = 0; i < candidates.length; i++) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (candidates[tails[mid]!]!.index < candidates[i]!.index) low = mid + 1;
      else high = mid;
    }
    previous[i] = low > 0 ? tails[low - 1]! : -1;
    tails[low] = i;
  }
  const kept = new Set<string>();
  for (let i = tails.at(-1) ?? -1; i !== -1; i = previous[i]!) {
    kept.add(candidates[i]!.id);
  }
  const removed = before
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !kept.has(item.id))
    .reverse();
  const added = after
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !kept.has(item.id));
  return { removed, added, kept };
}

function membersEqual(
  a: SerializedGraph["members"],
  b: SerializedGraph["members"],
): boolean {
  if (a === b) return true;
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/**
 * A missing list means the default prefab mesh and `[]` an authored empty
 * prefab, so the two are different values.
 */
function componentsEqual(
  a: SerializedGraph["components"],
  b: SerializedGraph["components"],
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function functionGraphsEqual(
  a: SerializedGraph["functionGraphs"],
  b: SerializedGraph["functionGraphs"],
): boolean {
  if (a === b) return true;
  const left = a ?? {};
  const right = b ?? {};
  // Editing one function rebuilds the map but shares every other entry. With
  // the same keys in the same order the whole-map JSON is the entries' JSON in
  // turn (undefined entries omitted alike), so compare per entry; any other
  // key list falls back to the whole map.
  const keys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (keys.length === rightKeys.length && keys.every((key, i) => key === rightKeys[i])) {
    return keys.every(
      (key) => left[key] === right[key] || JSON.stringify(left[key]) === JSON.stringify(right[key]),
    );
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Merge key for an edit that changes exactly one existing function graph, so a
 * pin scrub inside a function is one undo step as it is in the event graph.
 * Adding, removing or renaming a function, or touching two, has no key.
 */
function functionGraphsMergeKey(
  a: SerializedGraph["functionGraphs"],
  b: SerializedGraph["functionGraphs"],
): string | undefined {
  if (!a || !b) return undefined;
  const names = Object.keys(b);
  if (names.length !== Object.keys(a).length) return undefined;
  let changed: string | undefined;
  for (const name of names) {
    if (!Object.hasOwn(a, name)) return undefined;
    if (a[name] === b[name] || JSON.stringify(a[name]) === JSON.stringify(b[name])) continue;
    if (changed !== undefined) return undefined;
    changed = name;
  }
  return changed === undefined ? undefined : `function-graph:${changed}`;
}

function actorDefaultsEqual(
  a: SerializedGraph["actorDefaults"],
  b: SerializedGraph["actorDefaults"],
): boolean {
  if (a === b) return true;
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

/**
 * Derives minimal graph edit commands from a before/after pair, so the graph
 * editor routes every mutation through the undo stack. Replaying the commands
 * on `before` reproduces `after`, including rewired edges, retyped nodes and
 * row order.
 */
export function diffGraphCommands(
  before: SerializedGraph,
  after: SerializedGraph,
): Array<
  | MoveNodeCommand
  | AddEdgeCommand
  | RemoveEdgeCommand
  | SetNodeDataCommand
  | AddNodeCommand
  | RemoveNodeCommand
  | SetGraphMembersCommand
  | SetGraphComponentsCommand
  | SetGraphFunctionGraphsCommand
  | SetGraphActorDefaultsCommand
> {
  const commands: Array<
    | MoveNodeCommand
    | AddEdgeCommand
    | RemoveEdgeCommand
    | SetNodeDataCommand
    | AddNodeCommand
    | RemoveNodeCommand
    | SetGraphMembersCommand
    | SetGraphComponentsCommand
    | SetGraphFunctionGraphsCommand
    | SetGraphActorDefaultsCommand
  > = [];

  // A retyped node is a different node under the same id: it leaves and returns.
  const nodes = planRows(before.nodes, after.nodes, (previous, next) => previous.type === next.type);
  // RemoveNodeCommand removes only the node, so every edge touching a removed
  // or added node is its own RemoveEdge/AddEdge command: an edge stays in
  // place only when it is unchanged and neither endpoint is removed or added.
  const moving = new Set([...nodes.removed, ...nodes.added].map(({ item }) => item.id));
  const edges = planRows(before.edges, after.edges, (previous, next) =>
    shallowEqual(previous, next) && !moving.has(next.source) && !moving.has(next.target));

  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  for (const afterNode of after.nodes) {
    if (!nodes.kept.has(afterNode.id)) continue;
    const beforeNode = beforeNodes.get(afterNode.id)!;
    if (!positionsEqual(beforeNode.position, afterNode.position)) {
      commands.push(
        new MoveNodeCommand(afterNode.id, beforeNode.position, afterNode.position),
      );
    }
    if (!shallowEqual(beforeNode.data, afterNode.data)) {
      commands.push(
        new SetNodeDataCommand(afterNode.id, beforeNode.data, afterNode.data),
      );
    }
  }

  for (const { item, index } of edges.removed) {
    commands.push(new RemoveEdgeCommand(item, index));
  }
  for (const { item, index } of nodes.removed) {
    commands.push(new RemoveNodeCommand(item, index));
  }
  for (const { item, index } of nodes.added) {
    commands.push(new AddNodeCommand(item, index));
  }
  for (const { item, index } of edges.added) {
    commands.push(new AddEdgeCommand(item, index));
  }

  if (!membersEqual(before.members, after.members)) {
    commands.push(new SetGraphMembersCommand(before.members, after.members));
  }

  if (!componentsEqual(before.components, after.components)) {
    commands.push(
      new SetGraphComponentsCommand(before.components, after.components),
    );
  }

  if (!functionGraphsEqual(before.functionGraphs, after.functionGraphs)) {
    commands.push(
      new SetGraphFunctionGraphsCommand(
        before.functionGraphs,
        after.functionGraphs,
        functionGraphsMergeKey(before.functionGraphs, after.functionGraphs),
      ),
    );
  }

  if (!actorDefaultsEqual(before.actorDefaults, after.actorDefaults)) {
    commands.push(
      new SetGraphActorDefaultsCommand(before.actorDefaults, after.actorDefaults),
    );
  }

  return commands;
}
