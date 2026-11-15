import { Animation } from "@babylonjs/core/Animations/animation";
import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import type { AnimLookAtChange, AnimTwoBoneIkChange } from "@haptic/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPose, bindPoseClip, poseRigFor, type PoseClip, type PoseLayering } from "./anim-pose";
import { attachSkeletalControlPreview } from "./skeletal-control-preview";

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
  rig = null;
  scene.dispose();
  engine.dispose();
});

/** A clip that only holds the leg still, so the arm chain's channels start from rest. */
function legClip(): PoseClip {
  const group = new AnimationGroup("idle", scene);
  const animation = new Animation("idle-leg", "position", 30, Animation.ANIMATIONTYPE_VECTOR3);
  animation.setKeys([{ frame: 0, value: new Vector3(0, 1, 0) }, { frame: 10, value: new Vector3(0, 1, 0) }]);
  group.addTargetedAnimation(animation, nodes.leg);
  return bindPoseClip(group, "idle");
}

let rig: { clips: PoseClip[]; rig: ReturnType<typeof poseRigFor> } | null = null;
let frame = 0;

/** Poses the test's one rig (as a slot keeps it across poses) with the changes. */
function pose(...modifiers: PoseLayering["modifiers"]): void {
  if (!rig) {
    const clips = [legClip()];
    rig = { clips, rig: poseRigFor(clips) };
  }
  applyPose(rig.rig, 1, rig.clips, [frame++ % 10], [1], modifiers.length > 0 ? { masks: [], blends: [], modifiers } : null);
}

/** A node's transform relative to the actor's root. */
function actorMatrix(node: TransformNode): Matrix {
  const inverseRoot = nodes.actor.computeWorldMatrix(true).clone().invert();
  return node.computeWorldMatrix(true).multiply(inverseRoot);
}

const rounded = (vector: Vector3) => [vector.x, vector.y, vector.z].map((value) => Number(value.toFixed(5)) + 0);
const actorAt = (node: TransformNode) => rounded(actorMatrix(node).getTranslation());
const actorAxis = (node: TransformNode, axis: Vector3) => rounded(Vector3.TransformNormal(axis, actorMatrix(node)).normalize());

const ik = (change: Partial<AnimTwoBoneIkChange>): AnimTwoBoneIkChange => ({
  kind: "twoBoneIk", bone: "hand", alpha: 1, effector: [0, 0, 0], effectorSpace: "actor", jointTargetSpace: "actor",
  maxStretch: 1, keepEffectorRotation: false, ...change,
});

const lookAt = (change: Partial<AnimLookAtChange>): AnimLookAtChange => ({
  kind: "lookAt", bone: "hand", alpha: 1, target: [0, 0, 0], targetSpace: "actor", aimAxis: [0, 1, 0], limitDegrees: 180, ...change,
});

