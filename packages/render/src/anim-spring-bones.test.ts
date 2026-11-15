import { Animation } from "@babylonjs/core/Animations/animation";
import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { normalizeAnimSpringBoneSettings, type AnimSpringBonesChange } from "@haptic/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPose, bindPoseClip, poseRigFor, type PoseClip, type PoseRig } from "./anim-pose";
import { springChainPositions } from "./anim-spring-bones";
import { attachSkeletalControlPreview } from "./skeletal-control-preview";

let engine: NullEngine;
let scene: Scene;
let nodes: Record<"actor" | "hips" | "spine" | "arm" | "hand" | "leg", TransformNode>;
let rig: { clips: PoseClip[]; rig: PoseRig } | null = null;

/** actor → hips → spine → arm → hand, and hips → leg; the spine turned so the arm and hand reach along +X. */
function build(): void {
  rig = null;
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
  spine.rotationQuaternion = Quaternion.RotationAxis(Vector3.Forward(), -Math.PI / 2);
  const arm = make("arm", spine);
  nodes = { actor, hips, spine, arm, hand: make("hand", arm), leg: make("leg", hips) };
}

beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  build();
});

afterEach(() => {
  rig = null;
  scene.dispose();
  engine.dispose();
});

function legClip(): PoseClip {
  const group = new AnimationGroup("idle", scene);
  const animation = new Animation("idle-leg", "position", 30, Animation.ANIMATIONTYPE_VECTOR3);
  animation.setKeys([{ frame: 0, value: new Vector3(0, 1, 0) }, { frame: 10, value: new Vector3(0, 1, 0) }]);
  group.addTargetedAnimation(animation, nodes.leg);
  return bindPoseClip(group, "idle");
}

const springs = (data: Record<string, unknown> = {}, dtSeconds = 1 / 60, alpha = 1): AnimSpringBonesChange => ({
  kind: "springBones", bone: "spine", alpha, dtSeconds, settings: normalizeAnimSpringBoneSettings(data),
});

/** Poses the test's rig `ticks` times with the change. */
function pose(change: AnimSpringBonesChange | null, ticks = 1): void {
  if (!rig) {
    const clips = [legClip()];
    rig = { clips, rig: poseRigFor(clips) };
  }
  for (let i = 0; i < ticks; i++) {
    applyPose(rig.rig, 1, rig.clips, [0], [1], change ? { masks: [], blends: [], modifiers: [change] } : null);
  }
}

function actorAt(node: TransformNode): Vector3 {
  const inverseRoot = nodes.actor.computeWorldMatrix(true).clone().invert();
  return node.computeWorldMatrix(true).multiply(inverseRoot).getTranslation();
}

const chain = () => springChainPositions(rig!.rig, "spine");

