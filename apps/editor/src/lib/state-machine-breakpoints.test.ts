import { describe, expect, it } from "vitest";
import { createDefaultAnimGraph, createDefaultTransitionRuleGraph, setTransitionBidirectional } from "@haptic/anim-graph";
import { ANIM_STATE_MACHINE_DEBUG_GRAPH_ID } from "@haptic/bridge";
import { BreakpointStore } from "../services/breakpoint-store";
import { stateMachineBreakpointView } from "./state-machine-breakpoints";

const label = { className: "Loco", graphName: "State Machine", nodeTitle: "Run To Idle" };

describe("stateMachineBreakpointView", () => {
  it("shows a Both Ways pair's breakpoint in either direction on its one edge, enabled first", () => {
    const doc = createDefaultAnimGraph();
    const machine = doc.stateMachine;
    machine.states.push({ ...machine.states[0]!, id: "run", name: "Run" });
    machine.transitions.push({
      id: "idle-to-run", fromStateId: "idle", toStateId: "run", blendSeconds: 0, priority: 0, ruleGraph: createDefaultTransitionRuleGraph(),
    });
    const both = setTransitionBidirectional(doc, "idle-to-run", true);
    const reverse = both.stateMachine.transitions.find((row) => row.fromStateId === "run")!;
    const store = new BreakpointStore();
    const view = stateMachineBreakpointView(store, "loco", () => label, () => both);
    const at = (nodeId: string) => ({ assetGuid: "loco", graphId: ANIM_STATE_MACHINE_DEBUG_GRAPH_ID, nodeId });

    expect(view.state("idle-to-run")).toBeNull();
    store.toggle(at(reverse.id), label);
    expect(view.state("idle-to-run")).toBe("enabled");
    store.setEnabled(at(reverse.id), false);
    expect(view.state("idle-to-run")).toBe("disabled");
    store.toggle(at("idle-to-run"), label);
    store.setEnabled(at("idle-to-run"), false);
    store.setEnabled(at(reverse.id), true);
    expect(view.state("idle-to-run")).toBe("enabled");
    expect(view.state("idle")).toBeNull();
  });
});
