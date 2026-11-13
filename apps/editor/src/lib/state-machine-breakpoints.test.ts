import { describe, expect, it } from "vitest";
import { createDefaultAnimGraph, createDefaultTransitionRuleGraph, setTransitionBidirectional } from "@haptic/anim-graph";
import { animStateMachineDebugGraphId } from "@haptic/bridge";
import { BreakpointStore } from "../services/breakpoint-store";
import { stateMachineBreakpointView } from "./state-machine-breakpoints";

const label = { className: "Loco", graphName: "State Machine", nodeTitle: "Run To Idle" };

describe("stateMachineBreakpointView", () => {
  it("shows a Both Ways pair's breakpoint in either direction on its one edge, enabled first", () => {
    const doc = createDefaultAnimGraph();
    const machine = doc.stateMachines[0]!;
    machine.states.push({ ...machine.states[0]!, id: "run", name: "Run" });
    machine.transitions.push({
      id: "idle-to-run", fromStateId: "idle", toStateId: "run", blendSeconds: 0, priority: 0, ruleGraph: createDefaultTransitionRuleGraph(),
    });
    const both = setTransitionBidirectional(doc, "idle-to-run", true);
    const reverse = both.stateMachines[0]!.transitions.find((row) => row.fromStateId === "run")!;
    const store = new BreakpointStore();
    const view = stateMachineBreakpointView(store, "loco", "locomotion", () => label, () => both);
    const at = (nodeId: string) => ({ assetGuid: "loco", graphId: animStateMachineDebugGraphId("locomotion"), nodeId });

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

  it("keeps each State Machine's breakpoints apart", () => {
    const store = new BreakpointStore();
    const doc = createDefaultAnimGraph();
    const upper = stateMachineBreakpointView(store, "loco", "upper", () => label, () => doc);
    store.toggle({ assetGuid: "loco", graphId: animStateMachineDebugGraphId("locomotion"), nodeId: "idle" }, label);
    expect(stateMachineBreakpointView(store, "loco", "locomotion", () => label, () => doc).state("idle")).toBe("enabled");
    expect(upper.state("idle")).toBeNull();
  });
});
