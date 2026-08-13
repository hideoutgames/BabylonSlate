import { NullEngine, Scene, VertexBuffer } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyAnimStateToScene,
  applySpriteAnimFrame,
  seekGameplayAnimation,
} from "./anim-apply";
import { createSpriteQuad } from "./sprite-quad";
import { spriteFrameUvs, type SpritePayload } from "@babylonslate/assets";

describe("seekGameplayAnimation", () => {
  it("pauses the group and seeks a normalised frame instead of auto-advancing", () => {
    const calls: string[] = [];
    const group = {
      pause() {
        calls.push("pause");
      },
      goToFrame(frame: number) {
        calls.push(`frame:${frame}`);
      },
      setWeightForAllAnimatables(weight: number) {
        calls.push(`weight:${weight}`);
      },
    };
    seekGameplayAnimation(group, 0.5, 30, 0.8);
    expect(calls).toEqual(["pause", "frame:15", "weight:0.8"]);
  });

  it("looks up a named AnimationGroup from an animState command", () => {
    const frames: number[] = [];
    applyAnimStateToScene(
      {
        animationGroups: [
          {
            name: "Idle",
            from: 0,
            to: 20,
            pause() {},
            goToFrame(frame) {
              frames.push(frame);
            },
          },
        ],
      },
      {
        type: "animState",
        slotId: 0,
        stateId: "idle",
        normalisedTime: 0.25,
        blendWeights: { idle: 1 },
        clipName: "Idle",
        clipKind: "animation",
      },
    );
    expect(frames).toEqual([5]);
  });
});

describe("applySpriteAnimFrame", () => {
  let engine: NullEngine;
  let scene: Scene;

  beforeEach(() => {
    engine = new NullEngine({
      renderWidth: 64,
      renderHeight: 64,
      textureSize: 4,
      deterministicLockstep: false,
      lockstepMaxSteps: 1,
    });
    scene = new Scene(engine);
  });

  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });

  it("bakes the clip frame UVs for the given normalised time", () => {
    const payload: SpritePayload = {
      textureGuid: null,
      pixelsPerUnit: 100,
      frames: [
        {
          name: "a",
          u: 0,
          v: 0,
          uSize: 0.5,
          vSize: 1,
          durationMs: 100,
          pivot: { x: 0.5, y: 0.5 },
          width: 16,
          height: 16,
        },
        {
          name: "b",
          u: 0.5,
          v: 0,
          uSize: 0.5,
          vSize: 1,
          durationMs: 100,
          pivot: { x: 0.5, y: 0.5 },
          width: 16,
          height: 16,
        },
      ],
      clips: [{ name: "Idle", frames: ["a", "b"] }],
    };
    const mesh = createSpriteQuad(scene, "hero", payload.frames[0]!);
    applySpriteAnimFrame(mesh, payload, "Idle", 0.8);
    const uvs = mesh.getVerticesData(VertexBuffer.UVKind) ?? [];
    const expected = spriteFrameUvs(payload.frames[1]!);
    expect(uvs[0]).toBeCloseTo(expected.u0);
    expect(uvs[2]).toBeCloseTo(expected.u1);
  });
});
