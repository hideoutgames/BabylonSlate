import { Animation } from "@babylonjs/core/Animations/animation";
import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { normalizeAnimFootPlacement, type AnimFootPlacementChange } from "@haptic/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shareFootPlacementBounds } from "./anim-foot-placement";
import { applyPose, bindPoseClip, poseRigFor, type PoseClip, type PoseRig } from "./anim-pose";

let engine: NullEngine;
let scene: Scene;
let nodes: Record<string, TransformNode>;
let rig: { clips: PoseClip[]; rig: PoseRig } | null = null;

/**
 * actor → hips (1 up) → upperleg.l / upperleg.r (0.2 to each side) → lowerleg (0.45 down, a little forward) → foot
 * (0.45 down): each ankle 0.1 above the actor's ground, its knee bent forward.
 */
beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  const make = (name: string, parent: TransformNode | null, position: [number, number, number]) => {
    const node = new TransformNode(name, scene);
    node.parent = parent;
    node.position.set(...position);
    node.rotationQuaternion = Quaternion.Identity();
    return node;
  };
  const actor = make("actor-1", null, [0, 0, 0]);
  const hips = make("hips", actor, [0, 1, 0]);
  nodes = { actor, hips };
  for (const [side, x] of [["l", 0.2], ["r", -0.2]] as const) {
    const upper = make(`upperleg.${side}`, hips, [x, 0, 0]);
    const lower = make(`lowerleg.${side}`, upper, [0, -0.45, 0.05]);
    nodes[`foot.${side}`] = make(`foot.${side}`, lower, [0, -0.45, -0.05]);
  }
});

afterEach(() => {
  rig = null;
  scene.dispose();
  engine.dispose();
});

/** A box whose top is at `top`, spanning X from `x0` to `x1`. */
function ground(name: string, x0: number, x1: number, top: number, tiltDegrees = 0) {
  const box = CreateBox(name, { width: x1 - x0, height: 1, depth: 4 }, scene);
  box.position.set((x0 + x1) / 2, top - 0.5, 0);
  if (tiltDegrees) box.rotationQuaternion = Quaternion.RotationAxis(Vector3.Forward(), (tiltDegrees * Math.PI) / 180);
  box.computeWorldMatrix(true);
  return box;
}

function place(data: Record<string, unknown>): void {
  if (!rig) {
    const group = new AnimationGroup("idle", scene);
    const animation = new Animation("idle-hips", "position", 30, Animation.ANIMATIONTYPE_VECTOR3);
    animation.setKeys([{ frame: 0, value: new Vector3(0, 1, 0) }, { frame: 10, value: new Vector3(0, 1, 0) }]);
    group.addTargetedAnimation(animation, nodes.hips!);
    const clips = [bindPoseClip(group, "idle")];
    rig = { clips, rig: poseRigFor(clips) };
  }
  const change: AnimFootPlacementChange = {
    kind: "footPlacement", bone: "foot.l", alpha: 1, ...normalizeAnimFootPlacement({ feet: ["foot.l", "foot.r"], pelvisBone: "hips", ...data }),
  };
  applyPose(rig.rig, 1, rig.clips, [0], [1], { masks: [], blends: [], modifiers: [change] });
}

const at = (name: string) => {
  const node = nodes[name]!;
  node.computeWorldMatrix(true);
  return node.getAbsolutePosition();
};

