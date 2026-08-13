import type { SerializedGraph } from "@babylonslate/core";
import type { AnimGraphDocument } from "./graph";
import { createDefaultAnimGraph } from "./graph";

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
