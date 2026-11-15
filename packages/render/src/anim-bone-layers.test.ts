import { Animation } from "@babylonjs/core/Animations/animation";
import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { animBranchFilterKey, type AnimBoneModifier, type AnimBranchFilter, type AnimLayerMaskRef } from "@haptic/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPose, bindPoseClip, poseRigFor, type PoseAdditive, type PoseClip, type PoseLayering } from "./anim-pose";

let engine: NullEngine;
let scene: Scene;
let nodes: Record<"actor" | "hips" | "spine" | "arm" | "hand" | "leg", TransformNode>;

/** actor → hips → spine → arm → hand, and hips → leg; each a unit step along +Y from its parent. */
beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  const make = (name: string, parent: TransformNode | null) => {
    const node = new TransformNode(name, scene);
    node.parent = parent;
    node.position.set(0, parent ? 1 : 0, 0);
    node.rotationQuaternion = Quaternion.Identity();
    return node;
  };
  const actor = make("actor-1", null);
  const hips = make("hips", actor);
  const spine = make("spine", hips);
  const arm = make("arm", spine);
  nodes = { actor, hips, spine, arm, hand: make("hand", arm), leg: make("leg", hips) };
});

afterEach(() => {
  scene.dispose();
  engine.dispose();
});

/** A clip holding position.x at `x` on each node it names. */
function clipAt(name: string, x: number, targets: readonly TransformNode[]): PoseClip {
  const group = new AnimationGroup(name, scene);
  for (const target of targets) {
    const animation = new Animation(`${name}-${target.name}`, "position", 30, Animation.ANIMATIONTYPE_VECTOR3);
    animation.setKeys([{ frame: 0, value: new Vector3(x, 1, 0) }, { frame: 10, value: new Vector3(x, 1, 0) }]);
    group.addTargetedAnimation(animation, target);
  }
  return bindPoseClip(group, name);
}

const xs = () => Object.fromEntries(Object.entries(nodes).map(([name, node]) => [name, Number(node.position.x.toFixed(6))]));

function layered(branches: AnimBranchFilter[][], weights: number[]): (masks: Array<AnimLayerMaskRef[] | undefined>) => PoseLayering {
  return (masks) => ({ masks, blends: [{ filters: branches.map(animBranchFilterKey), weights }], modifiers: [] });
}

describe("Layered Blend Per Bone masks", () => {
  const body = () => [nodes.hips, nodes.spine, nodes.arm, nodes.hand, nodes.leg];

  it("plays the blend input on its branch and the base elsewhere", () => {
    const walk = clipAt("walk", 1, body());
    const attack = clipAt("attack", 5, body());
    const clips = [walk, attack];
    const layering = layered([[{ bone: "spine", blendDepth: 0 }]], [1]);
    applyPose(poseRigFor(clips), 2, clips, [0, 0], [1, 1], layering([[{ blend: 0, input: -1 }], [{ blend: 0, input: 0 }]]));
    expect(xs()).toMatchObject({ hips: 1, spine: 5, arm: 5, hand: 5, leg: 1 });
  });

  it("blends the branch by the input's weight, which its layer already carries", () => {
    const clips = [clipAt("walk", 1, body()), clipAt("attack", 5, body())];
    const layering = layered([[{ bone: "spine", blendDepth: 0 }]], [0.5]);
    applyPose(poseRigFor(clips), 2, clips, [0, 0], [1, 0.5], layering([[{ blend: 0, input: -1 }], [{ blend: 0, input: 0 }]]));
    expect(xs()).toMatchObject({ hips: 1, spine: 3, hand: 3, leg: 1 });
  });

  it("ramps in over Blend Depth bones, and leaves out a branch below 0", () => {
    const clips = [clipAt("walk", 1, body()), clipAt("attack", 5, body())];
    const layering = layered([[{ bone: "spine", blendDepth: 2 }, { bone: "hand", blendDepth: -1 }]], [1]);
    applyPose(poseRigFor(clips), 2, clips, [0, 0], [1, 1], layering([[{ blend: 0, input: -1 }], [{ blend: 0, input: 0 }]]));
    // Spine at half weight, the arm (one below) at full, the hand left out.
    expect(xs()).toMatchObject({ hips: 1, spine: 3, arm: 5, hand: 1, leg: 1 });
  });

  it("shares a bone among inputs whose weights sum above 1, leaving the base none", () => {
    const clips = [clipAt("walk", 1, body()), clipAt("a", 4, body()), clipAt("b", 8, body())];
    const layering = layered([[{ bone: "spine", blendDepth: 0 }], [{ bone: "arm", blendDepth: 0 }]], [1, 1]);
    applyPose(poseRigFor(clips), 3, clips, [0, 0, 0], [1, 1, 1], layering([[{ blend: 0, input: -1 }], [{ blend: 0, input: 0 }], [{ blend: 0, input: 1 }]]));
    expect(xs()).toMatchObject({ hips: 1, spine: 4, arm: 6, leg: 1 });
  });

  it("fills from rest where the blend input's clip has no key, as Unreal's reference pose does", () => {
    const clips = [clipAt("walk", 1, body()), clipAt("wave", 5, [nodes.hand])];
    const layering = layered([[{ bone: "spine", blendDepth: 0 }]], [1]);
    applyPose(poseRigFor(clips), 2, clips, [0, 0], [1, 1], layering([[{ blend: 0, input: -1 }], [{ blend: 0, input: 0 }]]));
    expect(xs()).toMatchObject({ hips: 1, spine: 0, arm: 0, hand: 5, leg: 1 });
  });
});

