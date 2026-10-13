import { Animation, AnimationGroup, NullEngine, Scene, TransformNode, VertexBuffer } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyAnimStateToScene,
  applySpriteAnimFrame,
  applySpriteAnimationAssetFrame,
  resolvePlaySpriteSlot,
  sceneAnimHostFromBinding,
  seekGameplayAnimation,
} from "./anim-apply";
import {
  applyAssignMesh,
  applySnapshotToScene,
  createSnapshotSceneBinding,
  disposeSnapshotBinding,
} from "./snapshot-apply";
import { createSpriteQuad } from "./sprite-quad";
import {
  spriteFrameUvs,
  type SpriteAnimationPayload,
  type SpritePayload,
} from "@babylonslate/assets";

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
        getAnimationGroups: (slotId) => slotId === 0 ? [
          {
            name: "Idle",
            from: 0,
            to: 20,
            pause() {},
            goToFrame(frame) {
              frames.push(frame);
            },
          },
        ] : [],
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

  it("bakes sprite clip UVs from animState instead of skipping sprite clips", () => {
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
    const engine = new NullEngine({
      renderWidth: 64,
      renderHeight: 64,
      textureSize: 4,
      deterministicLockstep: false,
      lockstepMaxSteps: 1,
    });
    const scene = new Scene(engine);
    const mesh = createSpriteQuad(scene, "hero", payload.frames[0]!);
    applyAnimStateToScene(
      {
        getAnimationGroups: () => [],
        getSpriteSlot: (slotId) =>
          slotId === 3 ? { mesh, payload } : undefined,
      },
      {
        type: "animState",
        slotId: 3,
        stateId: "idle",
        normalisedTime: 0.8,
        blendWeights: { idle: 1 },
        clipName: "Idle",
        clipKind: "sprite",
      },
    );
    const uvs = mesh.getVerticesData(VertexBuffer.UVKind) ?? [];
    const expected = spriteFrameUvs(payload.frames[1]!);
    expect(uvs[0]).toBeCloseTo(expected.u0);
    expect(uvs[2]).toBeCloseTo(expected.u1);
    scene.dispose();
    engine.dispose();
  });

  it("binds a Sprite Animation frame texture and full UVs with its pivot on the actor origin", () => {
    const sprite: SpritePayload = {
      textureGuid: "sprite-tex",
      pixelsPerUnit: 100,
      frames: [
        {
          name: "a",
          u: 0,
          v: 0,
          uSize: 1,
          vSize: 1,
          durationMs: 100,
          pivot: { x: 0.5, y: 0.5 },
          width: 100,
          height: 100,
        },
      ],
      clips: [{ name: "Idle", frames: ["a"] }],
    };
    const animation: SpriteAnimationPayload = {
      frameDurationMs: 100,
      frames: [
        {
          textureGuid: "frame-a",
          durationMs: 100,
          pivot: { x: 0.5, y: 0.5 },
          collision: { x: 0, y: 0, width: 1, height: 1 },
          width: 100,
          height: 100,
        },
        {
          textureGuid: "frame-b",
          durationMs: 100,
          pivot: { x: 0, y: 1 },
          collision: { x: 0, y: 0, width: 1, height: 1 },
          width: 100,
          height: 100,
        },
      ],
    };
    const engine = new NullEngine({
      renderWidth: 64,
      renderHeight: 64,
      textureSize: 4,
      deterministicLockstep: false,
      lockstepMaxSteps: 1,
    });
    const scene = new Scene(engine);
    const mesh = createSpriteQuad(scene, "hero", sprite.frames[0]!);
    const textures: string[] = [];
    applyAnimStateToScene(
      {
        getAnimationGroups: () => [],
        getSpriteSlot: (slotId) =>
          slotId === 3
            ? {
                mesh,
                payload: sprite,
                spriteAnimations: new Map([["walk-anim", animation]]),
                applyTexture: (target, guid) => {
                  if (target === mesh && guid) textures.push(guid);
                },
              }
            : undefined,
      },
      {
        type: "animState",
        slotId: 3,
        stateId: "walk",
        normalisedTime: 0.8,
        blendWeights: { walk: 1 },
        clipName: "",
        clipKind: "sprite",
        clipAssetGuid: "walk-anim",
      },
    );
    const uvs = mesh.getVerticesData(VertexBuffer.UVKind) ?? [];
    expect(uvs[0]).toBeCloseTo(0);
    expect(uvs[2]).toBeCloseTo(1);
    expect(textures).toEqual(["frame-b"]);
    // Pivot (0, 1) is the bottom-left corner (v grows downward).
    mesh.refreshBoundingInfo();
    const bounds = mesh.getBoundingInfo().boundingBox;
    expect(bounds.minimum.x).toBeCloseTo(0);
    expect(bounds.minimum.y).toBeCloseTo(0);
    expect(bounds.maximum.x).toBeCloseTo(1);
    expect(bounds.maximum.y).toBeCloseTo(1);
    scene.dispose();
    engine.dispose();
  });

  it("moves a frozen scaled sprite's world bounds when only the frame pivot changes", () => {
    const frame = {
      textureGuid: "frame",
      durationMs: 100,
      collision: { x: 0, y: 0, width: 1, height: 1 },
      width: 100,
      height: 100,
    };
    const animation: SpriteAnimationPayload = {
      frameDurationMs: 100,
      frames: [
        { ...frame, pivot: { x: 0.5, y: 0.5 } },
        { ...frame, pivot: { x: 0, y: 1 } },
      ],
    };
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const mesh = createSpriteQuad(scene, "hero", {
      name: "a",
      u: 0,
      v: 0,
      uSize: 1,
      vSize: 1,
      durationMs: 100,
      pivot: { x: 0.5, y: 0.5 },
      width: 100,
      height: 100,
    });
    mesh.scaling.set(2, 2, 1);
    applySpriteAnimationAssetFrame(mesh, animation, 0);
    mesh.freezeWorldMatrix();
    expect(mesh.getBoundingInfo().boundingBox.minimumWorld.x).toBeCloseTo(-1);
    expect(mesh.getBoundingInfo().boundingBox.maximumWorld.y).toBeCloseTo(1);
    applySpriteAnimationAssetFrame(mesh, animation, 0.99);
    const bounds = mesh.getBoundingInfo().boundingBox;
    expect(bounds.minimumWorld.x).toBeCloseTo(0);
    expect(bounds.minimumWorld.y).toBeCloseTo(0);
    expect(bounds.maximumWorld.x).toBeCloseTo(2);
    expect(bounds.maximumWorld.y).toBeCloseTo(2);
    expect(mesh.isWorldMatrixFrozen).toBe(true);
    scene.dispose();
    engine.dispose();
  });

  it("sizes the sprite quad from Sprite Animation texture pixels", () => {
    const animation: SpriteAnimationPayload = {
      frameDurationMs: 100,
      frames: [
        {
          textureGuid: "frame-a",
          durationMs: 100,
          pivot: { x: 0.5, y: 0.5 },
          collision: { x: 0, y: 0, width: 1, height: 1 },
          width: 200,
          height: 100,
        },
      ],
    };
    const engine = new NullEngine({
      renderWidth: 64,
      renderHeight: 64,
      textureSize: 4,
      deterministicLockstep: false,
      lockstepMaxSteps: 1,
    });
    const scene = new Scene(engine);
    const mesh = createSpriteQuad(scene, "hero", {
      name: "a",
      u: 0,
      v: 0,
      uSize: 1,
      vSize: 1,
      durationMs: 100,
      pivot: { x: 0.5, y: 0.5 },
      width: 100,
      height: 100,
    });
    applySpriteAnimationAssetFrame(mesh, animation, 0, { pixelsPerUnit: 100 });
    mesh.refreshBoundingInfo();
    const size = mesh.getBoundingInfo().boundingBox.extendSize;
    expect(size.x).toBeCloseTo(1);
    expect(size.y).toBeCloseTo(0.5);
    scene.dispose();
    engine.dispose();
  });

  it("resolves a sprite slot from assignMesh guid plus snapshot mesh", () => {
    const payload: SpritePayload = {
      textureGuid: null,
      pixelsPerUnit: 100,
      frames: [
        {
          name: "a",
          u: 0,
          v: 0,
          uSize: 1,
          vSize: 1,
          durationMs: 100,
          pivot: { x: 0.5, y: 0.5 },
          width: 16,
          height: 16,
        },
      ],
      clips: [{ name: "Idle", frames: ["a"] }],
    };
    const engine = new NullEngine({
      renderWidth: 64,
      renderHeight: 64,
      textureSize: 4,
      deterministicLockstep: false,
      lockstepMaxSteps: 1,
    });
    const scene = new Scene(engine);
    const binding = createSnapshotSceneBinding();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 0,
      meshAssetGuid: "hero-sprite",
      meshKind: "sprite",
    });
    applySnapshotToScene(scene, binding, {
      frameId: 1,
      tickIndex: 1,
      actorCount: 1,
      actors: [
        {
          slotId: 0,
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          flags: 1,
        },
      ],
    });
    const slot = resolvePlaySpriteSlot(
      binding,
      new Map([["hero-sprite", payload]]),
      0,
    );
    expect(slot?.payload).toBe(payload);
    expect(slot?.mesh.name).toBe("actor-0");
    disposeSnapshotBinding(binding);
    scene.dispose();
    engine.dispose();
  });

  it("seeks every weighted animation layer on the matching slot and clip asset", () => {
    const idleFrames: number[] = [];
    const walkFrames: number[] = [];
    const idleWeights: number[] = [];
    const walkWeights: number[] = [];
    const missing: Array<{ slotId: number; clipName: string }> = [];
    applyAnimStateToScene(
      {
        getAnimationGroups: (slotId) => slotId !== 4 ? [] : [
          {
            name: "Idle",
            from: 0,
            to: 20,
            clipAssetGuid: "hero-model",
            pause() {},
            goToFrame(frame) {
              idleFrames.push(frame);
            },
            setWeightForAllAnimatables(weight) {
              idleWeights.push(weight);
            },
          },
          {
            name: "Walk",
            from: 0,
            to: 40,
            clipAssetGuid: "hero-model",
            pause() {},
            goToFrame(frame) {
              walkFrames.push(frame);
            },
            setWeightForAllAnimatables(weight) {
              walkWeights.push(weight);
            },
          },
        ],
        onMissingClip: (info) => {
          missing.push({ slotId: info.slotId, clipName: info.clipName });
        },
      },
      {
        type: "animState",
        slotId: 4,
        stateId: "walk",
        normalisedTime: 0.5,
        blendWeights: { idle: 0.25, walk: 0.75 },
        clipName: "Walk",
        clipKind: "animation",
        clipAssetGuid: "hero-model",
        layers: [
          {
            stateId: "idle",
            clipAssetGuid: "hero-model",
            clipName: "Idle",
            clipKind: "animation",
            normalisedTime: 0.25,
            weight: 0.25,
          },
          {
            stateId: "walk",
            clipAssetGuid: "hero-model",
            clipName: "Walk",
            clipKind: "animation",
            normalisedTime: 0.5,
            weight: 0.75,
          },
        ],
      },
    );
    expect(idleFrames).toEqual([5]);
    expect(walkFrames).toEqual([20]);
    expect(idleWeights).toEqual([0.25]);
    expect(walkWeights).toEqual([0.75]);
    expect(missing).toEqual([]);
  });

  it("resolves clips by name and clip asset in a slot with many groups, following group list changes", () => {
    const seeks: string[] = [];
    const group = (name: string, clipAssetGuid: string) => ({
      name,
      from: 0,
      to: 10,
      clipAssetGuid,
      pause() {},
      goToFrame() {
        seeks.push(`${clipAssetGuid}/${name}`);
      },
    });
    let groups = ["Idle", "Walk", "Run", "Jump", "Fall"].map((name) => group(name, "hero")).concat([group("Walk", "other"), group("Idle", "other")]);
    const missing: string[] = [];
    const host = {
      getAnimationGroups: () => groups,
      onMissingClip: (info: { clipName: string; clipAssetGuid?: string }) => {
        missing.push(`${info.clipAssetGuid ?? ""}/${info.clipName}`);
      },
    };
    const play = (clipName: string, clipAssetGuid?: string) =>
      applyAnimStateToScene(host, {
        type: "animState",
        slotId: 1,
        stateId: "s",
        normalisedTime: 0.5,
        blendWeights: { s: 1 },
        clipName,
        clipKind: "animation",
        ...(clipAssetGuid ? { clipAssetGuid } : {}),
      });
    // Without a clip asset the first group of that name wins; with one, its owner does.
    play("Walk");
    play("Walk", "other");
    play("Idle", "other");
    play("Walk", "unknown");
    play("Sprint");
    expect(seeks).toEqual(["hero/Walk", "other/Walk", "other/Idle"]);
    expect(missing).toEqual(["unknown/Walk", "/Sprint"]);
    // A clip added to the same list is found, and a replacement list shadows the old groups.
    seeks.length = 0;
    groups.push(group("Sprint", "hero"));
    play("Sprint");
    groups = ["Walk", "A", "B", "C", "D", "E"].map((name) => group(name, "next"));
    play("Walk");
    play("Idle");
    expect(seeks).toEqual(["hero/Sprint", "next/Walk"]);
    expect(missing).toEqual(["unknown/Walk", "/Sprint", "/Idle"]);
    // Replacing groups in place, keeping the length, is followed for hits and misses alike.
    seeks.length = 0;
    missing.length = 0;
    groups[0] = group("Walk", "swapped");
    play("Walk");
    groups[2] = group("Dash", "swapped");
    play("Dash");
    play("B");
    expect(seeks).toEqual(["swapped/Walk", "swapped/Dash"]);
    expect(missing).toEqual(["/B"]);
  });

  it("reports a missing animation clip instead of silently skipping it", () => {
    const missing: Array<{
      slotId: number;
      clipName: string;
      clipAssetGuid?: string;
    }> = [];
    applyAnimStateToScene(
      {
        getAnimationGroups: () => [],
        onMissingClip: (info) => {
          missing.push({
            slotId: info.slotId,
            clipName: info.clipName,
            clipAssetGuid: info.clipAssetGuid,
          });
        },
      },
      {
        type: "animState",
        slotId: 2,
        stateId: "idle",
        normalisedTime: 0,
        blendWeights: { idle: 1 },
        clipName: "MissingClip",
        clipKind: "animation",
        clipAssetGuid: "hero-model",
      },
    );
    expect(missing).toEqual([
      {
        slotId: 2,
        clipName: "MissingClip",
        clipAssetGuid: "hero-model",
      },
    ]);
  });

  it("crossfades two sprite layers onto the base mesh and overlay", () => {
    const idlePayload: SpritePayload = {
      textureGuid: null,
      pixelsPerUnit: 100,
      frames: [
        {
          name: "idle",
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
          name: "walk",
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
      clips: [
        { name: "Idle", frames: ["idle"] },
        { name: "Walk", frames: ["walk"] },
      ],
    };
    const engine = new NullEngine({
      renderWidth: 64,
      renderHeight: 64,
      textureSize: 4,
      deterministicLockstep: false,
      lockstepMaxSteps: 1,
    });
    const scene = new Scene(engine);
    const mesh = createSpriteQuad(scene, "hero", idlePayload.frames[0]!);
    const overlay = createSpriteQuad(scene, "hero-blend", idlePayload.frames[0]!);
    applyAnimStateToScene(
      {
        getAnimationGroups: () => [],
        getSpriteSlot: (slotId) =>
          slotId === 1
            ? { mesh, payload: idlePayload, overlayMesh: overlay }
            : undefined,
      },
      {
        type: "animState",
        slotId: 1,
        stateId: "walk",
        normalisedTime: 0,
        blendWeights: { idle: 0.4, walk: 0.6 },
        clipName: "Walk",
        clipKind: "sprite",
        layers: [
          {
            stateId: "idle",
            clipAssetGuid: "hero-sprite",
            clipName: "Idle",
            clipKind: "sprite",
            normalisedTime: 0,
            weight: 0.4,
          },
          {
            stateId: "walk",
            clipAssetGuid: "hero-sprite",
            clipName: "Walk",
            clipKind: "sprite",
            normalisedTime: 0,
            weight: 0.6,
          },
        ],
      },
    );
    const baseUvs = mesh.getVerticesData(VertexBuffer.UVKind) ?? [];
    const overlayUvs = overlay.getVerticesData(VertexBuffer.UVKind) ?? [];
    expect(baseUvs[0]).toBeCloseTo(spriteFrameUvs(idlePayload.frames[0]!).u0);
    expect(overlayUvs[0]).toBeCloseTo(spriteFrameUvs(idlePayload.frames[1]!).u0);
    expect(mesh.visibility).toBeCloseTo(0.4);
    expect(overlay.visibility).toBeCloseTo(0.6);
    scene.dispose();
    engine.dispose();
  });
});

