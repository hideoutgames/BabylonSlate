import { findReverseTransition, findStateMachine, type AnimGraphDocument } from "@haptic/anim-graph";
import { animStateMachineDebugGraphId } from "@haptic/bridge";
import type { GraphBreakpoints, GraphBreakpointState } from "@haptic/graph-ui";
import type { BreakpointEntry, BreakpointStore } from "../services/breakpoint-store";

/**
 * A State Machine canvas's breakpoints: every state can have one, and a transition's badge shows
 * the breakpoint of either direction of a Both Ways pair, which the canvas draws as one edge.
 */
export function stateMachineBreakpointView(
  store: BreakpointStore,
  graphGuid: string,
  machineId: string,
  labelFor: (id: string) => BreakpointEntry["label"],
  latestDoc: () => AnimGraphDocument,
  edit?: (id: string) => void,
): GraphBreakpoints {
  const view = store.graphView(graphGuid, animStateMachineDebugGraphId(machineId), labelFor, { canBreak: () => true, edit });
  return {
    ...view,
    state: (id): GraphBreakpointState | null => {
      const own = view.state(id);
      if (own === "enabled") return own;
      const transitions = findStateMachine(latestDoc(), machineId)?.transitions ?? [];
      const transition = transitions.find((row) => row.id === id);
      const reverse = transition ? findReverseTransition(transitions, transition.fromStateId, transition.toStateId) : undefined;
      return (reverse ? view.state(reverse.id) : null) ?? own;
    },
  };
}
