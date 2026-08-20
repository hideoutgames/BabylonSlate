import {
  animGraphMembersFromVariables,
  type AnimGraphDocument,
  type AnimGraphVariable,
} from "@babylonslate/anim-graph";
import type { SerializedGraph } from "@babylonslate/core";
import { syncVariableAccessNodes } from "./class-members";

function withVariables(
  doc: AnimGraphDocument,
  variables: AnimGraphVariable[],
): AnimGraphDocument {
  return {
    ...doc,
    variables,
    parameters: variables
      .filter((variable) => variable.typeId === "bool")
      .map((variable) => variable.name),
  };
}

function syncGraph(
  graph: SerializedGraph,
  declared: ReturnType<typeof animGraphMembersFromVariables>[number],
  previous: ReturnType<typeof animGraphMembersFromVariables>[number],
): SerializedGraph {
  const next = syncVariableAccessNodes(graph, declared, previous);
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
      (previous.name === variable.name && previous.typeId === variable.typeId)
    ) {
      continue;
    }
    const declared = animGraphMembersFromVariables([variable])[0];
    const prior = animGraphMembersFromVariables([previous])[0];
    if (!declared || !prior) continue;
    animationObject = syncGraph(animationObject, declared, prior);
    transitions = transitions.map((transition) => ({
      ...transition,
      ruleGraph: syncGraph(transition.ruleGraph, declared, prior),
    }));
  }
  return withVariables(
    { ...doc, animationObject, transitions },
    variables,
  );
}
