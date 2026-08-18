import { afterEach, describe, expect, it } from "vitest";
import { Animation } from "@babylonjs/core/Animations/animation";
import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Quaternion } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import {
  createLinkedSkeletonFromNodeRig,
  ensureNodeRotationQuaternion,
  retargetAnimationGroupWithMeshProxy,
  withTransformNodeAnimationTargets,
} from "./node-rig";

function makeScene(): { engine: NullEngine; scene: Scene } {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  return { engine, scene };
}

function makeHierarchy(scene: Scene) {
  const root = new TransformNode("character-d", scene);
  const torso = MeshBuilder.CreateBox("torso", { size: 0.4 }, scene);
  torso.parent = root;
  const arm = MeshBuilder.CreateBox("arm-left", { size: 0.2 }, scene);
  arm.parent = torso;
  return { root, torso, arm };
}

function rotationClip(scene: Scene, target: TransformNode, name: string) {
  const animation = new Animation(
    `${name}-rot`,
    "rotationQuaternion",
    30,
    Animation.ANIMATIONTYPE_QUATERNION,
    Animation.ANIMATIONLOOPMODE_CYCLE,
  );
  animation.setKeys([
    { frame: 0, value: Quaternion.Identity() },
    { frame: 30, value: Quaternion.FromEulerAngles(0, Math.PI / 2, 0) },
  ]);
  const group = new AnimationGroup(name, scene);
  group.addTargetedAnimation(animation, target);
  return group;
}

describe("node-rig helpers", () => {
  const engines: NullEngine[] = [];
  afterEach(() => {
    while (engines.length > 0) engines.pop()?.dispose();
  });

  it("includes Mesh nodes in a linked skeleton and leaves character meshes unskinned", () => {
    const { engine, scene } = makeScene();
    engines.push(engine);
    const { root, torso, arm } = makeHierarchy(scene);
    const { skeleton, overlay } = createLinkedSkeletonFromNodeRig(root, {
      createMesh: true,
    });
    expect(skeleton.bones.map((bone) => bone.name)).toEqual(
      expect.arrayContaining(["character-d", "torso", "arm-left"]),
    );
    expect(torso.skeleton).toBeNull();
    expect(arm.skeleton).toBeNull();
    expect(overlay?.skeleton).toBe(skeleton);
    expect(overlay?.getVerticesData("matricesIndices")).not.toBeNull();
  });

  it("ensures rotationQuaternion so Mesh parts can become bones", () => {
    const { engine, scene } = makeScene();
    engines.push(engine);
    const mesh = MeshBuilder.CreateBox("head", { size: 0.2 }, scene);
    expect(mesh.rotationQuaternion).toBeNull();
    ensureNodeRotationQuaternion(mesh);
    expect(mesh.rotationQuaternion).not.toBeNull();
  });

  it("proxies Mesh animation targets to TransformNodes", () => {
    const { engine, scene } = makeScene();
    engines.push(engine);
    const { torso } = makeHierarchy(scene);
    const group = rotationClip(scene, torso, "idle");
    expect(group.targetedAnimations[0]!.target.getClassName()).toBe("Mesh");
    const { group: proxied, dispose } = withTransformNodeAnimationTargets(group);
    expect(proxied.targetedAnimations[0]!.target.getClassName()).toBe(
      "TransformNode",
    );
    expect(proxied.targetedAnimations[0]!.target.name).toBe("torso");
    dispose();
  });

  it("keeps matching channels when retargeting Mesh-targeted clips", () => {
    const { engine, scene } = makeScene();
    engines.push(engine);
    const source = makeHierarchy(scene);
    const target = makeHierarchy(scene);
    target.root.name = "target-root";
    target.torso.name = "torso";
    target.arm.name = "arm-left";
    createLinkedSkeletonFromNodeRig(target.root, { createMesh: true });
    const group = rotationClip(scene, source.torso, "idle");
    const retargeted = retargetAnimationGroupWithMeshProxy(group, target.root);
    expect(retargeted).not.toBeNull();
    expect(retargeted!.targetedAnimations.length).toBeGreaterThan(0);
    expect(retargeted!.targetedAnimations[0]!.target.name).toBe("torso");
    retargeted!.dispose();
  });

  it("returns null when no channel names match", () => {
    const { engine, scene } = makeScene();
    engines.push(engine);
    const source = MeshBuilder.CreateBox("foreign", { size: 0.3 }, scene);
    const target = makeHierarchy(scene);
    createLinkedSkeletonFromNodeRig(target.root, { createMesh: true });
    const group = rotationClip(scene, source, "spin");
    expect(retargetAnimationGroupWithMeshProxy(group, target.root)).toBeNull();
  });
});
