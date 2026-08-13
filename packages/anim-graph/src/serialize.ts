import type { SerializedGraph } from "@babylonslate/core";
import type { AnimGraphDocument } from "./graph";
import { createDefaultAnimGraph } from "./graph";

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
}> {
  return [
    {
      id: "anim.state",
      title: "State",
      category: "Animation",
      pins: ANIM_STATE_PINS,
    },
  ];
}

export function animGraphToSerialized(doc: AnimGraphDocument): SerializedGraph {
  return {
    nodes: doc.states.map((state, index) => ({
      id: state.id,
      type: "anim.state",
      position: { x: 80 + index * 220, y: 80 },
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
    })),
  };
}

export function serializedToAnimGraph(
  graph: SerializedGraph,
  previous: AnimGraphDocument = createDefaultAnimGraph(),
): AnimGraphDocument {
  const states = graph.nodes.map((node) => ({
    id: node.id,
    name:
      typeof node.data.title === "string" ? node.data.title : node.id,
    clipId:
      typeof node.data.clipId === "string" ? node.data.clipId : null,
    speed: typeof node.data.speed === "number" ? node.data.speed : 1,
    loop: node.data.loop !== false,
  }));
  const entry =
    graph.nodes.find((node) => node.data.entry === true)?.id ??
    states[0]?.id ??
    previous.entryStateId;
  return {
    ...previous,
    entryStateId: entry,
    states,
    transitions: graph.edges.map((edge) => ({
      id: edge.id,
      fromStateId: edge.source,
      toStateId: edge.target,
      blendSeconds: 0.1,
      hasExitTime: false,
      exitTime: 0,
    })),
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
