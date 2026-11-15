import { Animation } from "@babylonjs/core/Animations/animation";
import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { Bone } from "@babylonjs/core/Bones/bone";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { MorphTarget } from "@babylonjs/core/Morph/morphTarget";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPose,
  applyPoseClip,
  bindPoseClip,
  invalidatePoseRig,
  poseRigFor,
  poseTrackOf,
  samplePoseTrack,
  type PoseClip,
} from "./anim-pose";
import { handOverNode } from "./node-handover";

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

function components(value: unknown): number[] {
  if (typeof value === "number") return [value];
  if (value instanceof Quaternion) return [value.x, value.y, value.z, value.w];
  const v = value as Vector3;
  return [v.x, v.y, v.z];
}

function expectSamplesMatchBabylon(animation: Animation, frames: readonly number[]): void {
  const track = poseTrackOf(animation)!;
  expect(track).not.toBeNull();
  const out = new Float64Array(4);
  for (const frame of frames) {
    samplePoseTrack(track, frame, out);
    const expected = components(animation.evaluate(frame));
    for (let c = 0; c < expected.length; c++) expect(out[c]).toBeCloseTo(expected[c]!, 12);
  }
}

const SWEEP = [-5, 0, 3, 7.5, 10, 12.25, 19.9, 20, 25, 30, 41];

function group(name: string, channels: Array<[Animation, unknown]>): AnimationGroup {
  const result = new AnimationGroup(name, scene);
  for (const [animation, target] of channels) result.addTargetedAnimation(animation, target);
  return result;
}

function positionX(name: string, keys: Array<[number, number]>): Animation {
  const animation = new Animation(name, "position", 30, Animation.ANIMATIONTYPE_VECTOR3);
  animation.setKeys(keys.map(([frame, x]) => ({ frame, value: new Vector3(x, 0, 0) })));
  return animation;
}

describe("samplePoseTrack", () => {
  it("samples linear, stepped and held keys as Babylon's own interpolation does", () => {
    const float = new Animation("f", "influence", 30, Animation.ANIMATIONTYPE_FLOAT);
    float.setKeys([{ frame: 0, value: 1 }, { frame: 10, value: 3, interpolation: 1 }, { frame: 20, value: -2 }, { frame: 30, value: 4 }]);
    expectSamplesMatchBabylon(float, SWEEP);
    const vector = new Animation("v", "position", 30, Animation.ANIMATIONTYPE_VECTOR3);
    vector.setKeys([{ frame: 0, value: new Vector3(1, 2, 3) }, { frame: 20, value: new Vector3(-4, 0.5, 9) }, { frame: 30, value: new Vector3(0, 0, 0) }]);
    expectSamplesMatchBabylon(vector, SWEEP);
  });

  it("slerps quaternion keys the short way round, as Babylon does", () => {
    const rotation = new Animation("q", "rotationQuaternion", 30, Animation.ANIMATIONTYPE_QUATERNION);
    const far = Quaternion.RotationAxis(new Vector3(0, 1, 0), 3);
    // The second key is the same rotation on the other hemisphere.
    rotation.setKeys([
      { frame: 0, value: Quaternion.Identity() },
      { frame: 20, value: new Quaternion(-far.x, -far.y, -far.z, -far.w) },
      { frame: 30, value: Quaternion.RotationAxis(new Vector3(1, 0, 0), 0.5) },
    ]);
    expectSamplesMatchBabylon(rotation, SWEEP);
  });

  it("interpolates quaternion keys under 90° apart within 0.005° of Babylon's slerp", () => {
    const rotation = new Animation("q", "rotationQuaternion", 30, Animation.ANIMATIONTYPE_QUATERNION);
    rotation.setKeys([
      { frame: 0, value: Quaternion.RotationAxis(new Vector3(0, 1, 0), 0.2) },
      { frame: 10, value: Quaternion.RotationAxis(new Vector3(1, 1, 0).normalize(), 1.4) },
      { frame: 20, value: Quaternion.RotationAxis(new Vector3(0, 0, 1), 0.1) },
    ]);
    const track = poseTrackOf(rotation)!;
    const out = new Float64Array(4);
    for (let frame = 0; frame <= 20; frame += 0.25) {
      samplePoseTrack(track, frame, out);
      const expected = rotation.evaluate(frame) as Quaternion;
      const cos = Math.min(1, Math.abs(out[0]! * expected.x + out[1]! * expected.y + out[2]! * expected.z + out[3]! * expected.w));
      expect(2 * Math.acos(cos) * (180 / Math.PI)).toBeLessThan(0.005);
    }
  });

  it("samples cubic-spline keys with their tangents, as Babylon does", () => {
    const float = new Animation("f", "influence", 30, Animation.ANIMATIONTYPE_FLOAT);
    float.setKeys([
      { frame: 0, value: 0, inTangent: 0, outTangent: 0.2 },
      { frame: 20, value: 1, inTangent: -0.1, outTangent: 0.05 },
      { frame: 30, value: 0.5, inTangent: 0.3, outTangent: 0 },
    ]);
    expectSamplesMatchBabylon(float, SWEEP);
    const rotation = new Animation("q", "rotationQuaternion", 30, Animation.ANIMATIONTYPE_QUATERNION);
    rotation.setKeys([
      { frame: 0, value: Quaternion.Identity(), inTangent: new Quaternion(0, 0, 0, 0), outTangent: new Quaternion(0, 0.02, 0, 0) },
      { frame: 20, value: Quaternion.RotationAxis(new Vector3(0, 1, 0), 1), inTangent: new Quaternion(0.01, 0.01, 0, 0), outTangent: new Quaternion(0, 0, 0, 0) },
    ]);
    expectSamplesMatchBabylon(rotation, SWEEP);
  });

  it("compiles an Animation's keys once for every clip that plays them", () => {
    const animation = positionX("shared", [[0, 0], [10, 1]]);
    const a = bindPoseClip(group("A", [[animation, new TransformNode("a", scene)]]), undefined);
    const b = bindPoseClip(group("B", [[animation, new TransformNode("b", scene)]]), undefined);
    expect(a.channels[0]!.track).toBe(b.channels[0]!.track);
  });
});

