import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@haptic/core";
import {
  animClipSweep,
  animEvalWithJump,
  animSweepCrossings,
  createDefaultAnimGraph,
  createDefaultTransitionRuleGraph,
  createStateGraph,
  evaluateAnimGraph,
  resolveAnimGraphClips,
  type AnimClipEvent,
  type AnimEvalState,
  type AnimGraphDocument,
  type AnimGraphInputs,
  type AnimState,
  type AnimStateEvents,
} from "./index";

type GraphNode = SerializedGraph["nodes"][number];

const footstep = (name: string, timeMs: number, extra: Partial<AnimClipEvent> = {}): AnimClipEvent => ({
  name,
  timeMs,
  durationMs: 0,
  triggerWeight: 0.5,
  action: null,
  ...extra,
});

/** A state playing one clip of `durationMs` with `events` on its player (as resolution stores them). */
function state(id: string, durationMs: number, events: AnimClipEvent[], extra: { loop?: boolean; events?: AnimStateEvents } = {}): AnimState {
  const stateGraph = createStateGraph("3d", { assetGuid: id, clipName: id, durationMs, loop: extra.loop ?? true });
  stateGraph.nodes = stateGraph.nodes.map((node) => (node.id === "player" ? { ...node, data: { ...node.data, events } } : node));
  return { id, name: id, position: { x: 0, y: 0 }, stateGraph, ...(extra.events ? { events: extra.events } : {}) };
}

function machine(states: AnimState[], transitions: Array<{ from: string; to: string; blendSeconds: number }> = []): AnimGraphDocument {
  return {
    ...createDefaultAnimGraph("Loco"),
    stateMachine: {
      entryStateId: states[0]!.id,
      states,
      transitions: transitions.map((row, index) => ({
        id: `t${index}`,
        fromStateId: row.from,
        toStateId: row.to,
        blendSeconds: row.blendSeconds,
        priority: 0,
        ruleGraph: createDefaultTransitionRuleGraph(),
      })),
    },
  };
}

const go = (on: boolean): AnimGraphInputs => ({ decideTransition: () => ({ enter: on, exit: true }) });
const named = (result: AnimEvalState) => (result.events ?? []).map((event) => `${event.name}:${event.phase}`);

/** Evaluates `doc` tick by tick with these lengths, returning what each tick fired. */
function run(doc: AnimGraphDocument, ticks: Array<number | [number, boolean]>, start: AnimEvalState | null = null) {
  let current = start;
  return ticks.map((tick) => {
    const [dt, on] = Array.isArray(tick) ? tick : [tick, false];
    current = evaluateAnimGraph(doc, current, dt, go(on));
    return { state: current, fired: named(current) };
  });
}

describe("animSweepCrossings", () => {
  it.each([
    ["inside a pass", { from: 0.2, to: 0.3, inclusive: false, loop: true }, 0.25, [0.25]],
    ["exactly at the end of the sweep", { from: 0.2, to: 0.25, inclusive: false, loop: true }, 0.25, [0.25]],
    ["exactly at its start, not counted twice", { from: 0.25, to: 0.4, inclusive: false, loop: true }, 0.25, []],
    ["at its start when the player starts there", { from: 0, to: 0.1, inclusive: true, loop: true }, 0, [0]],
    ["across the wrap", { from: 0.9, to: 1.3, inclusive: false, loop: true }, 0.1, [1.1]],
    ["at the end of a looping clip, as the next pass starts", { from: 0.9, to: 1.05, inclusive: false, loop: true }, 1, [1]],
    ["once a pass over two passes", { from: 0.5, to: 2.6, inclusive: false, loop: true }, 0.25, [1.25, 2.25]],
    ["not again once a clip that plays once has ended", { from: 1, to: 1, inclusive: false, loop: false }, 1, []],
    ["at the end of a clip that plays once", { from: 0.9, to: 1, inclusive: false, loop: false }, 1, [1]],
  ])("crosses an event %s", (_label, sweep, at, expected) => {
    expect(animSweepCrossings(sweep, at)).toEqual(expected);
  });

  it("counts the passes a looping clock completed, and one for a Sync Group phase that came round", () => {
    expect(animClipSweep({ normalised: 0.8, loopCount: 0 }, { normalised: 0.1, loopCount: 1 }, true, false).to).toBeCloseTo(1.1, 9);
    expect(animClipSweep({ normalised: 0.8, loopCount: 3 }, { normalised: 0.1, loopCount: 3 }, true, false).to).toBeCloseTo(1.1, 9);
  });
});

