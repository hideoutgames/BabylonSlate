import type { SerializedGraph } from "@haptic/core";
import type { AnimGraphDimension, AnimGraphDocument, AnimState, AnimStateMachine, AnimTransition } from "./graph";
import {
  createDefaultTransitionRuleGraph,
  defaultAnimStatePosition,
} from "./graph";
import { createStateGraph } from "./pose-graph";

export type AnimStateSide = "top" | "right" | "bottom" | "left";

export const ANIM_STATE_SIDES: readonly AnimStateSide[] = [
  "top",
  "right",
  "bottom",
  "left",
];

export type AnimGraphPin = {
  id: string;
  name: string;
  kind: "exec";
  direction: "in" | "out";
  type: { kind: "exec" };
};

const ANIM_STATE_PINS: AnimGraphPin[] = ANIM_STATE_SIDES.flatMap(
  (side) => [
    {
      id: `${side}-in`,
      name: "in",
      kind: "exec",
      direction: "in",
      type: { kind: "exec" },
    },
    {
      id: `${side}-out`,
      name: "out",
      kind: "exec",
      direction: "out",
      type: { kind: "exec" },
    },
  ],
);

export function animPaletteNodes(): Array<{
  id: "anim.state";
  title: string;
  category: string;
  pins: AnimGraphPin[];
  defaultData: Record<string, unknown>;
}> {
  return [
    {
      id: "anim.state",
      title: "State",
      category: "Animation",
      pins: ANIM_STATE_PINS,
      defaultData: {
        entry: false,
      },
    },
  ];
}

const ANIM_STATE_HANDLE = /^(top|right|bottom|left)-(?:in|out)$/;

/**
 * The state handle on the same side facing `direction`. Loose connections can
 * start or end on either plate of a side (`left-in` as a source becomes
 * `left-out`). A missing or unknown id uses the default `right-out` / `left-in`.
 */
function animStateHandle(
  handle: string | null | undefined,
  direction: "in" | "out",
): string {
  const side = handle ? ANIM_STATE_HANDLE.exec(handle)?.[1] : undefined;
  if (side) return `${side}-${direction}`;
  return direction === "out" ? "right-out" : "left-in";
}

export function normalizeAnimConnection(connection: {
  source: string | null | undefined;
  target: string | null | undefined;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}): {
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
} | null {
  if (!connection.source || !connection.target) return null;
  if (connection.source === connection.target) return null;
  return {
    source: connection.source,
    target: connection.target,
    sourceHandle: animStateHandle(connection.sourceHandle, "out"),
    targetHandle: animStateHandle(connection.targetHandle, "in"),
  };
}

/**
 * Whether a canvas transition leaves or enters `stateId` on the side of `handleId` (either plate): what a break from
 * that side removes.
 */
export function animTransitionOnSide(
  edge: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null },
  stateId: string,
  handleId: string,
): boolean {
  const side = ANIM_STATE_HANDLE.exec(handleId)?.[1];
  if (!side) return false;
  return (edge.source === stateId && animStateHandle(edge.sourceHandle, "out") === `${side}-out`) ||
    (edge.target === stateId && animStateHandle(edge.targetHandle, "in") === `${side}-in`);
}

type AnimDragRect = { x: number; y: number; width: number; height: number };

/** The side of `rect` that `point` lies toward, measured against the box's half extents. */
function sideToward(rect: AnimDragRect, point: { x: number; y: number }): { side: AnimStateSide; reach: number } {
  const dx = (point.x - (rect.x + rect.width / 2)) / Math.max(rect.width / 2, 1);
  const dy = (point.y - (rect.y + rect.height / 2)) / Math.max(rect.height / 2, 1);
  if (Math.abs(dx) >= Math.abs(dy)) return { side: dx >= 0 ? "right" : "left", reach: Math.abs(dx) };
  return { side: dy >= 0 ? "bottom" : "top", reach: Math.abs(dy) };
}