describe("Two Bone IK", () => {
  it("puts the end bone on a reachable effector, turning its grandparent and parent", () => {
    pose(ik({ effector: [1, 2, 0] }));
    // The spine (the root) sits at (0, 2, 0), the arm and hand one unit on.
    expect(actorAt(nodes.hand)).toEqual([1, 2, 0]);
    expect(actorAt(nodes.spine)).toEqual([0, 2, 0]);
    // A straight chain bends toward where its joint is: up.
    expect(actorAt(nodes.arm)).toEqual([0.5, Number((2 + Math.sqrt(0.75)).toFixed(5)), 0]);
  });

  it("bends toward the Joint Target", () => {
    pose(ik({ effector: [1, 2, 0], jointTarget: [0.5, 2, 5] }));
    expect(actorAt(nodes.hand)).toEqual([1, 2, 0]);
    expect(actorAt(nodes.arm)).toEqual([0.5, 2, Number(Math.sqrt(0.75).toFixed(5))]);
  });

  it("reaches as far as the chain allows, and stretches up to Max Stretch", () => {
    pose(ik({ effector: [0, 10, 0] }));
    expect(actorAt(nodes.hand)[1]).toBeCloseTo(4, 4);
    pose(ik({ effector: [0, 10, 0], maxStretch: 2 }));
    expect(actorAt(nodes.hand)).toEqual([0, 6, 0]);
    expect(nodes.arm.position.y).toBeCloseTo(2, 6);
  });

  it("takes a world-space effector through the actor's placement", () => {
    nodes.actor.position.set(10, 0, 0);
    nodes.actor.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), Math.PI / 2);
    // Actor-space (1, 2, 0) in the world: a quarter turn about Y takes +X to -Z.
    pose(ik({ effector: [10, 2, -1], effectorSpace: "world" }));
    expect(actorAt(nodes.hand)).toEqual([1, 2, 0]);
  });

  it("keeps the end bone's actor rotation with Keep Effector Rotation", () => {
    pose(ik({ effector: [1, 2, 0], keepEffectorRotation: true }));
    expect(actorAxis(nodes.hand, Vector3.Up())).toEqual([0, 1, 0]);
    pose(ik({ effector: [1, 2, 0] }));
    expect(actorAxis(nodes.hand, Vector3.Up())).not.toEqual([0, 1, 0]);
  });

  it("solves the same under a mirrored parent", () => {
    nodes.hips.scaling.set(1, 1, -1);
    pose(ik({ effector: [0.6, 2.2, 0.5] }));
    expect(actorAt(nodes.hand)).toEqual([0.6, 2.2, 0.5]);
  });

  it("blends each bone by Alpha, and returns the chain to rest once it stops", () => {
    pose(ik({ effector: [1, 2, 0] }));
    const full = nodes.arm.rotationQuaternion!.clone();
    pose(ik({ effector: [1, 2, 0], alpha: 0.5 }));
    const half = Quaternion.Slerp(Quaternion.Identity(), full, 0.5);
    expect(Math.abs(Quaternion.Dot(nodes.arm.rotationQuaternion!, half))).toBeCloseTo(1, 6);
    pose();
    expect(actorAt(nodes.hand)).toEqual([0, 4, 0]);
    expect(actorAt(nodes.arm)).toEqual([0, 3, 0]);
  });
});

describe("Look At", () => {
  it("turns the Aim Axis onto the target", () => {
    pose(lookAt({ target: [5, 4, 0] }));
    expect(actorAxis(nodes.hand, Vector3.Up())).toEqual([1, 0, 0]);
    // It turns about its own origin.
    expect(actorAt(nodes.hand)).toEqual([0, 4, 0]);
  });

  it("turns no further than the limit", () => {
    pose(lookAt({ target: [5, 4, 0], limitDegrees: 45 }));
    const aim = actorAxis(nodes.hand, Vector3.Up());
    expect(aim[0]).toBeCloseTo(Math.SQRT1_2, 4);
    expect(aim[1]).toBeCloseTo(Math.SQRT1_2, 4);
  });

  it("rolls the Up Axis toward the actor's up", () => {
    // Rolled half a turn about its aim (+Z), its +Y points down until Look At rolls it back.
    nodes.hand.rotationQuaternion = Quaternion.RotationAxis(Vector3.Forward(), Math.PI);
    pose(lookAt({ target: [0, 4, 5], aimAxis: [0, 0, 1], upAxis: [0, 1, 0] }));
    expect(actorAxis(nodes.hand, Vector3.Forward())).toEqual([0, 0, 1]);
    expect(actorAxis(nodes.hand, Vector3.Up())).toEqual([0, 1, 0]);
  });

  it("takes a world-space target through the actor's placement", () => {
    nodes.actor.position.set(0, 0, 3);
    pose(lookAt({ target: [5, 4, 3], targetSpace: "world" }));
    expect(actorAxis(nodes.hand, Vector3.Up())).toEqual([1, 0, 0]);
  });
});

describe("IK target markers", () => {
  it("marks each target in the world, through the actor's placement for actor space, and hides the rest", () => {
    nodes.actor.position.set(0, 0, 3);
    const markers = attachSkeletalControlPreview(nodes.actor, scene);
    markers.update([lookAt({ target: [1, 2, 0] }), ik({ effector: [0, 1, 0], effectorSpace: "world", jointTarget: [0, 0, 1] })]);
    expect(markers.targetCount).toBe(3);
    const shown = scene.meshes.filter((mesh) => mesh.name.startsWith("ik_target_") && mesh.isEnabled());
    expect(shown.map((mesh) => rounded(mesh.position))).toEqual([[1, 2, 3], [0, 1, 0], [0, 0, 4]]);
    markers.update([]);
    expect(markers.targetCount).toBe(0);
    expect(scene.meshes.some((mesh) => mesh.name.startsWith("ik_target_") && mesh.isEnabled())).toBe(false);
    markers.dispose();
  });
});
