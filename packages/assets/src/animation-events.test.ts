import { describe, expect, it } from "vitest";
import { animationAssetGuids, normalizeAnimationPayload } from "./animation-payload";
import { normalizeAnimationEvents, normalizeSpriteAnimationFrameEvents, nextAnimationEventId } from "./animation-events";
import { parseSpriteAnimationPayload, spriteAnimationDependencyGuids } from "./sprite-animation-payload";

describe("Animation Events on an Animation", () => {
  it("keeps each event's settings, sorted by time, with Trigger Weight 0.5 when none is stored", () => {
    expect(
      normalizeAnimationEvents([
        { id: "b", name: " Footstep_R ", timeMs: 500 },
        { id: "a", name: "Hit", timeMs: 200, durationMs: 150, triggerWeight: 2, action: { kind: "spawnParticles", assetGuid: "sparks", bone: "hand_r" } },
        { id: "c", name: "Footstep_L", timeMs: -5, action: { kind: "playSound", assetGuid: "step", volume: 0.8 } },
      ]),
    ).toEqual([
      { id: "c", name: "Footstep_L", timeMs: 0, durationMs: 0, triggerWeight: 0.5, action: { kind: "playSound", assetGuid: "step", volume: 0.8 } },
      { id: "a", name: "Hit", timeMs: 200, durationMs: 150, triggerWeight: 1, action: { kind: "spawnParticles", assetGuid: "sparks", bone: "hand_r" } },
      { id: "b", name: "Footstep_R", timeMs: 500, durationMs: 0, triggerWeight: 0.5, action: null },
    ]);
  });

  it("gives events without an id, or with a repeated one, ids of their own", () => {
    const ids = normalizeAnimationEvents([{ name: "A", timeMs: 1 }, { id: "x", name: "B", timeMs: 2 }, { id: "x", name: "C", timeMs: 3 }]).map((event) => event.id);
    expect(new Set(ids).size).toBe(3);
    expect(nextAnimationEventId([{ id: "event-1" }, { id: "event-2" }])).toBe("event-3");
  });

  it("stores events on the payload only when there are some, and loads what they act with", () => {
    expect(normalizeAnimationPayload({ clipName: "Walk", events: [] }).events).toBeUndefined();
    const payload = normalizeAnimationPayload({
      clipName: "Walk",
      skeletonGuid: "rig",
      events: [{ id: "e", name: "Footstep", timeMs: 100, action: { kind: "playSound", assetGuid: "step", volume: 1 } }],
    });
    expect(payload.events).toHaveLength(1);
    expect(animationAssetGuids(payload)).toEqual(["rig", "step"]);
  });
});

describe("Animation Events on Sprite Animation frames", () => {
  it("keeps a frame's events and loads what they act with", () => {
    expect(normalizeSpriteAnimationFrameEvents([{ name: "Step", triggerWeight: -1 }])).toEqual([
      { id: "event-1", name: "Step", triggerWeight: 0, action: null },
    ]);
    const payload = parseSpriteAnimationPayload({
      frameDurationMs: 100,
      source: "frames",
      frames: [
        { textureGuid: "t1", durationMs: 100 },
        { textureGuid: "t2", durationMs: 100, events: [{ id: "e", name: "Step", action: { kind: "playSound", assetGuid: "step", volume: 1 } }] },
      ],
    });
    expect(payload.frames[0]!.events).toBeUndefined();
    expect(payload.frames[1]!.events).toEqual([{ id: "e", name: "Step", triggerWeight: 0.5, action: { kind: "playSound", assetGuid: "step", volume: 1 } }]);
    expect(spriteAnimationDependencyGuids(payload)).toEqual(["t1", "t2", "step"]);
  });
});
