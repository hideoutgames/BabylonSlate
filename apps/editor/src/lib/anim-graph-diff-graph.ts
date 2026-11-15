import { hydrateAnimGraphForEditor, parseAnimGraphDocument, stateMachineToSerialized } from "@haptic/anim-graph";
import type { GraphDocument } from "@haptic/graph-ui";

/**
 * One stored version of an Animation Graph's State Machine as its editor
 * draws it, for the Diff window: states and State Aliases as cards,
 * transitions as wires (a pair both ways is one wire). The diff stores the
 * machine without its state graphs, which it draws on their own, so the
 * cards name no clip.
 */
export function animStateMachineDiffGraph(stored: unknown, assetType: string): GraphDocument {
  const document = parseAnimGraphDocument(stored, assetType === "AnimationGraph2D" ? "2d" : "3d");
  return document ? hydrateAnimGraphForEditor(stateMachineToSerialized(document.stateMachine)) : { nodes: [], edges: [] };
}