describe("AnimationGraph pose changes", () => {
  let engine: NullEngine;
  let scene: Scene;

  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
  });

  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });

  it("seeks the visible pose inside an Animation clip with a nonzero first frame", () => {
    const target = new TransformNode("hero", scene);
    const animation = new Animation("Walk", "position.x", 30, Animation.ANIMATIONTYPE_FLOAT);
    animation.setKeys([{ frame: 30, value: 10 }, { frame: 60, value: 20 }]);
    const walk = new AnimationGroup("Walk", scene);
    walk.addTargetedAnimation(animation, target);
    walk.start(true);
    walk.pause();
    walk.setWeightForAllAnimatables(0);
    applyAnimStateToScene({ getAnimationGroups: () => [walk] }, {
      type: "animState",
      slotId: 1,
      stateId: "walk",
      normalisedTime: 0.5,
      blendWeights: { walk: 1 },
      clipName: "Walk",
      clipKind: "animation",
    });
    expect(target.position.x).toBeCloseTo(15);
    expect(walk.isPlaying).toBe(false);
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

  it("bakes the clip frame UVs, size and pivot for the given normalised time", () => {
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
          pivot: { x: 0, y: 1 },
          width: 32,
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
    // Frame b's bottom-left pivot sits on the actor origin, as its collider does.
    mesh.refreshBoundingInfo();
    const bounds = mesh.getBoundingInfo().boundingBox;
    expect(bounds.minimum.x).toBeCloseTo(0);
    expect(bounds.minimum.y).toBeCloseTo(0);
    expect(bounds.maximum.x).toBeCloseTo(0.32);
    expect(bounds.maximum.y).toBeCloseTo(0.16);
  });
});

