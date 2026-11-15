import { behaviourTreeToSerialized, hydrateBehaviourTreeForEditor, parseBehaviourTreeDocument } from "@haptic/behaviour-tree";
import type { GraphDocument } from "@haptic/graph-ui";

/**
 * One stored version of a Behaviour Tree as its editor draws it, for the
 * Diff window: laid out as the tree editor lays it out (its stored
 * positions, else the automatic layout), a wire per parent-to-child link.
 */
export function behaviourTreeDiffGraph(stored: unknown): GraphDocument {
  const tree = parseBehaviourTreeDocument(stored);
  return tree ? hydrateBehaviourTreeForEditor(behaviourTreeToSerialized(tree)) : { nodes: [], edges: [] };
}
