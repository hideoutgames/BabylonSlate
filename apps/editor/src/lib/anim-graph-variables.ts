import {
  animGraphMembersFromVariables,
  type AnimGraphDocument,
  type AnimGraphVariable,
} from "@babylonslate/anim-graph";
import type { SerializedGraph } from "@babylonslate/core";
import { syncVariableAccessNodes } from "./class-members";

function syncGraph(
  graph: SerializedGraph,
  declared: ReturnType<typeof animGraphMembersFromVariables>[number],
): SerializedGraph {
  const next = syncVariableAccessNodes(graph, declared);
  return { nodes: next.nodes, edges: next.edges };
}

/** Rewrite Get/Set nodes on the Animation Object and every To State rule. */
export function commitAnimGraphVariables(
  doc: AnimGraphDocument,
  variables: AnimGraphVariable[],
): AnimGraphDocument {
  let animationObject = doc.animationObject;
  let transitions = doc.transitions;
  for (const variable of variables) {
    const previous = doc.variables.find((row) => row.id === variable.id);
    if (
      !previous ||
      (previous.name === variable.name && previous.typeId === variable.typeId &&
        previous.typeClassId === variable.typeClassId)
    ) {
      continue;
    }
    const declared = animGraphMembersFromVariables([variable])[0];
    if (!declared) continue;
    animationObject = syncGraph(animationObject, declared);
    transitions = transitions.map((transition) => ({
      ...transition,
      ruleGraph: syncGraph(transition.ruleGraph, declared),
    }));
  }
  return { ...doc, animationObject, transitions, variables };
}
