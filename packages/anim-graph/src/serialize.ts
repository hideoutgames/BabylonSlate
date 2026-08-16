import type { SerializedGraph } from "@babylonslate/core";
import type { AnimGraphDocument, AnimTransition } from "./graph";
import {
  createDefaultAnimGraph,
  createDefaultTransitionRuleGraph,
  defaultAnimStatePosition,
} from "./graph";

export type AnimGraphPin = {
  id: string;
  name: string;
  kind: "exec";
  direction: "in" | "out";
  type: { kind: "exec" };
};

export const ANIM_STATE_PINS: AnimGraphPin[] = [
  {
    id: "in",
    name: "in",
    kind: "exec",
    direction: "in",
    type: { kind: "exec" },
  },
  {
    id: "out",
    name: "out",
    kind: "exec",
    direction: "out",
    type: { kind: "exec" },
  },
];

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

function transitionPairKey(fromStateId: string, toStateId: string): string {
  return `${fromStateId}\0${toStateId}`;
}

function mergeTransitions(
  edges: SerializedGraph["edges"],
  previous: readonly AnimTransition[],
): AnimTransition[] {
  const byId = new Map(previous.map((row) => [row.id, row]));
  const byPair = new Map(
    previous.map((row) => [transitionPairKey(row.fromStateId, row.toStateId), row]),
  );
  return edges.map((edge) => {
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
    };
  });
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
    edges: doc.transitions.map((transition) => ({
      id: transition.id,
      source: transition.fromStateId,
      target: transition.toStateId,
      sourceHandle: "out",
      targetHandle: "in",
      type: "animTransition",
    })),
  };
}

export function serializedToAnimGraph(
  graph: SerializedGraph,
  previous: AnimGraphDocument = createDefaultAnimGraph(),
): AnimGraphDocument {
  const states = graph.nodes.map((node, index) => ({
    id: node.id,
    name:
      typeof node.data.title === "string" ? node.data.title : node.id,
    clipId:
      typeof node.data.clipId === "string" ? node.data.clipId : null,
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
