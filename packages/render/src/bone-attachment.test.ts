import { Bone, Matrix, Mesh, Quaternion, Skeleton, SpotLight, TransformNode, UniversalCamera, Vector3 } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { isPlayEngineCommandType, readActorSlot, readSnapshotHeader, snapshotFloatCount, SNAPSHOT_FLAG_VISIBLE, type ActorSlot } from "@babylonslate/bridge";
import { createInProcessRuntime } from "../../runtime/src/driver";
import { createTestEngine } from "./create-null-engine";
import * as snapshot from "./snapshot-apply";
import * as attachments from "./bone-attachment";
import { writeSampledAudioPoses, type SampledAudioPose } from "./snapshot-sync";

const handles: ReturnType<typeof createTestEngine>[] = [];
afterEach(() => { for (const { scene, engine } of handles.splice(0)) { scene.dispose(); engine.dispose(); } });

function fixture() {
  const handle = createTestEngine();
  handles.push(handle);
  const binding = snapshot.createSnapshotSceneBinding();
  const child = new Mesh("actor-1", handle.scene);
  const target = new Mesh("actor-2", handle.scene);
  binding.meshes.set(1, child);
  binding.meshes.set(2, target);
  const actor = (slotId: number): ActorSlot => ({ slotId, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 }, flags: SNAPSHOT_FLAG_VISIBLE });
  const childSlot = actor(1);
  const targetSlot = actor(2);
  const apply = () => snapshot.applySnapshotToScene(handle.scene, binding, { actors: [childSlot, targetSlot], actorCount: 2, alpha: 1, frameId: 1, tickIndex: 1 });
  const attach = (name: string) => {
    expect(snapshot.applyAttachToBone).toBeTypeOf("function");
    snapshot.applyAttachToBone(binding, { type: "attachToBone", slotId: 1, targetSlotId: 2, boneName: name });
  };
  return { ...handle, binding, child, target, childSlot, targetSlot, apply, attach };
}

