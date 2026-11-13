import { findMirroredReverse, type AnimGraphDocument } from "@haptic/anim-graph";
import { ANIM_STATE_MACHINE_DEBUG_GRAPH_ID } from "@haptic/bridge";
import type { GraphBreakpoints, GraphBreakpointState } from "@haptic/graph-ui";
import type { BreakpointEntry, BreakpointStore } from "../services/breakpoint-store";

/**
 * The State Machine canvas's breakpoints: every state can have one, and a transition's badge shows
 * the breakpoint of either direction of a mirrored Both Ways pair, which the canvas draws as one edge.
 */
export function stateMachineBreakpointView(
  store: BreakpointStore,
  graphGuid: string,
  labelFor: (id: string) => BreakpointEntry["label"],
  latestDoc: () => AnimGraphDocument,
  edit?: (id: string) => void,
): GraphBreakpoints {
  const view = store.graphView(graphGuid, ANIM_STATE_MACHINE_DEBUG_GRAPH_ID, labelFor, { canBreak: () => true, edit });
  return {
    ...view,
    state: (id): GraphBreakpointState | null => {
      const own = view.state(id);
      if (own === "enabled") return own;
      const transitions = latestDoc().stateMachine.transitions;
      const transition = transitions.find((row) => row.id === id);
      const reverse = transition ? findMirroredReverse(transitions, transition) : undefined;
      return (reverse ? view.state(reverse.id) : null) ?? own;
    },
  };
}
