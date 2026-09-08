import { afterEach, describe, expect, it } from "vitest";
import { Animation } from "@babylonjs/core/Animations/animation";
import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { Bone } from "@babylonjs/core/Bones/bone";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import {
  attachSkeletonPreview,
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
    expect(skeleton.bones.map((bone) => bone.name)).not.toContain("__root__");
  });

  it("walks descendants of __root__ without creating a __root__ bone", () => {
    const { engine, scene } = makeScene();
    engines.push(engine);
    const loaderRoot = new TransformNode("__root__", scene);
    const { torso } = makeHierarchy(scene);
    torso.parent!.parent = loaderRoot;
    const { skeleton } = createLinkedSkeletonFromNodeRig(loaderRoot, {
      createMesh: true,
    });
    expect(skeleton.bones.map((bone) => bone.name)).toEqual(
      expect.arrayContaining(["character-d", "torso", "arm-left"]),
    );
    expect(skeleton.bones.map((bone) => bone.name)).not.toContain("__root__");
  });

  it("shows the hierarchy alone, follows hidden animated nodes, and restores visibility", () => {
    const { engine, scene } = makeScene();
    engines.push(engine);
    const { root, torso, arm } = makeHierarchy(scene);
    root.position.set(10, 0, 0);
    root.scaling.setAll(2);
    torso.position.y = 1;
    torso.visibility = 0.35;
    arm.position.y = 1;
    arm.isVisible = false;
    void scene.defaultMaterial;
    const originalMeshCount = scene.meshes.length;
    const originalMaterialCount = scene.materials.length;
    const handle = attachSkeletonPreview(root, scene, "hierarchy");
    expect(torso.isVisible).toBe(false);
    expect(arm.isVisible).toBe(false);
    expect(torso.isEnabled()).toBe(true);
    expect(torso.rotationQuaternion).toBeNull();
    expect(handle.boneCount).toBe(3);
    const overlay = root
      .getChildMeshes(false)
      .find((mesh) => mesh.name.endsWith("_overlay"))!;
    const firstBounds = overlay.getHierarchyBoundingVectors(true);
    expect(firstBounds.min.x).toBeGreaterThan(9);
    expect(firstBounds.max.x).toBeLessThan(11);
    expect(firstBounds.max.y).toBeGreaterThan(4);
    expect(firstBounds.max.y).toBeLessThan(5);

    arm.position.y = 3;
    scene.onBeforeRenderObservable.notifyObservers(scene);
    const movedBounds = overlay.getHierarchyBoundingVectors(true);
    expect(movedBounds.max.y).toBeGreaterThan(8);
    expect(movedBounds.max.y).toBeLessThan(9);

    handle.dispose();
    expect(torso.isVisible).toBe(true);
    expect(torso.visibility).toBe(0.35);
    expect(arm.isVisible).toBe(false);
    expect(scene.meshes).toHaveLength(originalMeshCount);
    expect(scene.materials).toHaveLength(originalMaterialCount);
    expect(scene.onBeforeRenderObservable.hasObservers()).toBe(false);
    torso.isVisible = false;
    handle.dispose();
    expect(torso.isVisible).toBe(false);
  });

  it("draws all skins at their mesh transforms while the source meshes stay hidden", () => {
    const { engine, scene } = makeScene();
    engines.push(engine);
    const root = MeshBuilder.CreateBox("root", { size: 0.2 }, scene);
    root.position.x = 10;
    root.scaling.setAll(2);
    const skeleton = new Skeleton("skin-a", "skin-a", scene);
    new Bone("hips", skeleton, null, Matrix.Identity());
    const hand = new Bone(
      "hand",
      skeleton,
      skeleton.bones[0],
      Matrix.Translation(0, 2, 0),
    );
    root.skeleton = skeleton;
    const part = MeshBuilder.CreateBox("part", { size: 0.2 }, scene);
    part.parent = root;
    part.position.x = 3;
    const otherSkeleton = new Skeleton("skin-b", "skin-b", scene);
    new Bone("head", otherSkeleton, null, Matrix.Translation(0, 3, 0));
    part.skeleton = otherSkeleton;
    const handle = attachSkeletonPreview(root, scene, "skin");
    expect(root.isVisible).toBe(false);
    expect(part.isVisible).toBe(false);
    expect(handle.boneCount).toBe(3);
    const overlay = root
      .getChildMeshes(false)
      .find((mesh) => mesh.name.endsWith("_overlay"))!;
    const bounds = overlay.getHierarchyBoundingVectors(true);
    expect(bounds.min.x).toBeGreaterThan(9);
    expect(bounds.max.x).toBeGreaterThan(16);
    expect(bounds.max.x).toBeLessThan(17);
    expect(bounds.max.y).toBeGreaterThan(6);
    expect(bounds.max.y).toBeLessThan(7);

    hand.setPosition(new Vector3(0, 5, 0));
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(overlay.getHierarchyBoundingVectors(true).max.y).toBeGreaterThan(10);
    handle.dispose();
    expect(root.isVisible).toBe(true);
    expect(part.isVisible).toBe(true);
    expect(root.skeleton).toBe(skeleton);
    expect(scene.skeletons).toContain(otherSkeleton);
  });

  it("keeps the source visible when the requested skin has no bones", () => {
    const { engine, scene } = makeScene();
    engines.push(engine);
    const { root, torso } = makeHierarchy(scene);
    const handle = attachSkeletonPreview(root, scene, "skin");
    expect(handle.boneCount).toBe(0);
    expect(torso.isVisible).toBe(true);
    handle.dispose();
  });

  it("follows glTF-linked joints independently of the hidden skin mesh transform", () => {
    const { engine, scene } = makeScene();
    engines.push(engine);
    const root = new TransformNode("__importScale", scene);
    root.position.x = 10;
    root.scaling.setAll(2);
    const mesh = MeshBuilder.CreateBox("skin", {}, scene);
    mesh.parent = root;
    mesh.position.x = 3;
    const joint = new TransformNode("hand", scene);
    joint.parent = root;
    joint.position.y = 2;
    const skeleton = new Skeleton("skin", "skin", scene);
    const bone = new Bone("hand", skeleton, null, Matrix.Identity());
    bone.linkTransformNode(joint);
    mesh.skeleton = skeleton;

    const preview = attachSkeletonPreview(root, scene, "skin");
    const overlay = root
      .getChildMeshes(false)
      .find((part) => part.name.endsWith("_overlay"))!;
    expect(overlay.getHierarchyBoundingVectors(true).max.x).toBeLessThan(11);
    joint.position.y = 4;
    scene.onBeforeRenderObservable.notifyObservers(scene);
    const bounds = overlay.getHierarchyBoundingVectors(true);
    expect(bounds.max.y).toBeGreaterThan(8);
    expect(bounds.max.y).toBeLessThan(9);
    expect(mesh.isVisible).toBe(false);
    preview.dispose();
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
    const { group: proxied, dispose } =
      withTransformNodeAnimationTargets(group);
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
    expect(retargeted!.name).toBe("idle");
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
