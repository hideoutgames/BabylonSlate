import { findReverseTransition, type AnimGraphDocument } from "@haptic/anim-graph";
import { ANIM_STATE_MACHINE_DEBUG_GRAPH_ID } from "@haptic/bridge";
import type { GraphBreakpoints, GraphBreakpointState } from "@haptic/graph-ui";
import type { BreakpointEntry, BreakpointStore } from "../services/breakpoint-store";

/**
 * The State Machine canvas's breakpoints: every state can have one, and a transition's badge shows
 * the breakpoint of either direction of a Both Ways pair, which the canvas draws as one edge.
 */
export function stateMachineBreakpointView(
  store: BreakpointStore,
  graphGuid: string,
  labelFor: (id: string) => BreakpointEntry["label"],
  latestDoc: () => AnimGraphDocument,
): GraphBreakpoints {
  const view = store.graphView(graphGuid, ANIM_STATE_MACHINE_DEBUG_GRAPH_ID, labelFor, () => true);
  return {
    ...view,
    state: (id): GraphBreakpointState | null => {
      const own = view.state(id);
      if (own === "enabled") return own;
      const { transitions } = latestDoc();
      const row = transitions.find((transition) => transition.id === id);
      const reverse = row ? findReverseTransition(transitions, row.fromStateId, row.toStateId) : undefined;
      return (reverse ? view.state(reverse.id) : null) ?? own;
    },
  };
}
