import { describe, expect, it } from "vitest";
import {
  createDefaultAnimGraph,
  createDefaultTransitionRuleGraph,
  createStateGraph,
  evaluateAnimGraph,
  type AnimEvalState,
  type AnimGraphDocument,
  type AnimGraphInputs,
  type AnimState,
} from "./index";

/** A state playing one looping clip of `durationMs`, its player in `syncGroup` when given. */
function state(id: string, durationMs: number, syncGroup?: string, loop = true): AnimState {
  const stateGraph = createStateGraph("3d", { assetGuid: id, clipName: id, durationMs, loop });
  if (syncGroup) {
    stateGraph.nodes = stateGraph.nodes.map((node) => (node.id === "player" ? { ...node, data: { ...node.data, syncGroup } } : node));
  }
  return { id, name: id, position: { x: 0, y: 0 }, stateGraph };
}

/** Walk (1 s) → Run (0.5 s) with a 0.4 s blend while Go is set. */
function walkRun(group: string | undefined, runLoops = true): AnimGraphDocument {
  return {
    ...createDefaultAnimGraph("Loco"),
    stateMachine: {
      entryStateId: "walk",
      states: [state("walk", 1000, group), state("run", 500, group, runLoops)],
      transitions: [{ id: "walk-to-run", fromStateId: "walk", toStateId: "run", blendSeconds: 0.4, priority: 0, ruleGraph: createDefaultTransitionRuleGraph() }],
    },
  };
}

const go = (on: boolean): AnimGraphInputs => ({ decideTransition: () => ({ enter: on, exit: true }) });
const timeOf = (state: AnimEvalState, guid: string) => state.layers.find((layer) => layer.clipAssetGuid === guid)?.normalisedTime;

function walkThenRun(doc: AnimGraphDocument) {
  let current = evaluateAnimGraph(doc, null, 0, go(false));
  for (let i = 0; i < 4; i += 1) current = evaluateAnimGraph(doc, current, 0.1, go(false));
  const entered = evaluateAnimGraph(doc, current, 0.1, go(true));
  return { walked: current, entered, blending: evaluateAnimGraph(doc, entered, 0.1, go(false)) };
}

describe("Sync Groups", () => {
  it("starts a state entered with a blend at the group's phase, so the stride carries on", () => {
    const { walked, entered } = walkThenRun(walkRun("Locomotion"));
    expect(timeOf(walked, "walk")).toBeCloseTo(0.4, 6);
    // The tick that enters Run advances the group by Walk's cycle to 0.5; Run joins there instead of at 0.
    expect(entered.stateId).toBe("run");
    expect(timeOf(entered, "run")).toBeCloseTo(0.5, 6);
    expect(timeOf(entered, "walk")).toBeCloseTo(0.5, 6);
    expect(entered.normalisedTime).toBeCloseTo(0.5, 6);
  });

  it("is led by the state blended into once it has played a tick", () => {
    const { entered, blending } = walkThenRun(walkRun("Locomotion"));
    // Walk led the entering tick (1 s cycle): +0.1. Run leads from here, a 0.5 s cycle: +0.2 a tenth of a second.
    expect(timeOf(blending, "run")).toBeCloseTo(0.6, 6);
    expect(timeOf(blending, "walk")).toBeCloseTo(0.6, 6);
    const later = evaluateAnimGraph(walkRun("Locomotion"), blending, 0.1, go(false));
    expect(timeOf(later, "run")).toBeCloseTo(0.8, 6);
    expect(later.normalisedTime).toBeCloseTo(0.8, 6);
    expect(entered.syncGroups?.Locomotion).toEqual({ phase: expect.closeTo(0.5, 6), cycleMs: 1000 });
  });

  it("leaves players without a group, and players that do not loop, on their own time", () => {
    const { entered } = walkThenRun(walkRun(undefined));
    expect(timeOf(entered, "run")).toBe(0);
    expect(entered.syncGroups).toBeUndefined();
    const { entered: oneShot } = walkThenRun(walkRun("Locomotion", false));
    expect(timeOf(oneShot, "run")).toBe(0);
  });
});
