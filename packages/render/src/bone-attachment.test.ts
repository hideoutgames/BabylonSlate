import { Bone, Matrix, Mesh, Quaternion, Skeleton, TransformNode, Vector3 } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { SNAPSHOT_FLAG_VISIBLE, type ActorSlot } from "@babylonslate/bridge";
import { createTestEngine } from "./create-null-engine";
import * as snapshot from "./snapshot-apply";

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
    childSlot.scale = { x: 3, y: 3, z: 3 };
    attach("Hand.R");
    apply();
    expect(child.getAbsolutePosition().asArray()).toEqual([6, 2, 0]);
    expect(child.getWorldMatrix().getScaleVector().asArray()).toEqual([6, 6, 6]);
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