function modifier(change: Partial<AnimBoneModifier> & { bone: string }): PoseLayering {
  return { masks: [], blends: [], modifiers: [{ alpha: 1, ...change }] };
}

const actorPosition = (node: TransformNode) => {
  node.computeWorldMatrix(true);
  const inverseRoot = nodes.actor.computeWorldMatrix(true).clone().invert();
  return Vector3.TransformCoordinates(Vector3.Zero(), node.getWorldMatrix().multiply(inverseRoot));
};

describe("Transform Bone changes", () => {
  it("adds a rotation in parent space to a bone no clip animates, and rests it once the change stops", () => {
    const clips = [clipAt("walk", 1, [nodes.hips])];
    const rig = poseRigFor(clips);
    const turn = Quaternion.RotationAxis(Vector3.Up(), Math.PI / 2);
    applyPose(rig, 1, clips, [0], [1], modifier({ bone: "spine", rotation: { value: [turn.x, turn.y, turn.z, turn.w], mode: "add", space: "parent" } }));
    expect(Math.abs(Quaternion.Dot(nodes.spine.rotationQuaternion!, turn))).toBeCloseTo(1, 9);
    // A second pose adds to the pose again, not to the last change.
    applyPose(rig, 1, clips, [1], [1], modifier({ bone: "spine", rotation: { value: [turn.x, turn.y, turn.z, turn.w], mode: "add", space: "parent" } }));
    expect(Math.abs(Quaternion.Dot(nodes.spine.rotationQuaternion!, turn))).toBeCloseTo(1, 9);
    applyPose(rig, 1, clips, [2], [1], null);
    expect(Math.abs(Quaternion.Dot(nodes.spine.rotationQuaternion!, Quaternion.Identity()))).toBeCloseTo(1, 9);
  });

  it("changes an animated channel from its blended value, which the next pose writes again", () => {
    const clips = [clipAt("walk", 1, [nodes.hips])];
    const rig = poseRigFor(clips);
    applyPose(rig, 1, clips, [0], [1], modifier({ bone: "hips", translation: { value: [0, 0, 2], mode: "add", space: "parent" } }));
    expect(nodes.hips.position.asArray()).toEqual([1, 1, 2]);
    applyPose(rig, 1, clips, [0], [1], null);
    expect(nodes.hips.position.asArray()).toEqual([1, 1, 0]);
  });

  it("replaces a translation in actor space under a turned, scaled parent", () => {
    nodes.hips.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), 0.7);
    nodes.hips.scaling.set(2, 2, 2);
    const clips = [clipAt("walk", 0, [nodes.leg])];
    applyPose(poseRigFor(clips), 1, clips, [0], [1], modifier({ bone: "arm", translation: { value: [3, 4, 5], mode: "replace", space: "actor" } }));
    const at = actorPosition(nodes.arm);
    expect([at.x, at.y, at.z].map((value) => Number(value.toFixed(6)))).toEqual([3, 4, 5]);
  });

  it("ignores the actor's own placement in actor space", () => {
    nodes.actor.position.set(10, 0, 0);
    nodes.actor.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), 1);
    const clips = [clipAt("walk", 0, [nodes.leg])];
    applyPose(poseRigFor(clips), 1, clips, [0], [1], modifier({ bone: "hips", translation: { value: [0, 0, 1], mode: "add", space: "actor" } }));
    expect(nodes.hips.position.asArray().map((value) => Number(value.toFixed(6)))).toEqual([0, 1, 1]);
  });

  it("moves along the bone's own axes in bone space, and blends by alpha", () => {
    nodes.arm.rotationQuaternion = Quaternion.RotationAxis(Vector3.Forward(), Math.PI / 2);
    const clips = [clipAt("walk", 0, [nodes.leg])];
    applyPose(poseRigFor(clips), 1, clips, [0], [1], modifier({ bone: "arm", alpha: 0.5, translation: { value: [2, 0, 0], mode: "add", space: "bone" } }));
    // The arm's X axis points along its parent's +Y (or -Y): half of 2 along it.
    expect(Math.abs(nodes.arm.position.y - 1)).toBeCloseTo(1, 6);
    expect(nodes.arm.position.x).toBeCloseTo(0, 6);
  });

  it("scales by a Layered Blend input's weight on the bone", () => {
    const clips = [clipAt("walk", 0, [nodes.leg])];
    const turn = Quaternion.RotationAxis(Vector3.Up(), 1);
    applyPose(poseRigFor(clips), 1, clips, [0], [1], {
      masks: [undefined],
      blends: [{ filters: [animBranchFilterKey([{ bone: "spine", blendDepth: 2 }])], weights: [1] }],
      modifiers: [{ bone: "spine", alpha: 1, masks: [{ blend: 0, input: 0 }], rotation: { value: [turn.x, turn.y, turn.z, turn.w], mode: "replace", space: "parent" } }],
    });
    // The spine is at half weight in its branch: half of the turn.
    const half = Quaternion.RotationAxis(Vector3.Up(), 0.5);
    expect(Math.abs(Quaternion.Dot(nodes.spine.rotationQuaternion!, half))).toBeCloseTo(1, 9);
  });

  it("writes nothing again for an unchanged pose and layering", () => {
    const clips = [clipAt("walk", 1, [nodes.hips])];
    const rig = poseRigFor(clips);
    const change = modifier({ bone: "spine", translation: { value: [0, 0, 1], mode: "add", space: "parent" } });
    applyPose(rig, 1, clips, [0], [1], change);
    nodes.spine.position.z = 7;
    applyPose(rig, 1, clips, [0], [1], modifier({ bone: "spine", translation: { value: [0, 0, 1], mode: "add", space: "parent" } }));
    expect(nodes.spine.position.z).toBe(7);
  });
});