describe("Animation Events from players", () => {
  it("fires a single event once a pass as the player crosses it, the wrap included", () => {
    const doc = machine([state("walk", 1000, [footstep("Footstep", 250)])]);
    const ticks = run(doc, [0, 0.2, 0.1, 0.5, 0.5]);
    expect(ticks.map((tick) => tick.fired)).toEqual([[], [], ["Footstep:event"], [], ["Footstep:event"]]);
    expect(ticks[2]!.state.events![0]).toEqual({ name: "Footstep", phase: "event", clipAssetGuid: "walk", stateId: "walk", action: null });
  });

  it("fires an event at the start of a clip as it starts and on each pass, never twice at the start", () => {
    const doc = machine([state("walk", 1000, [footstep("Start", 0)])]);
    expect(run(doc, [0, 0.5, 0.5, 0.2]).map((tick) => tick.fired)).toEqual([["Start:event"], [], ["Start:event"], []]);
  });

  it("begins and ends a window as the player crosses its two ends, both in one tick when it is short", () => {
    const doc = machine([state("swing", 1000, [footstep("Hit", 400, { durationMs: 200 })])]);
    const ticks = run(doc, [0, 0.45, 0.2, 0.5]);
    expect(ticks.map((tick) => tick.fired)).toEqual([[], ["Hit:begin"], ["Hit:end"], []]);
    expect(ticks[1]!.state.openWindows).toEqual({ "swing#player#0": expect.objectContaining({ name: "Hit", source: "swing#player" }) });
    expect(ticks[2]!.state.openWindows).toBeUndefined();
    const quick = machine([state("swing", 1000, [footstep("Hit", 400, { durationMs: 50 })])]);
    expect(run(quick, [0, 0.5]).map((tick) => tick.fired)).toEqual([[], ["Hit:begin", "Hit:end"]]);
  });

  it("ends a window when its state is left, so its begin and end always pair", () => {
    const doc = machine(
      [state("swing", 1000, [footstep("Hit", 400, { durationMs: 400 })]), state("idle", 1000, [])],
      [{ from: "swing", to: "idle", blendSeconds: 0 }],
    );
    const ticks = run(doc, [0, 0.5, [0.1, true]]);
    expect(ticks.map((tick) => tick.fired)).toEqual([[], ["Hit:begin"], ["Hit:end"]]);
    expect(ticks[2]!.state.openWindows).toBeUndefined();
  });

  it("fires only from a clip playing at or above the event's Trigger Weight, so a crossfade does not double a step", () => {
    const doc = machine(
      [state("walk", 1000, [footstep("Walk Step", 500)]), state("run", 1000, [footstep("Run Step", 100), footstep("Run Light", 150, { triggerWeight: 0.1 })])],
      [{ from: "walk", to: "run", blendSeconds: 1 }],
    );
    // Walk to 0.4, then into Run with a one-second crossfade.
    const ticks = run(doc, [0, 0.4, [0.05, true], 0.05, 0.05, 0.05]);
    // Walk crosses 0.5 at weight about 0.9: it fires. Run crosses 0.1 at weight 0.1: only the Light event (0.1) fires.
    expect(ticks.slice(2).flatMap((tick) => tick.fired)).toEqual(["Walk Step:event", "Run Light:event"]);
  });

  it("does not fire from a player whose input is switched off", () => {
    const doc = machine([state("walk", 1000, [footstep("Footstep", 250)])]);
    const player = doc.stateMachine.states[0]!.stateGraph.nodes.find((node) => node.id === "player")!;
    const output = doc.stateMachine.states[0]!.stateGraph.nodes.find((node) => node.id !== "player")!;
    const blend: GraphNode = { id: "blend", type: "anim.pose.blend", position: { x: 0, y: 0 }, data: { "default:alpha": 1 } };
    doc.stateMachine.states[0]!.stateGraph = {
      nodes: [player, blend, output],
      edges: [
        { id: "a", source: "player", sourceHandle: "pose", target: "blend", targetHandle: "a" },
        { id: "o", source: "blend", sourceHandle: "pose", target: output.id, targetHandle: "pose" },
      ],
    };
    expect(run(doc, [0, 0.5]).flatMap((tick) => tick.fired)).toEqual([]);
  });
});

