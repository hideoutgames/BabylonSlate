import type { SerializedGraph } from "@babylonslate/core";
import type { AnimGraphDocument, AnimTransition } from "./graph";
import {
  createDefaultAnimGraph,
  createDefaultTransitionRuleGraph,
  defaultAnimStatePosition,
} from "./graph";

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

export const ANIM_STATE_PINS: AnimGraphPin[] = ANIM_STATE_SIDES.flatMap(
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
        clipId: null,
        speed: 1,
        loop: true,
        entry: false,
      },
    },
  ];
}

export function migrateAnimHandle(
  handle: string | null | undefined,
  direction: "in" | "out",
): string {
  if (!handle || handle === "in" || handle === "out") {
    return direction === "out" ? "right-out" : "left-in";
  }
  const side = handle.split("-")[0];
  if (
    side === "top" ||
    side === "right" ||
    side === "bottom" ||
    side === "left"
  ) {
    return `${side}-${direction}`;
  }
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
    sourceHandle: migrateAnimHandle(connection.sourceHandle, "out"),
    targetHandle: migrateAnimHandle(connection.targetHandle, "in"),
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

export function visualTransitions(
  transitions: readonly AnimTransition[],
): AnimTransition[] {
  const skip = new Set<string>();
  const visual: AnimTransition[] = [];
  for (const row of transitions) {
    if (skip.has(row.id)) continue;
    visual.push(row);
    const reverse = findReverseTransition(
      transitions,
      row.fromStateId,
      row.toStateId,
    );
    if (reverse && reverse.id !== row.id) skip.add(reverse.id);
  }
  return visual;
}

function uniqueTransitionId(doc: AnimGraphDocument): string {
  const ids = new Set(doc.transitions.map((row) => row.id));
  let index = 1;
  while (ids.has(`transition-${index}`)) index += 1;
  return `transition-${index}`;
}

export function setTransitionBidirectional(
  doc: AnimGraphDocument,
  transitionId: string,
  bothWays: boolean,
): AnimGraphDocument {
  const transition = doc.transitions.find((row) => row.id === transitionId);
  if (!transition) return doc;
  const reverse = findReverseTransition(
    doc.transitions,
    transition.fromStateId,
    transition.toStateId,
  );
  if (bothWays) {
    if (reverse) return doc;
    return {
      ...doc,
      transitions: [
        ...doc.transitions,
        {
          id: uniqueTransitionId(doc),
          fromStateId: transition.toStateId,
          toStateId: transition.fromStateId,
          blendSeconds: transition.blendSeconds,
          priority: transition.priority,
          ruleGraph: createDefaultTransitionRuleGraph(),
          sourceHandle: "right-out",
          targetHandle: "left-in",
        },
      ],
    };
  }
  if (!reverse) return doc;
  return {
    ...doc,
    transitions: doc.transitions.filter((row) => row.id !== reverse.id),
  };
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
  const merged = edges.map((edge) => {
    const prev =
      byId.get(edge.id) ??
      byPair.get(transitionPairKey(edge.source, edge.target));
    return {
      id: edge.id,
      fromStateId: edge.source,
      toStateId: edge.target,
      condition: prev?.condition,
      blendSeconds: prev?.blendSeconds ?? 0.1,
      hasExitTime: prev?.hasExitTime ?? false,
      exitTime: prev?.exitTime ?? 0,
      priority: prev?.priority ?? 0,
      ruleGraph: prev?.ruleGraph ?? createDefaultTransitionRuleGraph(),
      sourceHandle: migrateAnimHandle(edge.sourceHandle, "out"),
      targetHandle: migrateAnimHandle(edge.targetHandle, "in"),
    };
  });
  const result = [...merged];
  const ids = new Set(result.map((row) => row.id));
  for (const prev of previous) {
    if (ids.has(prev.id)) continue;
    const reverseOf = result.find(
      (row) =>
        row.fromStateId === prev.toStateId && row.toStateId === prev.fromStateId,
    );
    if (!reverseOf) continue;
    result.push(prev);
    ids.add(prev.id);
  }
  return result;
}

export function animGraphToSerialized(doc: AnimGraphDocument): SerializedGraph {
  return {
    nodes: doc.states.map((state, index) => ({
      id: state.id,
      type: "anim.state",
      position: state.position ?? defaultAnimStatePosition(index),
      data: {
        title: state.name,
        clipId: state.clipId,
        speed: state.speed,
        loop: state.loop,
        entry: state.id === doc.entryStateId,
      },
    })),
    edges: visualTransitions(doc.transitions).map((transition) => {
      const reverse = findReverseTransition(
        doc.transitions,
        transition.fromStateId,
        transition.toStateId,
      );
      return {
        id: transition.id,
        source: transition.fromStateId,
        target: transition.toStateId,
        sourceHandle: migrateAnimHandle(transition.sourceHandle, "out"),
        targetHandle: migrateAnimHandle(transition.targetHandle, "in"),
        type: reverse ? "animTransitionBoth" : "animTransition",
      };
    }),
  };
}

export function serializedToAnimGraph(
  graph: SerializedGraph,
  previous: AnimGraphDocument = createDefaultAnimGraph(),
): AnimGraphDocument {
  const states = graph.nodes.map((node, index) => ({
    id: node.id,
    name: typeof node.data.title === "string" ? node.data.title : node.id,
    clipId: typeof node.data.clipId === "string" ? node.data.clipId : null,
    speed: typeof node.data.speed === "number" ? node.data.speed : 1,
    loop: node.data.loop !== false,
    position: node.position ?? defaultAnimStatePosition(index),
  }));
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