describe("Spring Bones", () => {
  it("droops under gravity, keeping each bone's length, and the bones follow the particles", () => {
    pose(springs({ stiffness: 0, damping: 0.01, gravity: [0, -9.8, 0], worldDampingLocation: 1, worldDampingRotation: 1 }), 60);
    const [spine, arm, hand] = chain();
    expect(hand!.y).toBeLessThan(spine!.y - 0.5);
    expect(Vector3.Distance(spine!, arm!)).toBeCloseTo(1, 5);
    expect(Vector3.Distance(arm!, hand!)).toBeCloseTo(1, 5);
    // The written rotations put the hand where its particle is.
    expect(Vector3.Distance(actorAt(nodes.hand), hand!)).toBeLessThan(1e-4);
    // The root stays where the pose has it.
    expect(Vector3.Distance(actorAt(nodes.spine), spine!)).toBeLessThan(1e-6);
  });

  it("holds the pose at full Stiffness", () => {
    pose(springs({ stiffness: 1, gravity: [0, -9.8, 0] }), 30);
    expect(actorAt(nodes.hand).asArray().map((v) => Number(v.toFixed(4)) + 0)).toEqual([2, 2, 0]);
  });

  it("trails the actor's movement unless World Damping ignores it", () => {
    const move = (damping: number) => {
      build();
      pose(springs({ stiffness: 0.02, damping: 0.05, worldDampingLocation: damping }), 2);
      nodes.actor.position.z += 0.5;
      pose(springs({ stiffness: 0.02, damping: 0.05, worldDampingLocation: damping }));
      return chain()[2]!.z;
    };
    // Moving +Z, a chain that keeps its place in the world lags behind in actor space.
    expect(move(0)).toBeLessThan(-0.05);
    expect(move(1)).toBeCloseTo(0, 6);
  });

  it("resets to the pose when the actor teleports", () => {
    const change = springs({ stiffness: 0, damping: 0.01, gravity: [0, -9.8, 0], teleportDistance: 2 });
    pose(change, 30);
    expect(chain()[2]!.y).toBeLessThan(1.5);
    nodes.actor.position.x += 5;
    pose(change);
    // Reset, then one tick of fall: still near the pose.
    expect(chain()[2]!.y).toBeGreaterThan(1.95);
  });

  it("stays outside a sphere collider", () => {
    pose(springs({
      stiffness: 0, damping: 0.01, gravity: [0, -9.8, 0], radius: 0.05,
      colliders: [{ kind: "sphere", bone: "hips", offset: [1.5, 0.6, 0], radius: 0.5 }],
    }), 90);
    const center = actorAt(nodes.hips).add(new Vector3(1.5, 0.6, 0));
    for (const at of chain().slice(1)) expect(Vector3.Distance(at, center)).toBeGreaterThan(0.55 - 1e-4);
  });

  it("turns no further than Limit Angle from the pose", () => {
    pose(springs({ stiffness: 0, damping: 0.01, gravity: [0, -9.8, 0], limitDegrees: 15 }), 90);
    const [spine, arm] = chain();
    const angle = Math.acos(Vector3.Dot(arm!.subtract(spine!).normalize(), Vector3.Right())) * (180 / Math.PI);
    expect(angle).toBeLessThan(15.01);
    expect(angle).toBeGreaterThan(5);
  });

  it("keeps a locked axis with Planar Constraint, and blows with the wind", () => {
    pose(springs({ stiffness: 0, windDirection: [0, 0, 1], windStrength: 20, planarConstraint: "z" }), 30);
    expect(Math.abs(chain()[2]!.z)).toBeLessThan(1e-6);
    build();
    pose(springs({ stiffness: 0, windDirection: [0, 0, 1], windStrength: 20 }), 30);
    expect(chain()[2]!.z).toBeGreaterThan(0.2);
  });

  it("leaves excluded branches out, and adds a tip past the last bone", () => {
    pose(springs({ excludeBones: ["hand"] }));
    expect(chain()).toHaveLength(2);
    build();
    pose(springs({ tipLength: 0.5 }));
    expect(chain()).toHaveLength(4);
    expect(chain()[3]!.x).toBeCloseTo(2.5, 5);
  });

  it("steps only by tick time: a pose with no time leaves the chain where it was", () => {
    pose(springs({ stiffness: 0, gravity: [0, -9.8, 0] }), 10);
    const before = chain()[2]!.clone();
    pose(springs({ stiffness: 0, gravity: [0, -9.8, 0] }, 0));
    expect(Vector3.Distance(chain()[2]!, before)).toBeLessThan(1e-9);
  });

  it("draws its colliders in the Preview", () => {
    const preview = attachSkeletalControlPreview(nodes.actor, scene);
    preview.update([springs({ colliders: [
      { kind: "sphere", bone: "hips" }, { kind: "capsule", bone: "spine", length: 0.4 }, { kind: "plane", bone: "leg" },
    ] })]);
    expect(preview.colliderCount).toBe(3);
    preview.update([]);
    expect(preview.colliderCount).toBe(0);
    preview.dispose();
  });
});