describe("state events", () => {
  const events = (id: string): AnimStateEvents => ({ enter: `${id} Enter`, exit: `${id} Exit`, fullyBlended: `${id} Blended` });

  it("fires Enter and Fully Blended as the entry state starts, and Exit, Enter and Fully Blended on an instant transition", () => {
    const doc = machine(
      [state("idle", 1000, [], { events: events("Idle") }), state("walk", 1000, [], { events: events("Walk") })],
      [{ from: "idle", to: "walk", blendSeconds: 0 }],
    );
    expect(run(doc, [0, 0.1, [0.1, true], 0.1]).map((tick) => tick.fired)).toEqual([
      ["Idle Enter:event", "Idle Blended:event"],
      [],
      ["Idle Exit:event", "Walk Enter:event", "Walk Blended:event"],
      [],
    ]);
  });

  it("fires Fully Blended the tick a crossfade into the state completes", () => {
    const doc = machine(
      [state("idle", 1000, [], { events: events("Idle") }), state("walk", 1000, [], { events: events("Walk") })],
      [{ from: "idle", to: "walk", blendSeconds: 0.25 }],
    );
    const fired = run(doc, [0, [0.1, true], 0.1, 0.1, 0.1]).map((tick) => tick.fired);
    expect(fired.slice(1)).toEqual([["Idle Exit:event", "Walk Enter:event"], [], ["Walk Blended:event"], []]);
  });

  it("fires the left state's Exit and the target's Enter on a jump", () => {
    const doc = machine([state("idle", 1000, [], { events: events("Idle") }), state("hit", 1000, [], { events: events("Hit") })]);
    const [first] = run(doc, [0]);
    const jumped = animEvalWithJump(doc, first!.state, "hit");
    expect(named(evaluateAnimGraph(doc, jumped, 0.1, go(false)))).toEqual(["Idle Exit:event", "Hit Enter:event", "Hit Blended:event"]);
  });
});

describe("Blend Space events", () => {
  const space = (eventMode: "highestWeight" | "all" | "none") => ({
    axes: [{ min: 0, max: 2, wrap: false, smoothingSeconds: 0 }],
    samples: [
      { animationGuid: "walk", clipName: "Walk", durationMs: 1000, x: 0, y: 0, rateScale: 1, events: [footstep("Walk Step", 500)] },
      { animationGuid: "run", clipName: "Run", durationMs: 1000, x: 2, y: 0, rateScale: 1, events: [footstep("Run Step", 500, { triggerWeight: 0.2 })] },
    ],
    eventMode,
  });
  const blendSpaceGraph = (eventMode: "highestWeight" | "all" | "none"): AnimGraphDocument => {
    const doc = machine([state("move", 1000, [])]);
    doc.stateMachine.states[0]!.stateGraph = {
      nodes: [
        { id: "bs", type: "anim.pose.blendSpacePlayer", position: { x: 0, y: 0 }, data: { assetGuid: "loco", blendSpace: space(eventMode) } },
        { id: "output", type: "anim.pose.output", position: { x: 300, y: 0 }, data: { __protected: true } },
      ],
      edges: [{ id: "o", source: "bs", sourceHandle: "pose", target: "output", targetHandle: "pose" }],
    };
    return doc;
  };
  // At x 0.6 Walk weighs 0.7 and Run 0.3.
  const inputs: AnimGraphInputs = { poseData: (key) => (key === "move" ? { bs: { x: 0.6 } } : undefined) };
  const fired = (eventMode: "highestWeight" | "all" | "none") => {
    const doc = blendSpaceGraph(eventMode);
    const first = evaluateAnimGraph(doc, null, 0.4, inputs);
    return named(evaluateAnimGraph(doc, first, 0.2, inputs));
  };

  it.each([
    ["highestWeight", ["Walk Step:event"]],
    ["all", ["Walk Step:event", "Run Step:event"]],
    ["none", []],
  ] as const)("fires per its event mode (%s)", (mode, expected) => {
    expect(fired(mode)).toEqual(expected);
  });
});

describe("resolveAnimGraphClips", () => {
  it("copies an Animation's events onto its player and each Blend Space sample", () => {
    const events = [footstep("Footstep", 300)];
    const doc = machine([state("walk", 1000, [])]);
    const player = doc.stateMachine.states[0]!.stateGraph.nodes.find((node) => node.id === "player")!;
    delete player.data.events;
    const resolved = resolveAnimGraphClips(doc, [{ guid: "walk", type: "Animation", name: "Walk", clipName: "walk", durationMs: 1000, events }]);
    expect(resolved.stateMachine.states[0]!.stateGraph.nodes.find((node) => node.id === "player")!.data.events).toEqual(events);
    expect(resolveAnimGraphClips(resolved, [{ guid: "walk", type: "Animation", name: "Walk", clipName: "walk", durationMs: 1000, events }])).toBe(resolved);
  });
});