describe("Foot Placement", () => {
  it("lifts a foot onto a step and leaves the other on the floor", () => {
    ground("floor", -1, 0, 0);
    ground("step", 0, 1, 0.3);
    place({});
    expect(at("foot.l").y).toBeCloseTo(0.4, 4);
    expect(at("foot.r").y).toBeCloseTo(0.1, 4);
    // Neither foot was lower than the actor's ground: the pelvis stays.
    expect(at("hips").y).toBeCloseTo(1, 6);
    expect(at("foot.l").x).toBeCloseTo(0.2, 4);
  });

  it("drops the pelvis so a foot over lower ground reaches it", () => {
    ground("floor", -1, 0, -0.2);
    ground("step", 0, 1, 0);
    place({});
    expect(at("hips").y).toBeCloseTo(0.8, 4);
    expect(at("foot.r").y).toBeCloseTo(-0.1, 4);
    expect(at("foot.l").y).toBeCloseTo(0.1, 4);
  });

  it("turns a foot to a slope, and leaves it upright without Align To Ground", () => {
    ground("slope", -1, 1, 0, 20);
    place({ traceUp: 1, traceDown: 1 });
    const up = () => Vector3.TransformNormal(Vector3.Up(), nodes["foot.l"]!.computeWorldMatrix(true)).normalize();
    const normal = Vector3.TransformNormal(Vector3.Up(), scene.getMeshByName("slope")!.computeWorldMatrix(true)).normalize();
    expect(Vector3.Dot(up(), normal)).toBeCloseTo(1, 4);
    place({ traceUp: 1, traceDown: 1, alignToGround: false });
    expect(up().y).toBeCloseTo(1, 4);
  });

  it("ignores the actor's own meshes and leaves a foot with no ground below as posed", () => {
    const own = ground("own", 0, 1, 0.3);
    own.parent = nodes.actor!;
    own.computeWorldMatrix(true);
    place({});
    expect(at("foot.l").y).toBeCloseTo(0.1, 4);
    expect(at("hips").y).toBeCloseTo(1, 6);
  });

  it("does not stand on a skinned mesh, whose triangles a trace meets in their bind pose", () => {
    ground("floor", -1, 1, 0);
    const other = ground("other-actor-body", 0, 1, 0.3);
    other.skeleton = new Skeleton("other-actor", "other-actor", scene);
    place({});
    expect(at("foot.l").y).toBeCloseTo(0.1, 4);
  });

  it("stands on a pickable thin-instanced mesh's instances, where they are, turned to their slope", () => {
    ground("floor", -1, 1, 0);
    engine.getCaps().instancedArrays = true;
    // Its own place is far off; its one instance is a step under the left foot, tilted about the forward axis.
    const slab = CreateBox("slab", { width: 1, height: 0.3, depth: 4 }, scene);
    slab.position.set(10, 0, 0);
    const tilt = Quaternion.RotationAxis(Vector3.Forward(), (10 * Math.PI) / 180);
    slab.thinInstanceAdd(Matrix.Compose(Vector3.One(), tilt, new Vector3(-9.5, 0.15, 0)));
    slab.thinInstanceEnablePicking = true;
    slab.thinInstanceRefreshBoundingInfo(true);
    slab.computeWorldMatrix(true);
    place({});
    // The instance's top plane: through its turned top centre, facing its turned up axis; the ankle sits 0.1 above.
    const normal = Vector3.Up().applyRotationQuaternion(tilt);
    const centre = new Vector3(0.5, 0.15, 0).addInPlace(new Vector3(0, 0.15, 0).applyRotationQuaternion(tilt));
    expect(at("foot.l").y).toBeCloseTo(centre.y - (normal.x * (0.2 - centre.x)) / normal.y + 0.1, 4);
    expect(at("foot.r").y).toBeCloseTo(0.1, 4);
    const footUp = Vector3.TransformNormal(Vector3.Up(), nodes["foot.l"]!.computeWorldMatrix(true)).normalize();
    expect(Vector3.Dot(footUp, Vector3.Up().applyRotationQuaternion(tilt))).toBeCloseTo(1, 4);
  });

  it("poses the feet as animated again once the control stops", () => {
    ground("floor", -1, 0, 0);
    ground("step", 0, 1, 0.3);
    place({});
    expect(at("foot.l").y).toBeCloseTo(0.4, 4);
    // The same clip at the same frame, without the control.
    applyPose(rig!.rig, 1, rig!.clips, [0], [1], null);
    expect(at("foot.l").y).toBeCloseTo(0.1, 6);
  });
});

describe("Foot Placement with shared bounds", () => {
  const nextFrame = () => scene.onBeforeRenderObservable.notifyObservers(scene);

  it("finds ground added during the frame, and ground moved under a foot from the next frame", () => {
    shareFootPlacementBounds(scene);
    ground("floor", -1, 1, 0);
    place({});
    expect(at("foot.l").y).toBeCloseTo(0.1, 4);
    const step = ground("step", 0, 1, 0.3);
    place({});
    expect(at("foot.l").y).toBeCloseTo(0.4, 4);
    // Moved away, it is left at once: each box hit is brought up to date.
    step.position.x = 5;
    step.computeWorldMatrix(true);
    place({});
    expect(at("foot.l").y).toBeCloseTo(0.1, 4);
    // Moved back under the foot, the next frame's bounds find it.
    nextFrame();
    place({});
    step.position.x = 0.5;
    step.computeWorldMatrix(true);
    nextFrame();
    place({});
    expect(at("foot.l").y).toBeCloseTo(0.4, 4);
  });

  it("skips ground disposed during the frame, and traces every mesh again once undone", () => {
    const undo = shareFootPlacementBounds(scene);
    ground("floor", -1, 1, 0);
    const step = ground("step", 0, 1, 0.3);
    place({});
    expect(at("foot.l").y).toBeCloseTo(0.4, 4);
    step.dispose();
    place({});
    expect(at("foot.l").y).toBeCloseTo(0.1, 4);
    undo();
    const moved = ground("late-step", 3, 4, 0.3);
    place({});
    moved.position.x = 0.5;
    moved.computeWorldMatrix(true);
    place({});
    expect(at("foot.l").y).toBeCloseTo(0.4, 4);
  });
});
