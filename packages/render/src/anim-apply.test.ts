import { Animation } from "@babylonjs/core/Animations/animation";
import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyAnimStateToScene,
  applySpriteAnimationAssetFrame,
  onceMissingClip,
  resolvePlaySpriteSlot,
  sceneAnimHostFromBinding,
} from "./anim-apply";
import { bindPoseClip, type PoseClip, type PoseTrackSource } from "./anim-pose";
import {
  applyAssignMesh,
  applySnapshotToScene,
  createSnapshotSceneBinding,
  disposeSnapshotBinding,
} from "./snapshot-apply";
import { createSpriteQuad } from "./sprite-quad";
import { createDefaultSpriteAnimationSheet, type SpriteAnimationPayload, type SpritePayload } from "@haptic/assets";
import { animBranchFilterKey } from "@haptic/core";

/** A float channel whose value is its frame, so a clip's target shows the frame it was posed at. */
const FRAME_TRACK: PoseTrackSource = {
  dataType: Animation.ANIMATIONTYPE_FLOAT,
  targetPropertyPath: ["value"],
  getKeys: () => [{ frame: 0, value: 0 }, { frame: 1000, value: 1000 }],
};

/** A clip whose one channel writes the frame it plays to `target.value` (resting at 0). */
function frameClip(
  name: string,
  to: number,
  clipAssetGuid?: string,
  target: { value: number } = { value: 0 },
): PoseClip & { target: { value: number } } {
  return bindPoseClip({ name, from: 0, to, targetedAnimations: [{ animation: FRAME_TRACK, target }] }, clipAssetGuid, { target });
}

/** A clip target that logs `label` whenever a clip poses it off rest. */
function loggingTarget(log: string[], label: string): { value: number } {
  return {
    get value() { return 0; },
    set value(frame: number) { if (frame !== 0) log.push(label); },
  };
}

