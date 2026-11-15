import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@haptic/core";
import {
  ANIM_FRAME_SLOT_TYPE,
  ANIM_POSE_OUTPUT_NODE_ID,
  ANIM_POSE_SEQUENCE_PLAYER_TYPE,
  ANIM_POSE_SLOT_TYPE,
  createDefaultAnimGraph,
  evaluateAnimGraph,
  primaryPosePlayer,
  type AnimEvalState,
  type AnimGraphDocument,
  type AnimSlotClip,
  type AnimSlotRequest,
} from "./index";

type Node = SerializedGraph["nodes"][number];

const node = (id: string, type: string, data: Record<string, unknown> = {}): Node => ({ id, type, position: { x: 0, y: 0 }, data });
const wire = (source: string, target: string, targetHandle: string) => ({
  id: `${source}->${target}:${targetHandle}`, source, sourceHandle: "pose", target, targetHandle,
});

/** Idle playing into a Slot named `slotName`, into the output. */
function slotted(slotName?: string, dimension: "3d" | "2d" = "3d"): AnimGraphDocument {
  const frame = dimension === "2d";
  const stateGraph: SerializedGraph = {
    nodes: [
      node("idle", frame ? "anim.frame.spritePlayer" : ANIM_POSE_SEQUENCE_PLAYER_TYPE, { assetGuid: "idle", clipName: frame ? "" : "idle", durationMs: 1000, loop: true }),
      node("slot", frame ? ANIM_FRAME_SLOT_TYPE : ANIM_POSE_SLOT_TYPE, slotName ? { slotName } : {}),
      node(ANIM_POSE_OUTPUT_NODE_ID, frame ? "anim.frame.output" : "anim.pose.output", { __protected: true }),
    ],
    edges: [wire("idle", "slot", "source"), wire("slot", ANIM_POSE_OUTPUT_NODE_ID, frame ? "frame" : "pose")],
  };
  return {
    ...createDefaultAnimGraph("Slots", { dimension }),
    stateMachine: { entryStateId: "main", states: [{ id: "main", name: "Main", position: { x: 0, y: 0 }, stateGraph }], transitions: [] },
  };
}

const swing: AnimSlotClip = {
  assetGuid: "swing", clipName: "swing", clipKind: "animation", durationMs: 1000,
  events: [{ name: "Hit", timeMs: 500, durationMs: 0, triggerWeight: 0.5, action: null }],
};

const play = (id: number, extra: Partial<Extract<AnimSlotRequest, { kind: "play" }>> = {}): AnimSlotRequest => ({
  kind: "play", id, slot: "DefaultSlot", clip: swing, blendInSeconds: 0.2, blendOutSeconds: 0.2, playRate: 1, loopCount: 1, startSeconds: 0, ...extra,
});

const weights = (state: AnimEvalState) => Object.fromEntries(state.layers.map((layer) => [layer.clipAssetGuid, Number(layer.weight.toFixed(6))]));

/** Runs `ticks` 0.1 s evaluations, the first one with `requests`, collecting every slot event and fired event. */
function run(doc: AnimGraphDocument, requests: AnimSlotRequest[], ticks: number, start: AnimEvalState | null = null) {
  let state = start ?? evaluateAnimGraph(doc, null, 0, {});
  const slotEvents: string[] = [];
  const fired: string[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    state = evaluateAnimGraph(doc, state, 0.1, tick === 0 ? { slotRequests: requests } : {});
    for (const event of state.slotEvents ?? []) slotEvents.push(`${tick}:${event.id}:${event.phase}`);
    for (const event of state.events ?? []) fired.push(`${tick}:${event.name}`);
  }
  return { state, slotEvents, fired };
}

describe("Slots", () => {
  it("blend a slot animation in over the Source, which keeps the state's time", () => {
    const doc = slotted();
    const { state } = run(doc, [play(1)], 1);
    expect(weights(state)).toEqual({ idle: 0.5, swing: 0.5 });
    expect(state.slots?.DefaultSlot?.active).toMatchObject({ id: 1, weight: 0.5 });
    expect(primaryPosePlayer(doc.stateMachine.states[0]!.stateGraph)?.id).toBe("idle");
  });

  it("blend out by themselves before the end, then complete, firing their clip events once", () => {
    const { state, slotEvents, fired } = run(slotted(), [play(1)], 12);
    // Blend Out 0.2 s before the 1 s clip ends; Completed when it has.
    expect(slotEvents).toEqual(["7:1:blendOut", "9:1:completed"]);
    expect(fired).toEqual(["4:Hit"]);
    expect(state.slots).toBeUndefined();
    expect(weights(state)).toEqual({ idle: 1 });
  });

  it("stop with a blend out and report the play interrupted", () => {
    const doc = slotted();
    const started = run(doc, [play(1)], 3).state;
    const { slotEvents, state } = run(doc, [{ kind: "stop", slot: "DefaultSlot", blendOutSeconds: 0.2 }], 3, started);
    expect(slotEvents).toEqual(["0:1:blendOut", "1:1:interrupted"]);
    expect(state.slots).toBeUndefined();
  });

  it("blend a replaced play out under the new one, which interrupts it", () => {
    const doc = slotted();
    const started = run(doc, [play(1)], 3).state;
    const replaced = run(doc, [play(2, { clip: { ...swing, assetGuid: "kick", clipName: "kick" } })], 1, started);
    expect(replaced.slotEvents).toEqual(["0:1:blendOut"]);
    expect(weights(replaced.state)).toEqual({ swing: 0.5, kick: 0.5 });
    const after = run(doc, [], 2, replaced.state);
    expect(after.slotEvents).toEqual(["0:1:interrupted"]);
  });

  it("loop until stopped with Loop Count 0, and play on a named slot only", () => {
    const { slotEvents, state } = run(slotted("UpperBody"), [play(1, { loopCount: 0, slot: "UpperBody" })], 30);
    expect(slotEvents).toEqual([]);
    expect(weights(state)).toEqual({ swing: 1 });
    const other = run(slotted("UpperBody"), [play(2)], 3).state;
    // The default slot plays, but this graph shows no Slot of that name.
    expect(weights(other)).toEqual({ idle: 1 });
    expect(other.slots?.DefaultSlot?.active?.id).toBe(2);
  });

  it("show a 2D slot's frame alone while it has any weight", () => {
    const sprite: AnimSlotClip = { assetGuid: "hurt", clipName: "", clipKind: "sprite", durationMs: 600 };
    const { state } = run(slotted(undefined, "2d"), [play(1, { clip: sprite })], 1);
    expect(state.layers.map((layer) => [layer.clipAssetGuid, layer.weight, layer.clipKind])).toEqual([["hurt", 1, "sprite"]]);
  });
});
