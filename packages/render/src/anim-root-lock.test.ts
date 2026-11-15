import { Animation } from "@babylonjs/core/Animations/animation";
import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPose, bindPoseClip, poseRigFor, type PoseClip } from "./anim-pose";

let engine: NullEngine;
let scene: Scene;
let nodes: Record<"loader" | "armature" | "hips", TransformNode>;

/** __root__ → Armature (turned a quarter about X, as Blender exports) → hips. */
beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  const loader = new TransformNode("__root__", scene);
  loader.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), Math.PI);
  const armature = new TransformNode("Armature", scene);
  armature.parent = loader;
  armature.rotationQuaternion = Quaternion.RotationAxis(Vector3.Right(), -Math.PI / 2);
  const hips = new TransformNode("hips", scene);
  hips.parent = armature;
  hips.rotationQuaternion = Quaternion.Identity();
  nodes = { loader, armature, hips };
});

afterEach(() => {
  scene.dispose();
  engine.dispose();
});

/**
 * A clip whose hips travel 2 along the Model's -Z (the Armature's +Y) and rise 0.5 along the Model's Y (the Armature's
 * +Z), turning 90° about the Model's up axis on the way.
 */
function travelClip(): PoseClip {
  const group = new AnimationGroup("walk", scene);
  const position = new Animation("walk-position", "position", 30, Animation.ANIMATIONTYPE_VECTOR3);
  position.setKeys([{ frame: 0, value: new Vector3(0, 0, 1) }, { frame: 30, value: new Vector3(0, 2, 1.5) }]);
  // The Model's up axis is the Armature's -Z after its turn about X.
  const turn = Quaternion.RotationAxis(new Vector3(0, 0, 1), Math.PI / 2);
  const rotation = new Animation("walk-rotation", "rotationQuaternion", 30, Animation.ANIMATIONTYPE_QUATERNION);
  rotation.setKeys([{ frame: 0, value: Quaternion.Identity() }, { frame: 30, value: turn }]);
  group.addTargetedAnimation(position, nodes.hips);
  group.addTargetedAnimation(rotation, nodes.hips);
  group.normalize(0, 30);
  return bindPoseClip(group, "walk");
}

describe("root motion lock", () => {
  it("holds the root bone's travel across the ground and its turn, keeping its rise", () => {
    const clips = [travelClip()];
    const rig = poseRigFor(clips);
    applyPose(rig, 1, clips, [30], [1], null);
    // Played as authored, the bone travels and turns.
    expect(nodes.hips.position.y).toBeCloseTo(2, 6);
    applyPose(rig, 1, clips, [30], [1], { masks: [], blends: [], modifiers: [], rootLock: ["hips"] });
    // Held: no travel along the Armature's Y (the ground), the rise along its Z kept.
    expect(nodes.hips.position.x).toBeCloseTo(0, 6);
    expect(nodes.hips.position.y).toBeCloseTo(0, 6);
    expect(nodes.hips.position.z).toBeCloseTo(1.5, 6);
    expect(Math.abs(Quaternion.Dot(nodes.hips.rotationQuaternion!, Quaternion.Identity()))).toBeCloseTo(1, 6);
  });
});
