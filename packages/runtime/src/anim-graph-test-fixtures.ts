import {
  createDefaultTransitionRuleGraph,
  createStateGraph,
  type AnimGraphDimension,
  type AnimGraphDocument,
  type PosePlayerSettings,
} from "@haptic/anim-graph";

/** Graph documents for runtime tests, edited in place: each helper works on the graph's State Machine. */

/** Replaces a state's graph with one player of `clip`; `"2d"` plays it as a Sprite Animation. */
export function setStateClip(
  doc: AnimGraphDocument,
  stateId: string,
  clip: PosePlayerSettings,
  dimension: AnimGraphDimension = "3d",
): void {
  const state = doc.stateMachine.states.find((entry) => entry.id === stateId);
  if (!state) throw new Error(`missing state ${stateId}`);
  state.stateGraph = createStateGraph(dimension, clip);
}

/** Adds a state that plays `clip`. */
export function addClipState(
  doc: AnimGraphDocument,
  id: string,
  name: string,
  clip: PosePlayerSettings,
  dimension: AnimGraphDimension = "3d",
): void {
  const machine = doc.stateMachine;
  machine.states.push({ id, name, position: { x: 80 + machine.states.length * 280, y: 80 }, stateGraph: createStateGraph(dimension, clip) });
}

/** Adds a transition whose rule is the default one: with no compiled rule, it passes. */
export function addTransition(
  doc: AnimGraphDocument,
  id: string,
  fromStateId: string,
  toStateId: string,
  blendSeconds = 0,
): void {
  doc.stateMachine.transitions.push({
    id,
    fromStateId,
    toStateId,
    blendSeconds,
    priority: 0,
    ruleGraph: createDefaultTransitionRuleGraph(),
  });
}