/** A clip moving `target`'s `path` through `keys` (frame → value). */
function keyedClip(name: string, target: TransformNode, path: "position" | "rotationQuaternion" | "scaling", keys: Array<[number, Vector3 | Quaternion]>): PoseClip {
  const type = path === "rotationQuaternion" ? Animation.ANIMATIONTYPE_QUATERNION : Animation.ANIMATIONTYPE_VECTOR3;
  const animation = new Animation(`${name}-${path}`, path, 30, type);
  animation.setKeys(keys.map(([frame, value]) => ({ frame, value })));
  const group = new AnimationGroup(name, scene);
  group.addTargetedAnimation(animation, target);
  return bindPoseClip(group, name);
}

const turn = (radians: number) => Quaternion.RotationAxis(Vector3.Up(), radians);
const additive = (count: number, entries: Array<PoseAdditive | undefined>): PoseLayering => ({
  masks: Array.from({ length: count }, () => undefined), blends: [], modifiers: [], additive: entries,
});

describe("additive clips", () => {
  it("add their change from the rest pose, by weight, on top of the blended pose", () => {
    const base = keyedClip("walk", nodes.hips, "position", [[0, new Vector3(1, 1, 0)], [10, new Vector3(1, 1, 0)]]);
    const lean = keyedClip("lean", nodes.hips, "position", [[0, new Vector3(3, 1, 0)], [10, new Vector3(3, 1, 0)]]);
    const clips = [base, lean];
    applyPose(poseRigFor(clips), 2, clips, [0, 0], [1, 0.5], additive(2, [undefined, { reference: null, frame: 0 }]));
    // Rest is (0, 1, 0): half of the lean's +3 in x on the walk's 1.
    expect(nodes.hips.position.asArray()).toEqual([2.5, 1, 0]);
  });

  it("change from their own first frame, or from another clip's frame", () => {
    const base = keyedClip("walk", nodes.hips, "position", [[0, new Vector3(1, 1, 0)], [10, new Vector3(1, 1, 0)]]);
    const sway = keyedClip("sway", nodes.hips, "position", [[0, new Vector3(2, 1, 0)], [10, new Vector3(5, 1, 0)]]);
    const clips = [base, sway];
    const rig = poseRigFor(clips);
    applyPose(rig, 2, clips, [0, 10], [1, 1], additive(2, [undefined, { reference: sway, frame: 0 }]));
    expect(nodes.hips.position.x).toBeCloseTo(4, 9);
    // From the walk's pose instead: 5 − 1 on the walk's 1.
    applyPose(rig, 2, clips, [0, 10], [1, 1], additive(2, [undefined, { reference: base, frame: 0 }]));
    expect(nodes.hips.position.x).toBeCloseTo(5, 9);
  });

  it("turn a rotation by their change, scaled by the weight, before the pose's own rotation", () => {
    const base = keyedClip("walk", nodes.spine, "rotationQuaternion", [[0, turn(0.5)], [10, turn(0.5)]]);
    const twist = keyedClip("twist", nodes.spine, "rotationQuaternion", [[0, Quaternion.RotationAxis(Vector3.Right(), 0.8)], [10, Quaternion.RotationAxis(Vector3.Right(), 0.8)]]);
    const clips = [base, twist];
    const rig = poseRigFor(clips);
    applyPose(rig, 2, clips, [0, 0], [1, 1], additive(2, [undefined, { reference: null, frame: 0 }]));
    const full = Quaternion.RotationAxis(Vector3.Right(), 0.8).multiply(turn(0.5));
    expect(Math.abs(Quaternion.Dot(nodes.spine.rotationQuaternion!, full))).toBeCloseTo(1, 9);
    applyPose(rig, 2, clips, [0, 0], [1, 0.5], additive(2, [undefined, { reference: null, frame: 0 }]));
    const half = Quaternion.RotationAxis(Vector3.Right(), 0.4).multiply(turn(0.5));
    expect(Math.abs(Quaternion.Dot(nodes.spine.rotationQuaternion!, half))).toBeCloseTo(1, 6);
  });

  it("multiply scales, and start a property no other clip plays from rest", () => {
    nodes.arm.scaling.set(2, 2, 2);
    const grow = keyedClip("grow", nodes.arm, "scaling", [[0, new Vector3(4, 2, 2)], [10, new Vector3(4, 2, 2)]]);
    const clips = [keyedClip("walk", nodes.hips, "position", [[0, new Vector3(1, 1, 0)]]), grow];
    applyPose(poseRigFor(clips), 2, clips, [0, 0], [1, 0.5], additive(2, [undefined, { reference: null, frame: 0 }]));
    // Rest scale 2, the clip doubles x from rest: half of that is ×1.5.
    expect(nodes.arm.scaling.asArray()).toEqual([3, 2, 2]);
  });
});