describe("applyPose", () => {
  function pose(rig: ReturnType<typeof poseRigFor>, layers: Array<[PoseClip, number, number]>): void {
    applyPose(rig, layers.length, layers.map(([clip]) => clip), layers.map(([, frame]) => frame), layers.map(([, , weight]) => weight));
  }

  it("blends by weight, filling a total below one from the rest pose and normalising one above it", () => {
    const node = new TransformNode("node", scene);
    node.position.set(2, 0, 0);
    const walk = bindPoseClip(group("Walk", [[positionX("walk", [[0, 10], [10, 10]]), node]]), undefined);
    const run = bindPoseClip(group("Run", [[positionX("run", [[0, 20], [10, 20]]), node]]), undefined);
    const rig = poseRigFor([walk, run]);
    pose(rig, [[walk, 0, 0.5]]);
    expect(node.position.x).toBeCloseTo(0.5 * 2 + 0.5 * 10);
    pose(rig, [[walk, 0, 0.25], [run, 0, 0.25]]);
    expect(node.position.x).toBeCloseTo(0.5 * 2 + 0.25 * 10 + 0.25 * 20);
    pose(rig, [[walk, 0, 1], [run, 0, 3]]);
    expect(node.position.x).toBeCloseTo(0.25 * 10 + 0.75 * 20);
    expect(node.position.y).toBe(0);
  });

  it("blends quaternions by normalised weighted sum on one hemisphere, the rest pose taking what the clips leave", () => {
    const node = new TransformNode("node", scene);
    const rest = Quaternion.RotationAxis(new Vector3(0, 0, 1), 0.3);
    node.rotationQuaternion = rest.clone();
    const a = Quaternion.RotationAxis(new Vector3(0, 1, 0), 1);
    const b = Quaternion.RotationAxis(new Vector3(1, 0, 0), -0.7);
    const held = (name: string, value: Quaternion) => {
      const animation = new Animation(name, "rotationQuaternion", 30, Animation.ANIMATIONTYPE_QUATERNION);
      animation.setKeys([{ frame: 0, value }, { frame: 10, value }]);
      return bindPoseClip(group(name, [[animation, node]]), undefined);
    };
    // b keyed on the other hemisphere: the same rotation, so it blends as b.
    const clipA = held("A", a);
    const clipB = held("B", b.scale(-1));
    const rig = poseRigFor([clipA, clipB]);
    // q and -q are one rotation.
    const expectRotation = (expected: Quaternion) => {
      const actual = node.rotationQuaternion!;
      expect(Math.abs(Quaternion.Dot(actual, expected))).toBeCloseTo(1, 12);
    };
    pose(rig, [[clipA, 0, 0.3], [clipB, 0, 0.5]]);
    expectRotation(a.scale(0.3).add(b.scale(0.5)).add(rest.scale(0.2)).normalize());
    // Order does not matter, and weights above one normalise.
    pose(rig, [[clipB, 0, 2], [clipA, 0, 2]]);
    expectRotation(a.add(b).normalize());
  });

  it("returns what no clip plays to rest, and a fresh rig rests all it does not play", () => {
    const hip = new TransformNode("hip", scene);
    const hand = new TransformNode("hand", scene);
    hand.position.set(0, 1, 0);
    const wave = bindPoseClip(group("Wave", [[positionX("wave", [[0, 0], [10, 5]]), hand]]), undefined);
    const walk = bindPoseClip(group("Walk", [[positionX("walk", [[0, 0], [10, 3]]), hip]]), undefined);
    const clips = [wave, walk];
    applyPoseClip(poseRigFor(clips), wave, 10);
    expect(hand.position.asArray()).toEqual([5, 0, 0]);
    applyPoseClip(poseRigFor(clips), walk, 10);
    expect(hand.position.asArray()).toEqual([0, 1, 0]);
    expect(hip.position.x).toBe(3);
    // A replaced list builds a fresh rig, which rests the hip its first pose leaves out.
    applyPoseClip(poseRigFor([...clips]), wave, 0);
    expect(hip.position.x).toBe(0);
  });

  it("writes only what changed: nothing for an unchanged pose, and not a property that holds its value", () => {
    const hip = new TransformNode("hip", scene);
    const hand = new TransformNode("hand", scene);
    const held = new Animation("held", "position", 30, Animation.ANIMATIONTYPE_VECTOR3);
    held.setKeys([{ frame: 0, value: new Vector3(1, 2, 3) }, { frame: 10, value: new Vector3(1, 2, 3) }]);
    const clip = bindPoseClip(group("Wave", [[positionX("wave", [[0, 0], [10, 5]]), hand], [held, hip]]), undefined);
    const rig = poseRigFor([clip]);
    applyPoseClip(rig, clip, 2);
    const hipDirty = vi.spyOn(hip, "markAsDirty");
    const handDirty = vi.spyOn(hand, "markAsDirty");
    applyPoseClip(rig, clip, 2);
    expect(handDirty).not.toHaveBeenCalled();
    applyPoseClip(rig, clip, 4);
    expect(handDirty).toHaveBeenCalledTimes(1);
    expect(hand.position.x).toBe(2);
    expect(hipDirty).not.toHaveBeenCalled();
    expect(hip.position.asArray()).toEqual([1, 2, 3]);
  });

  it("writes every property again once invalidated, after something else moved the nodes", () => {
    const hand = new TransformNode("hand", scene);
    const clip = bindPoseClip(group("Wave", [[positionX("wave", [[0, 0], [10, 5]]), hand]]), undefined);
    const clips = [clip];
    applyPoseClip(poseRigFor(clips), clip, 4);
    hand.position.x = 9;
    applyPoseClip(poseRigFor(clips), clip, 4);
    expect(hand.position.x).toBe(9);
    invalidatePoseRig(clips);
    applyPoseClip(poseRigFor(clips), clip, 4);
    expect(hand.position.x).toBe(2);
  });

  it("samples correctly when a clip jumps back or skips keys", () => {
    const node = new TransformNode("node", scene);
    const animation = positionX("walk", [[0, 0], [2, 1], [4, -1], [6, 3], [8, 0], [10, 2]]);
    const clip = bindPoseClip(group("Walk", [[animation, node]]), undefined);
    const rig = poseRigFor([clip]);
    for (const frame of [0.5, 1.5, 2.5, 9.5, 3, 0.1, 7.9, 8.1, 5]) {
      applyPoseClip(rig, clip, frame);
      expect(node.position.x).toBeCloseTo((animation.evaluate(frame) as Vector3).x, 12);
    }
  });

  it("writes a channel's current target after its node is handed over", () => {
    const leaf = new TransformNode("leaf", scene);
    const member = new TransformNode("member", scene);
    const babylonGroup = group("Wave", [[positionX("wave", [[0, 0], [10, 4]]), leaf]]);
    const clip = bindPoseClip(babylonGroup, undefined);
    handOverNode(scene, leaf, member, [babylonGroup]);
    applyPoseClip(poseRigFor([clip]), clip, 5);
    expect(member.position.x).toBe(2);
    expect(leaf.position.x).toBe(0);
  });

  it("poses a Bone through its setters, so its local matrix recomposes", () => {
    const skeleton = new Skeleton("skeleton", "skeleton", scene);
    const bone = new Bone("arm", skeleton, null, Matrix.Identity());
    const clip = bindPoseClip(group("Reach", [[positionX("reach", [[0, 0], [10, 6]]), bone]]), undefined);
    applyPoseClip(poseRigFor([clip]), clip, 5);
    expect(bone.getLocalMatrix().getTranslation().x).toBeCloseTo(3);
  });

  it("assigns morph target influences", () => {
    const smile = new MorphTarget("smile", 0, scene);
    const animation = new Animation("smile", "influence", 30, Animation.ANIMATIONTYPE_FLOAT);
    animation.setKeys([{ frame: 0, value: 0 }, { frame: 10, value: 1 }]);
    const clip = bindPoseClip(group("Smile", [[animation, smile]]), undefined);
    const rig = poseRigFor([clip]);
    applyPoseClip(rig, clip, 7.5);
    expect(smile.influence).toBeCloseTo(0.75);
    applyPose(rig, 0, [], [], []);
    expect(smile.influence).toBe(0);
  });
});