describe("render bone attachment", () => {
  it("updates spatial audio poses from animated attachments while keeping other emitters unchanged", () => {
    const { scene, binding, target, childSlot, targetSlot, attach, apply } = fixture();
    const hand = new TransformNode("Hand", scene);
    hand.parent = target;
    hand.position.y = 3;
    hand.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), Math.PI / 2);
    targetSlot.position.x = 10;
    childSlot.position.x = 10;
    attach("Hand");
    apply();
    const poses: SampledAudioPose[] = [];
    writeSampledAudioPoses({ actors: [childSlot, targetSlot], actorCount: 2 }, poses);
    expect(attachments.applyBoneAttachmentAudioPoses).toBeTypeOf("function");
    attachments.applyBoneAttachmentAudioPoses(binding, poses);
    expect(poses[0]!.position.y).toBeCloseTo(3);
    expect(poses[0]!.position.qy).toBeCloseTo(Math.SQRT1_2);
    expect(poses[1]!.position).toEqual({ x: 10, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 });
    hand.position.y = 5;
    apply();
    attachments.applyBoneAttachmentAudioPoses(binding, poses);
    expect(poses[0]!.position.y).toBeCloseTo(5);
  });

  it.each(["light:spot", "camera"])("moves attached %s components with the bone and their component offset", (meshKind) => {
    const { scene, binding, target, targetSlot, childSlot, attach, apply } = fixture();
    snapshot.applyAssignMesh(scene, binding, {
      type: "assignMesh", slotId: 1, meshAssetGuid: null, meshKind,
      parts: [{ componentId: "component", meshKind, meshAssetGuid: null, position: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }],
    });
    const hand = new TransformNode("Hand", scene);
    hand.parent = target;
    hand.position.y = 2;
    hand.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), Math.PI / 2);
    targetSlot.position.x = 10;
    childSlot.position.x = 10;
    attach("Hand");
    apply();
    const entity = meshKind === "camera" ? binding.cameras.get(1) as UniversalCamera : binding.lights.get(1) as SpotLight;
    expect(entity.position.x).toBeCloseTo(10);
    expect(entity.position.y).toBeCloseTo(2);
    expect(entity.position.z).toBeCloseTo(-1);
    if (entity instanceof SpotLight) expect(entity.direction.x).toBeCloseTo(1);
    else expect(entity.rotationQuaternion!.y).toBeCloseTo(Math.SQRT1_2);
    hand.position.y = 4;
    apply();
    expect(entity.position.y).toBeCloseTo(4);
  });

  it("routes a runtime attachment and composes its published world snapshot exactly once", async () => {
    const { scene, binding, target, child } = fixture();
    binding.meshes.clear();
    binding.meshes.set(0, target);
    binding.meshes.set(1, child);
    const hand = new TransformNode("Hand", scene);
    hand.parent = target;
    hand.position.y = 2;
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, onCommand: (command) => {
      if (isPlayEngineCommandType(command.type) && command.type === "attachToBone") snapshot.applyAttachToBone(binding, command);
    } });
    try {
      await runtime.loadScripts([
        { assetGuid: "hero", classId: "Hero", parentClassId: "Actor", source: "", anchors: [], entryPoints: [] },
        { assetGuid: "item", classId: "Item", parentClassId: "Actor", source: 'export function onBeginPlay(ctx) { ctx.attachToBone(null, ctx.getActorOfClass("Hero"), "Hand"); }', anchors: [], entryPoints: [{ name: "onBeginPlay", event: "onBeginPlay", isAsync: false }] },
      ]);
      const actor = runtime.spawnScriptedActor({ classId: "Hero", transform: { position: { x: 10, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }, scale: { x: 2, y: 2, z: 2 } } })!;
      runtime.spawnScriptedActor({ classId: "Item" });
      runtime.start();
      const renderTick = () => {
        runtime.tick();
        const buffer = new Float32Array(snapshotFloatCount(runtime.snapshotCapacity));
        expect(runtime.copySnapshot(buffer)).toBe(true);
        const header = readSnapshotHeader(buffer);
        const actors = Array.from({ length: header.actorCount }, (_, index) => readActorSlot(buffer, index));
        snapshot.applySnapshotToScene(scene, binding, { actors, actorCount: actors.length, frameId: header.frameId, tickIndex: header.tickIndex, alpha: 1 });
      };
      renderTick();
      expect(child.getAbsolutePosition().x).toBeCloseTo(6);
      actor.transform.position.x = 20;
      hand.position.y = 3;
      renderTick();
      expect(child.getAbsolutePosition().x).toBeCloseTo(14);
    } finally { runtime.stop(); }
  });

  it("follows a hidden skin on a later model component through bone animation and target transforms", () => {
    const { scene, target, child, childSlot, targetSlot, attach, apply } = fixture();
    const unrelated = new Mesh("body", scene);
    unrelated.parent = target;
    unrelated.skeleton = new Skeleton("unrelated", "unrelated", scene);
    new Bone("Head", unrelated.skeleton);
    const skin = new Mesh("hands", scene);
    skin.parent = target;
    skin.position.x = 1;
    skin.isVisible = false;
    const skeleton = new Skeleton("hands", "hands", scene);
    skin.skeleton = skeleton;
    const hand = new Bone("Hand.R", skeleton, null, Matrix.Translation(0, 2, 0));
    targetSlot.position.x = 10;
    targetSlot.rotation = { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 };
    targetSlot.scale = { x: 2, y: 2, z: 2 };
    // Runtime snapshots already compose the actor's ordinary parent transform.
    childSlot.position = { ...targetSlot.position };
    childSlot.rotation = { ...targetSlot.rotation };
    childSlot.scale = { x: 6, y: 6, z: 6 };
    attach("Hand.R");
    apply();
    expect(child.getAbsolutePosition().asArray()).toEqual([6, 2, 0]);
    const scale = new Vector3();
    child.getWorldMatrix().decompose(scale);
    expect(scale.asArray()).toEqual([6, 6, 6]);
    hand.setPosition(new Vector3(0, 4, 0));
    apply();
    expect(child.getAbsolutePosition().x).toBeCloseTo(2);
    expect(child.parent).toBeNull();
  });

  it("attaches to linked and hierarchy bones using their world transforms and keeps snapshot offsets local", () => {
    const { scene, target, child, childSlot, targetSlot, attach, apply } = fixture();
    const hand = new TransformNode("Hand", scene);
    hand.parent = target;
    hand.position.set(1, 2, 0);
    hand.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), Math.PI / 2);
    targetSlot.position.x = 10;
    childSlot.position.x = 10;
    childSlot.position.z = 2;
    attach("Hand");
    apply();
    expect(child.getAbsolutePosition().x).toBeCloseTo(13);
    expect(child.getAbsolutePosition().y).toBeCloseTo(2);
    const skeleton = new Skeleton("skin", "skin", scene);
    target.skeleton = skeleton;
    const bone = new Bone("LinkedHand", skeleton);
    bone.linkTransformNode(hand);
    attach("LinkedHand");
    hand.position.x = 3;
    apply();
    expect(child.getAbsolutePosition().x).toBeCloseTo(15);
  });

  it("waits for model loading, survives replacement, and clears stale bindings on detach and target retirement", () => {
    const { scene, binding, target, child, attach, apply } = fixture();
    attach("Hand");
    apply();
    expect(child.getAbsolutePosition().asArray()).toEqual([0, 0, 0]);
    const hand = new TransformNode("Hand", scene);
    hand.parent = target;
    hand.position.x = 4;
    apply();
    expect(child.getAbsolutePosition().x).toBe(4);
    hand.dispose();
    const replacement = new TransformNode("Hand", scene);
    replacement.parent = target;
    replacement.position.x = 8;
    apply();
    expect(child.getAbsolutePosition().x).toBe(8);
    snapshot.applyAttachToBone(binding, { type: "attachToBone", slotId: 1, targetSlotId: null, boneName: "" });
    apply();
    expect(child.getAbsolutePosition().x).toBe(0);
    attach("Hand");
    apply();
    snapshot.retirePlaySlot(binding, 2);
    expect(child.isDisposed()).toBe(false);
    expect(binding.boneAttachments.size).toBe(0);
    snapshot.disposeSnapshotBinding(binding);
    expect(binding.boneAttachments.size).toBe(0);
  });
});