const rectCentre = (rect: AnimDragRect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

/**
 * The transition a drag between two states makes: always from the dragged state, leaving by the side it was dragged
 * from. It enters the other state on the side it was released on: the handle's side, else the side nearest the
 * release point, else (near the middle, or with no point) the side facing the dragged state.
 */
export function animTransitionFromDrag(drag: {
  fromNodeId: string;
  fromHandleId: string;
  toNodeId: string;
  toHandleId: string | null;
  point: { x: number; y: number } | null;
  fromRect: AnimDragRect | null;
  toRect: AnimDragRect | null;
}): { source: string; target: string; sourceHandle: string; targetHandle: string } | null {
  if (drag.fromNodeId === drag.toNodeId) return null;
  const facing = drag.fromRect && drag.toRect ? sideToward(drag.toRect, rectCentre(drag.fromRect)).side : "left";
  const released = drag.point && drag.toRect ? sideToward(drag.toRect, drag.point) : null;
  const handleSide = drag.toHandleId ? ANIM_STATE_HANDLE.exec(drag.toHandleId)?.[1] : undefined;
  const targetSide = handleSide ?? (released && released.reach >= 0.5 ? released.side : facing);
  const fromSide = ANIM_STATE_HANDLE.exec(drag.fromHandleId)?.[1]
    ?? (drag.fromRect && drag.toRect ? sideToward(drag.fromRect, rectCentre(drag.toRect)).side : "right");
  return {
    source: drag.fromNodeId,
    target: drag.toNodeId,
    sourceHandle: `${fromSide}-out`,
    targetHandle: `${targetSide}-in`,
  };
}

function transitionPairKey(fromStateId: string, toStateId: string): string {
  return `${fromStateId}\0${toStateId}`;
}

export function findReverseTransition(
  transitions: readonly AnimTransition[],
  fromStateId: string,
  toStateId: string,
): AnimTransition | undefined {
  return transitions.find(
    (row) => row.fromStateId === toStateId && row.toStateId === fromStateId,
  );
}

const handleSide = (handle: string | undefined, direction: "in" | "out"): string =>
  animStateHandle(handle, direction).split("-")[0]!;

/**
 * The reverse of a transition when it runs between the same two sides (B's side out to A's side in, where A→B leaves
 * A's side for B's): the pair is drawn as one Both Ways wire. A reverse on other sides is a wire of its own.
 */
export function findMirroredReverse(
  transitions: readonly AnimTransition[],
  transition: AnimTransition,
): AnimTransition | undefined {
  const reverse = findReverseTransition(transitions, transition.fromStateId, transition.toStateId);
  if (!reverse || reverse.id === transition.id) return undefined;
  return handleSide(reverse.sourceHandle, "out") === handleSide(transition.targetHandle, "in")
    && handleSide(reverse.targetHandle, "in") === handleSide(transition.sourceHandle, "out")
    ? reverse
    : undefined;
}

/** The transitions drawn as wires: each one, except the second of a mirrored pair, which shares the first's. */
function visualTransitions(
  transitions: readonly AnimTransition[],
): AnimTransition[] {
  const skip = new Set<string>();
  const seenPair = new Set<string>();
  const visual: AnimTransition[] = [];
  for (const row of transitions) {
    if (skip.has(row.id)) continue;
    const pair = transitionPairKey(row.fromStateId, row.toStateId);
    if (seenPair.has(pair)) continue;
    seenPair.add(pair);
    visual.push(row);
    const mirrored = findMirroredReverse(transitions, row);
    if (mirrored) skip.add(mirrored.id);
  }
  return visual;
}

/** A state card's half size on the canvas, for the centre a wire point is measured to. */
const STATE_CARD_HALF = { x: 100, y: 45 };

/**
 * The transition a double-click on a wire opens: the wire's own, or on a mirrored pair's shared wire the direction
 * whose arrowhead (its target state) is nearer the point.
 */
export function transitionAtWire(
  machine: AnimStateMachine,
  edgeId: string,
  point: { x: number; y: number } | null,
): AnimTransition | undefined {
  const row = machine.transitions.find((candidate) => candidate.id === edgeId);
  if (!row) return undefined;
  const mirrored = findMirroredReverse(machine.transitions, row);
  if (!mirrored || !point) return row;
  const distance = (stateId: string) => {
    const position = machine.states.find((state) => state.id === stateId)?.position;
    if (!position) return Number.POSITIVE_INFINITY;
    return Math.hypot(point.x - (position.x + STATE_CARD_HALF.x), point.y - (position.y + STATE_CARD_HALF.y));
  };
  return distance(row.fromStateId) < distance(row.toStateId) ? mirrored : row;
}

/**
 * The id of the canvas edge that draws a transition taken from one state to another: its own, or for the second of
 * a mirrored pair, the first's. The runtime's debug trace names the transition it took by it.
 */
export function animTransitionEdgeId(
  transitions: readonly AnimTransition[],
  fromStateId: string,
  toStateId: string,
): string | undefined {
  const row = transitions.find((candidate) => candidate.fromStateId === fromStateId && candidate.toStateId === toStateId);
  if (!row) return undefined;
  if (visualTransitions(transitions).some((visual) => visual.id === row.id)) return row.id;
  return findMirroredReverse(transitions, row)?.id;
}

function uniqueTransitionId(doc: AnimGraphDocument): string {
  const ids = new Set(doc.stateMachine.transitions.map((row) => row.id));
  let index = 1;
  while (ids.has(`transition-${index}`)) index += 1;
  return `transition-${index}`;
}

function withTransitions(doc: AnimGraphDocument, transitions: AnimTransition[]): AnimGraphDocument {
  return { ...doc, stateMachine: { ...doc.stateMachine, transitions } };
}

export function setTransitionBidirectional(
  doc: AnimGraphDocument,
  transitionId: string,
  bothWays: boolean,
): AnimGraphDocument {
  const machine = doc.stateMachine;
  const transition = machine.transitions.find((row) => row.id === transitionId);
  if (!transition) return doc;
  const reverse = findReverseTransition(
    machine.transitions,
    transition.fromStateId,
    transition.toStateId,
  );
  if (bothWays) {
    if (reverse) return doc;
    return withTransitions(doc, [
      ...machine.transitions,
      {
        id: uniqueTransitionId(doc),
        fromStateId: transition.toStateId,
        toStateId: transition.fromStateId,
        blendSeconds: transition.blendSeconds,
        priority: transition.priority,
        ruleGraph: createDefaultTransitionRuleGraph(),
        // The mirrored sides, so the pair shares one wire.
        sourceHandle: `${handleSide(transition.targetHandle, "in")}-out`,
        targetHandle: `${handleSide(transition.sourceHandle, "out")}-in`,
      },
    ]);
  }
  if (!reverse) return doc;
  return withTransitions(doc, machine.transitions.filter((row) => row.id !== reverse.id));
}

export function flipTransitionDirection(
  doc: AnimGraphDocument,
  transitionId: string,
): AnimGraphDocument {
  const machine = doc.stateMachine;
  const transition = machine.transitions.find((row) => row.id === transitionId);
  if (!transition) return doc;
  const reverse = findReverseTransition(
    machine.transitions,
    transition.fromStateId,
    transition.toStateId,
  );
  if (reverse) return doc;
  return withTransitions(doc, machine.transitions.map((row) =>
    row.id === transitionId
      ? {
          ...row,
          fromStateId: row.toStateId,
          toStateId: row.fromStateId,
          sourceHandle: `${handleSide(row.targetHandle, "in")}-out`,
          targetHandle: `${handleSide(row.sourceHandle, "out")}-in`,
        }
      : row,
  ));
}

export function patchTransition(
  doc: AnimGraphDocument,
  transitionId: string,
  patch: Partial<AnimTransition>,
): AnimGraphDocument {
  return withTransitions(doc, doc.stateMachine.transitions.map((row) =>
    row.id === transitionId ? { ...row, ...patch } : row,
  ));
}

function mergeTransitions(
  edges: SerializedGraph["edges"],
  previous: readonly AnimTransition[],
): AnimTransition[] {
  const byId = new Map(previous.map((row) => [row.id, row]));
  const byPair = new Map(
    previous.map((row) => [
      transitionPairKey(row.fromStateId, row.toStateId),
      row,
    ]),
  );
  const chosen = new Map<string, (typeof edges)[number]>();
  for (const edge of edges) {
    const pair = transitionPairKey(edge.source, edge.target);
    const existing = chosen.get(pair);
    if (!existing) {
      chosen.set(pair, edge);
      continue;
    }
    if (byId.has(edge.id) && !byId.has(existing.id)) {
      chosen.set(pair, edge);
    }
  }
  const merged: AnimTransition[] = [...chosen.values()].map((edge) => {
    const prev =
      byId.get(edge.id) ??
      byPair.get(transitionPairKey(edge.source, edge.target));
    // A wire drawn again between the same two states keeps its transition (id, rule, settings) on its new sides.
    return {
      id: prev?.id ?? edge.id,
      fromStateId: edge.source,
      toStateId: edge.target,
      blendSeconds: prev?.blendSeconds ?? 0.1,
      priority: prev?.priority ?? 0,
      ruleGraph: prev?.ruleGraph ?? createDefaultTransitionRuleGraph(),
      sourceHandle: animStateHandle(edge.sourceHandle, "out"),
      targetHandle: animStateHandle(edge.targetHandle, "in"),
    };
  });
  const result = [...merged];
  const ids = new Set(result.map((row) => row.id));
  const hasPair = (fromStateId: string, toStateId: string) =>
    result.some((row) => row.fromStateId === fromStateId && row.toStateId === toStateId);
  // The second of a mirrored pair has no wire of its own: it stays while its partner's wire does, keeping its sides,
  // unless a wire of its own was drawn for it.
  const drawn = new Set(visualTransitions(previous).map((row) => row.id));
  for (const prev of previous) {
    if (ids.has(prev.id) || drawn.has(prev.id)) continue;
    if (hasPair(prev.fromStateId, prev.toStateId) || !hasPair(prev.toStateId, prev.fromStateId)) continue;
    result.push(prev);
    ids.add(prev.id);
  }
  return result;
}

/** A State Machine as its canvas graph: a node per state, an edge per transition pair. */
export function stateMachineToSerialized(machine: AnimStateMachine): SerializedGraph {
  return {
    nodes: machine.states.map((state, index) => ({
      id: state.id,
      type: "anim.state",
      position: state.position ?? defaultAnimStatePosition(index),
      data: {
        title: state.name,
        entry: state.id === machine.entryStateId,
      },
    })),
    edges: visualTransitions(machine.transitions).map((transition) => {
      const mirrored = findMirroredReverse(machine.transitions, transition);
      return {
        id: transition.id,
        source: transition.fromStateId,
        target: transition.toStateId,
        sourceHandle: animStateHandle(transition.sourceHandle, "out"),
        targetHandle: animStateHandle(transition.targetHandle, "in"),
        type: mirrored ? "animTransitionBoth" : "animTransition",
      };
    }),
  };
}

/**
 * A State Machine canvas back onto the machine: states keep their graphs, a state new to the canvas (added or
 * pasted) starts with one player of the graph's dimension, and transitions keep their rules.
 */
export function serializedToStateMachine(
  graph: SerializedGraph,
  previous: AnimStateMachine,
  dimension: AnimGraphDimension,
): AnimStateMachine {
  const byId = new Map(previous.states.map((state) => [state.id, state]));
  const names = new Set(graph.nodes.filter((node) => byId.has(node.id))
    .map((node) => String(node.data.title ?? node.id).trim().toLowerCase()));
  const states: AnimState[] = graph.nodes.map((node, index) => {
    let name = typeof node.data.title === "string" ? node.data.title : node.id;
    const existing = byId.get(node.id);
    // Palette additions and pasted states share a title. Allocate a fresh label
    // while leaving explicitly renamed existing states for validation to explain.
    if (!existing) {
      const base = name.trim() || "State";
      name = base;
      let suffix = 2;
      while (names.has(name.toLowerCase())) name = `${base} ${suffix++}`;
      names.add(name.toLowerCase());
    }
    return {
      id: node.id,
      name,
      position: node.position ?? defaultAnimStatePosition(index),
      stateGraph: existing?.stateGraph ?? createStateGraph(dimension),
    };
  });
  const entry =
    graph.nodes.find((node) => node.data.entry === true)?.id ??
    states[0]?.id ??
    previous.entryStateId;
  return {
    ...previous,
    entryStateId: entry,
    states,
    transitions: mergeTransitions(graph.edges, previous.transitions),
  };
}

export function hydrateAnimGraphForEditor(
  graph: SerializedGraph,
): SerializedGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const data = { ...(node.data as Record<string, unknown>) };
      if (Array.isArray(data.__pins) && data.__pins.length > 0) {
        return { ...node, data };
      }
      return {
        ...node,
        data: { ...data, __pins: ANIM_STATE_PINS },
      };
    }),
  };
}