describe("sceneAnimHostFromBinding", () => {
  it("resolves overlay sprites and per-slot animation groups from the binding", () => {
    const payload: SpritePayload = {
      textureGuid: null,
      pixelsPerUnit: 100,
      frames: [
        {
          name: "a",
          u: 0,
          v: 0,
          uSize: 1,
          vSize: 1,
          durationMs: 100,
          pivot: { x: 0.5, y: 0.5 },
          width: 16,
          height: 16,
        },
      ],
      clips: [{ name: "Idle", frames: ["a"] }],
    };
    const engine = new NullEngine({
      renderWidth: 64,
      renderHeight: 64,
      textureSize: 4,
      deterministicLockstep: false,
      lockstepMaxSteps: 1,
    });
    const scene = new Scene(engine);
    const binding = createSnapshotSceneBinding();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 0,
      meshAssetGuid: "hero-sprite",
      meshKind: "sprite",
    });
    applySnapshotToScene(scene, binding, {
      frameId: 1,
      tickIndex: 1,
      actorCount: 1,
      actors: [
        {
          slotId: 0,
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          flags: 1,
        },
      ],
    });
    const overlay = createSpriteQuad(scene, "hero-overlay", payload.frames[0]!);
    binding.spriteOverlays = new Map([[0, overlay]]);
    const frames: number[] = [];
    binding.slotAnimationGroups = new Map([
      [
        7,
        [
          {
            name: "Idle",
            from: 0,
            to: 10,
            clipAssetGuid: "hero-model",
            pause() {},
            goToFrame(frame) {
              frames.push(frame);
            },
          },
        ],
      ],
    ]);
    const host = sceneAnimHostFromBinding(binding, {
      spritePayloads: new Map([["hero-sprite", payload]]),
    });
    expect(host.getSpriteSlot?.(0)?.overlayMesh).toBe(overlay);
    applyAnimStateToScene(host, {
      type: "animState",
      slotId: 7,
      stateId: "idle",
      normalisedTime: 0.5,
      blendWeights: { idle: 1 },
      clipName: "Idle",
      clipKind: "animation",
      clipAssetGuid: "hero-model",
    });
    expect(frames).toEqual([5]);
    disposeSnapshotBinding(binding);
    expect(overlay.isDisposed()).toBe(true);
    scene.dispose();
    engine.dispose();
  });

  it("seeks Idle only on the slot whose Model guid matches", () => {
    const aFrames: number[] = [];
    const bFrames: number[] = [];
    const binding = createSnapshotSceneBinding();
    binding.slotAnimationGroups = new Map([
      [
        1,
        [
          {
            name: "Idle",
            from: 0,
            to: 10,
            clipAssetGuid: "model-a",
            pause() {},
            goToFrame(frame) {
              aFrames.push(frame);
            },
          },
        ],
      ],
      [
        2,
        [
          {
            name: "Idle",
            from: 0,
            to: 10,
            pause() {},
            goToFrame() {
              bFrames.push(-1);
            },
          },
          {
            name: "Idle",
            from: 0,
            to: 10,
            clipAssetGuid: "model-b",
            pause() {},
            goToFrame(frame) {
              bFrames.push(frame);
            },
          },
        ],
      ],
    ]);
    const host = sceneAnimHostFromBinding(binding);
    applyAnimStateToScene(host, {
      type: "animState",
      slotId: 2,
      stateId: "idle",
      normalisedTime: 0.4,
      blendWeights: { idle: 1 },
      clipName: "Idle",
      clipKind: "animation",
      clipAssetGuid: "model-b",
    });
    applyAnimStateToScene(host, {
      type: "animState",
      slotId: 1,
      stateId: "idle",
      normalisedTime: 0.8,
      blendWeights: { idle: 1 },
      clipName: "Idle",
      clipKind: "animation",
      clipAssetGuid: "model-a",
    });
    // A slot whose Model has not registered Idle never borrows another actor's group.
    applyAnimStateToScene(host, {
      type: "animState",
      slotId: 3,
      stateId: "idle",
      normalisedTime: 0.2,
      blendWeights: { idle: 1 },
      clipName: "Idle",
      clipKind: "animation",
      clipAssetGuid: "",
    });
    expect(aFrames).toEqual([8]);
    expect(bFrames).toEqual([4]);
    disposeSnapshotBinding(binding);
  });
});