describe("applyAnimStateToScene", () => {
  it("poses a named clip from an animState command", () => {
    const idle = frameClip("Idle", 20);
    applyAnimStateToScene(
      { getPoseClips: (slotId) => (slotId === 0 ? [idle] : []) },
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
    expect(idle.target.value).toBe(5);
  });

  it("reports a sprite clip that names no loaded Sprite Animation and leaves the quad as it is", () => {
    const payload: SpritePayload = {
      textureGuid: "hero-tex",
      pixelsPerUnit: 100,
      pivot: { x: 0.5, y: 0.5 },
      collision: { x: 0, y: 0, width: 1, height: 1 },
      width: 16,
      height: 16,
    };
    const engine = new NullEngine({
      renderWidth: 64,
      renderHeight: 64,
      textureSize: 4,
      deterministicLockstep: false,
      lockstepMaxSteps: 1,
    });
    const scene = new Scene(engine);
    const mesh = createSpriteQuad(scene, "hero", payload);
    const overlay = createSpriteQuad(scene, "hero-blend", payload);
    overlay.visibility = 0.5;
    const before = [...(mesh.getVerticesData(VertexBuffer.PositionKind) ?? [])];
    const missing: string[] = [];
    const textures: string[] = [];
    applyAnimStateToScene(
      {
        getPoseClips: () => [],
        getSpriteSlot: (slotId) =>
          slotId === 3
            ? { mesh, payload, overlayMesh: overlay, spriteAnimations: new Map(), applyTexture: (_target, guid) => { if (guid) textures.push(guid); } }
            : undefined,
        onMissingClip: (info) => missing.push(`${info.slotId}/${info.clipKind}/${info.clipAssetGuid ?? ""}`),
      },
      {
        type: "animState",
        slotId: 3,
        stateId: "idle",
        normalisedTime: 0.8,
        blendWeights: { idle: 1 },
        clipName: "Idle",
        clipKind: "sprite",
        clipAssetGuid: "hero-sprite",
      },
    );
    expect(missing).toEqual(["3/sprite/hero-sprite"]);
    expect(textures).toEqual([]);
    expect([...(mesh.getVerticesData(VertexBuffer.PositionKind) ?? [])]).toEqual(before);
    scene.dispose();
    engine.dispose();
  });

  it("binds a Sprite Animation frame texture and full UVs with its pivot on the actor origin", () => {
    const sprite: SpritePayload = {
      textureGuid: "sprite-tex",
      pixelsPerUnit: 100,
      pivot: { x: 0.5, y: 0.5 },
      collision: { x: 0, y: 0, width: 1, height: 1 },
      width: 100,
      height: 100,
    };
    const animation: SpriteAnimationPayload = {
      frameDurationMs: 100,
      source: "frames",
      sheet: createDefaultSpriteAnimationSheet(),
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
    const mesh = createSpriteQuad(scene, "hero", sprite);
    const textures: string[] = [];
    applyAnimStateToScene(
      {
        getPoseClips: () => [],
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
      source: "frames",
      sheet: createDefaultSpriteAnimationSheet(),
      frames: [
        { ...frame, pivot: { x: 0.5, y: 0.5 } },
        { ...frame, pivot: { x: 0, y: 1 } },
      ],
    };
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const mesh = createSpriteQuad(scene, "hero", { pivot: { x: 0.5, y: 0.5 }, width: 100, height: 100 });
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

  it("shows a sheet cell's UVs, then the whole texture again for a plain frame", () => {
    const cell = {
      textureGuid: "sheet",
      durationMs: 100,
      pivot: { x: 0.5, y: 0.5 },
      collision: { x: 0, y: 0, width: 1, height: 1 },
      width: 16,
      height: 16,
    };
    const sheet: SpriteAnimationPayload = {
      frameDurationMs: 100,
      source: "sheet",
      sheet: { ...createDefaultSpriteAnimationSheet(), textureGuid: "sheet" },
      frames: [{ ...cell, cell: 2, uv: { u0: 0.5, v0: 0.5, u1: 1, v1: 1 } }],
    };
    const plain: SpriteAnimationPayload = { ...sheet, source: "frames", frames: [{ ...cell, textureGuid: "plain" }] };
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const mesh = createSpriteQuad(scene, "hero", { pivot: { x: 0.5, y: 0.5 }, width: 16, height: 16 });
    applySpriteAnimationAssetFrame(mesh, sheet, 0);
    // Bottom-left, bottom-right, top-right, top-left.
    expect([...(mesh.getVerticesData(VertexBuffer.UVKind) ?? [])]).toEqual([0.5, 0.5, 1, 0.5, 1, 1, 0.5, 1]);
    applySpriteAnimationAssetFrame(mesh, plain, 0);
    expect([...(mesh.getVerticesData(VertexBuffer.UVKind) ?? [])]).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
    scene.dispose();
    engine.dispose();
  });

  it("mirrors a flipped frame's UVs about its pivot", () => {
    const sheet: SpriteAnimationPayload = {
      frameDurationMs: 100,
      source: "sheet",
      sheet: { ...createDefaultSpriteAnimationSheet(), textureGuid: "sheet" },
      frames: [{
        textureGuid: "sheet",
        durationMs: 100,
        pivot: { x: 0.25, y: 0.5 },
        collision: { x: 0, y: 0, width: 1, height: 1 },
        width: 100,
        height: 100,
        cell: 2,
        uv: { u0: 0.5, v0: 0.5, u1: 1, v1: 1 },
      }],
    };
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const mesh = createSpriteQuad(scene, "hero", { pivot: { x: 0.5, y: 0.5 }, width: 100, height: 100 });
    applySpriteAnimationAssetFrame(mesh, sheet, 0, { flipX: true });
    expect([...(mesh.getVerticesData(VertexBuffer.UVKind) ?? [])]).toEqual([1, 0.5, 0.5, 0.5, 0.5, 1, 1, 1]);
    // The pivot sits a quarter in from the right edge instead of the left.
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind) ?? [];
    expect([positions[0], positions[3]]).toEqual([-0.75, 0.25]);
    scene.dispose();
    engine.dispose();
  });

  it("sizes the sprite quad from Sprite Animation texture pixels", () => {
    const animation: SpriteAnimationPayload = {
      frameDurationMs: 100,
      source: "frames",
      sheet: createDefaultSpriteAnimationSheet(),
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
    const mesh = createSpriteQuad(scene, "hero", { pivot: { x: 0.5, y: 0.5 }, width: 100, height: 100 });
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
      pivot: { x: 0.5, y: 0.5 },
      collision: { x: 0, y: 0, width: 1, height: 1 },
      width: 16,
      height: 16,
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

  it("blends every weighted animation layer on the matching slot and clip asset", () => {
    const pose = { value: 0 };
    const idle = frameClip("Idle", 20, "hero-model", pose);
    const walk = frameClip("Walk", 40, "hero-model", pose);
    const missing: Array<{ slotId: number; clipName: string }> = [];
    applyAnimStateToScene(
      {
        getPoseClips: (slotId) => (slotId !== 4 ? [] : [idle, walk]),
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
    // Idle at frame 5, Walk at frame 20, by weight.
    expect(pose.value).toBeCloseTo(0.25 * 5 + 0.75 * 20);
    expect(missing).toEqual([]);
  });

  it("passes Layered Blend masks through, playing one clip apart under each input", () => {
    // The target is a bone named "spine", under the blend input's branch.
    const spine = { value: 0, name: "spine" };
    const swing = frameClip("Swing", 40, "hero-model", spine);
    const layer = (normalisedTime: number, weight: number, input: number) => ({
      stateId: "attack", clipAssetGuid: "hero-model", clipName: "Swing", clipKind: "animation" as const,
      normalisedTime, weight, masks: [{ blend: 0, input }],
    });
    applyAnimStateToScene(
      { getPoseClips: () => [swing] },
      {
        type: "animState", slotId: 1, stateId: "attack", normalisedTime: 0, blendWeights: { attack: 1 },
        layers: [layer(0.25, 1, -1), layer(0.5, 1, 0)],
        layerBlends: [{ filters: [animBranchFilterKey([{ bone: "spine", blendDepth: 0 }])], weights: [1] }],
      },
    );
    // The blend input's Swing (frame 20) holds the spine; the base's (frame 10) gets none of it.
    expect(spine.value).toBeCloseTo(20);
  });

  it("resolves clips by name and clip asset in a slot with many clips, following clip list changes", () => {
    const seeks: string[] = [];
    const clip = (name: string, clipAssetGuid: string) =>
      frameClip(name, 10, clipAssetGuid, loggingTarget(seeks, `${clipAssetGuid}/${name}`));
    let clips = ["Idle", "Walk", "Run", "Jump", "Fall"].map((name) => clip(name, "hero")).concat([clip("Walk", "other"), clip("Idle", "other")]);
    const missing: string[] = [];
    const host = {
      getPoseClips: () => clips,
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
    // Without a clip asset the first clip of that name wins; with one, its owner does.
    play("Walk");
    play("Walk", "other");
    play("Idle", "other");
    play("Walk", "unknown");
    play("Sprint");
    expect(seeks).toEqual(["hero/Walk", "other/Walk", "other/Idle"]);
    expect(missing).toEqual(["unknown/Walk", "/Sprint"]);
    // A clip added to the same list is found, and a replacement list shadows the old clips.
    seeks.length = 0;
    clips.push(clip("Sprint", "hero"));
    play("Sprint");
    clips = ["Walk", "A", "B", "C", "D", "E"].map((name) => clip(name, "next"));
    play("Walk");
    play("Idle");
    expect(seeks).toEqual(["hero/Sprint", "next/Walk"]);
    expect(missing).toEqual(["unknown/Walk", "/Sprint", "/Idle"]);
    // Replacing clips in place, keeping the length, is followed for hits and misses alike.
    seeks.length = 0;
    missing.length = 0;
    clips[0] = clip("Walk", "swapped");
    play("Walk");
    clips[2] = clip("Dash", "swapped");
    play("Dash");
    play("B");
    expect(seeks).toEqual(["swapped/Walk", "swapped/Dash"]);
    expect(missing).toEqual(["/B"]);
  });

  it("finds a clip by name and clip asset without reading the other clips of that name", () => {
    let reads = 0;
    const sought: string[] = [];
    // Fifty actors' Idle clips in one list, as a crowd's shared slot list holds them.
    const clips: PoseClip[] = Array.from({ length: 50 }, (_, index) => {
      const bound = frameClip("Idle", 10, undefined, loggingTarget(sought, `actor-${index}`));
      return {
        name: bound.name, from: bound.from, to: bound.to, channels: bound.channels, keyHints: bound.keyHints,
        get clipAssetGuid() { reads++; return `actor-${index}`; },
      };
    });
    const play = (clipAssetGuid: string) => applyAnimStateToScene({ getPoseClips: () => clips }, {
      type: "animState", slotId: 1, stateId: "s", normalisedTime: 0.5, blendWeights: { s: 1 },
      clipName: "Idle", clipKind: "animation", clipAssetGuid,
    });
    play("actor-0");
    reads = 0;
    play("actor-49");
    expect(sought).toEqual(["actor-0", "actor-49"]);
    // The hit's own guid, confirmed once: no scan of the 49 other Idle clips.
    expect(reads).toBeLessThanOrEqual(2);
  });

  it("reports a missing animation clip instead of silently skipping it", () => {
    const missing: Array<{
      slotId: number;
      clipName: string;
      clipAssetGuid?: string;
    }> = [];
    applyAnimStateToScene(
      {
        getPoseClips: () => [],
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

  it("treats a state with no clip as playing nothing, not as a missing clip, and rests the slot's clips", () => {
    const missing: string[] = [];
    const walk = frameClip("Walk", 10);
    const host = {
      getPoseClips: () => [walk],
      onMissingClip: (info: { clipName: string }) => {
        missing.push(info.clipName);
      },
    };
    const play = (clipName: string, clipAssetGuid: string) =>
      applyAnimStateToScene(host, {
        type: "animState",
        slotId: 1,
        stateId: "s",
        normalisedTime: 0.5,
        blendWeights: { s: 1 },
        clipName,
        clipKind: "animation",
        layers: [{ stateId: "s", clipName, clipAssetGuid, clipKind: "animation", normalisedTime: 0.5, weight: 1 }],
      });

    play("Walk", "");
    expect(walk.target.value).toBe(5);
    play("", "");
    expect(missing).toEqual([]);
    expect(walk.target.value).toBe(0);

    // A clip that is named but absent is still reported, with or without its asset.
    play("Run", "");
    play("", "hero-model");
    expect(missing).toEqual(["Run", ""]);
  });

  it("passes each missing clip on once per slot and clip", () => {
    const reported: string[] = [];
    const once = onceMissingClip((info) => {
      reported.push(`${info.slotId}/${info.clipKind}/${info.clipAssetGuid ?? ""}/${info.clipName}`);
    });
    const miss = (slotId: number, clipName: string, clipAssetGuid?: string) =>
      once({ slotId, clipName, clipAssetGuid, clipKind: "animation" });

    for (let frame = 0; frame < 3; frame += 1) miss(1, "Run");
    miss(1, "Run", "hero-model");
    miss(2, "Run");
    miss(1, "Jump");
    miss(1, "Run");

    expect(reported).toEqual(["1/animation//Run", "1/animation/hero-model/Run", "2/animation//Run", "1/animation//Jump"]);
  });

  it("crossfades two Sprite Animation layers onto the base mesh and overlay, hiding the overlay when its clip is missing", () => {
    const frame = (textureGuid: string) => ({
      textureGuid,
      durationMs: 100,
      pivot: { x: 0.5, y: 0.5 },
      collision: { x: 0, y: 0, width: 1, height: 1 },
      width: 16,
      height: 16,
    });
    const payload: SpritePayload = {
      textureGuid: "hero-tex",
      pixelsPerUnit: 100,
      pivot: { x: 0.5, y: 0.5 },
      collision: { x: 0, y: 0, width: 1, height: 1 },
      width: 16,
      height: 16,
    };
    const animations = new Map<string, SpriteAnimationPayload>([
      ["idle-anim", { frameDurationMs: 100, source: "frames", sheet: createDefaultSpriteAnimationSheet(), frames: [frame("idle-tex")] }],
      ["walk-anim", { frameDurationMs: 100, source: "frames", sheet: createDefaultSpriteAnimationSheet(), frames: [frame("walk-tex")] }],
    ]);
    const engine = new NullEngine({
      renderWidth: 64,
      renderHeight: 64,
      textureSize: 4,
      deterministicLockstep: false,
      lockstepMaxSteps: 1,
    });
    const scene = new Scene(engine);
    const mesh = createSpriteQuad(scene, "hero", payload);
    const overlay = createSpriteQuad(scene, "hero-blend", payload);
    const bound = new Map<unknown, string>();
    const host = {
      getPoseClips: () => [],
      getSpriteSlot: (slotId: number) =>
        slotId === 1
          ? {
              mesh,
              payload,
              overlayMesh: overlay,
              spriteAnimations: animations,
              applyTexture: (target: unknown, guid: string | null | undefined) => { if (guid) bound.set(target, guid); },
            }
          : undefined,
    };
    const layer = (stateId: string, clipAssetGuid: string, weight: number) => ({
      stateId,
      clipAssetGuid,
      clipName: "",
      clipKind: "sprite" as const,
      normalisedTime: 0,
      weight,
    });
    const crossfade = (secondGuid: string) => applyAnimStateToScene(host, {
      type: "animState",
      slotId: 1,
      stateId: "walk",
      normalisedTime: 0,
      blendWeights: { idle: 0.4, walk: 0.6 },
      clipName: "",
      clipKind: "sprite",
      layers: [layer("idle", "idle-anim", 0.4), layer("walk", secondGuid, 0.6)],
    });
    crossfade("walk-anim");
    expect(bound.get(mesh)).toBe("idle-tex");
    expect(bound.get(overlay)).toBe("walk-tex");
    expect(mesh.visibility).toBeCloseTo(0.4);
    expect(overlay.visibility).toBeCloseTo(0.6);

    crossfade("missing-anim");
    expect(overlay.visibility).toBe(0);
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

  it("poses inside an Animation clip with a nonzero first frame without starting its group", () => {
    const target = new TransformNode("hero", scene);
    const animation = new Animation("Walk", "position.x", 30, Animation.ANIMATIONTYPE_FLOAT);
    animation.setKeys([{ frame: 30, value: 10 }, { frame: 60, value: 20 }]);
    const walk = new AnimationGroup("Walk", scene);
    walk.addTargetedAnimation(animation, target);
    const clip = bindPoseClip(walk, undefined);
    applyAnimStateToScene({ getPoseClips: () => [clip] }, {
      type: "animState",
      slotId: 1,
      stateId: "walk",
      normalisedTime: 0.5,
      blendWeights: { walk: 1 },
      clipName: "Walk",
      clipKind: "animation",
    });
    expect(target.position.x).toBeCloseTo(15);
    expect(scene.animatables).toHaveLength(0);
  });
});

describe("sceneAnimHostFromBinding", () => {
  it("resolves overlay sprites and per-slot clips from the binding", () => {
    const payload: SpritePayload = {
      textureGuid: null,
      pixelsPerUnit: 100,
      pivot: { x: 0.5, y: 0.5 },
      collision: { x: 0, y: 0, width: 1, height: 1 },
      width: 16,
      height: 16,
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
    const overlay = createSpriteQuad(scene, "hero-overlay", payload);
    binding.spriteOverlays = new Map([[0, overlay]]);
    const idle = frameClip("Idle", 10, "hero-model");
    binding.slotPoseClips = new Map([[7, [idle]]]);
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
    expect(idle.target.value).toBe(5);
    disposeSnapshotBinding(binding);
    expect(overlay.isDisposed()).toBe(true);
    scene.dispose();
    engine.dispose();
  });

  it("poses Idle only on the slot whose Model guid matches", () => {
    const binding = createSnapshotSceneBinding();
    const a = frameClip("Idle", 10, "model-a");
    const unowned = frameClip("Idle", 10);
    const b = frameClip("Idle", 10, "model-b");
    binding.slotPoseClips = new Map([[1, [a]], [2, [unowned, b]]]);
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
    // A slot whose Model has not registered Idle never borrows another actor's clip.
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
    expect(a.target.value).toBe(8);
    expect(b.target.value).toBe(4);
    expect(unowned.target.value).toBe(0);
    disposeSnapshotBinding(binding);
  });
});
