import { Animation, AnimationGroup, Bone, Matrix, Mesh, Quaternion, Skeleton, TransformNode, Vector3 } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createTestEngine } from "./create-null-engine";
import { createSnapshotSceneBinding, retirePlaySlot } from "./snapshot-apply";
import { RagdollPoseController, type RagdollCaptureResult } from "./ragdoll-pose";
import { applyAnimStateToScene, sceneAnimHostFromBinding } from "./anim-apply";

const handles: ReturnType<typeof createTestEngine>[] = [];
afterEach(() => { for (const { scene, engine } of handles.splice(0)) { scene.dispose(); engine.dispose(); } });

function fixture() {
  const handle = createTestEngine();
  handles.push(handle);
  const binding = createSnapshotSceneBinding();
  const root = new Mesh("actor", handle.scene);
  root.rotationQuaternion = Quaternion.Identity();
  binding.meshes.set(1, root);
  const replies: RagdollCaptureResult[] = [];
  const controller = new RagdollPoseController(binding, (reply) => replies.push(reply));
  binding.ragdoll = controller;
  const capture = (requestId = "first", boneNames: string[] = []) => {
    controller.capture({ type: "captureRagdollPose", slotId: 1, requestId, boneNames });
    controller.update();
    return replies.at(-1)!;
  };
  return { ...handle, binding, root, controller, replies, capture };
}

describe("skeletal ragdoll pose handoff", () => {
  it("captures the animated linked pose and preserves world-space physics under a moving actor root", () => {
    const { scene, root, controller, capture } = fixture();
    root.position.x = 10;
    const hips = new TransformNode("Hips", scene);
    hips.parent = root;
    hips.position.y = 2;
    const arm = new TransformNode("Arm", scene);
    arm.parent = hips;
    arm.position.x = 1;
    const skeleton = new Skeleton("skin", "skin", scene);
    root.skeleton = skeleton;
    const hipBone = new Bone("Hips", skeleton);
    hipBone.linkTransformNode(hips);
    const armBone = new Bone("Arm", skeleton, hipBone);
    armBone.linkTransformNode(arm);
    const captured = capture();
    expect(captured.error).toBeUndefined();
    expect(captured.bones!.map((bone) => bone.position)).toEqual([{ x: 10, y: 2, z: 0 }, { x: 11, y: 2, z: 0 }]);
    controller.setPose({ type: "setRagdollPose", slotId: 1, requestId: "first", bones: captured.bones!.map((bone) => ({ ...bone, position: { ...bone.position, y: 1 } })) });
    root.position.x = 20;
    root.computeWorldMatrix(true);
    controller.update();
    expect(hips.getAbsolutePosition().asArray()).toEqual([10, 1, 0]);
    expect(arm.getAbsolutePosition().asArray()).toEqual([11, 1, 0]);
    controller.clear({ type: "clearRagdollPose", slotId: 1, requestId: "first" });
    expect(hips.position.asArray()).toEqual([0, 2, 0]);
    expect(arm.position.asArray()).toEqual([1, 0, 0]);
  });

  it("drives unlinked skin bones without changing inverse bind matrices", () => {
    const { scene, root, controller, capture } = fixture();
    root.position.x = 3;
    const skeleton = new Skeleton("skin", "skin", scene);
    root.skeleton = skeleton;
    const hips = new Bone("Hips", skeleton, null, Matrix.Translation(0, 2, 0));
    const hand = new Bone("Hand", skeleton, hips, Matrix.Translation(1, 0, 0));
    const inverseBind = hand.getAbsoluteInverseBindMatrix().clone();
    const captured = capture();
    expect(captured.bones![1]!.position).toEqual({ x: 4, y: 2, z: 0 });
    controller.setPose({ type: "setRagdollPose", slotId: 1, requestId: "first", bones: captured.bones!.map((bone) => ({ ...bone, position: { ...bone.position, z: 5 } })) });
    controller.update();
    expect(hand.getAbsoluteMatrix().getTranslation().asArray()).toEqual([1, 2, 5]);
    expect(hand.getAbsoluteInverseBindMatrix().equals(inverseBind)).toBe(true);
  });

  it("supports reflected GLB coordinate conversion and rejects nonuniform scaled rigs", () => {
    const { scene, root, controller, capture } = fixture();
    root.scaling.set(2, 2, -2);
    const bone = new TransformNode("Root", scene);
    bone.parent = root;
    bone.position.z = 1;
    const captured = capture();
    expect(captured.error).toBeUndefined();
    expect(captured.bones![0]!.position.z).toBe(-2);
    controller.setPose({ type: "setRagdollPose", slotId: 1, requestId: "first", bones: [{ ...captured.bones![0]!, position: { x: 1, y: 2, z: -3 } }] });
    controller.update();
    expect(bone.getAbsolutePosition().asArray()).toEqual([1, 2, -3]);
    controller.clear({ type: "clearRagdollPose", slotId: 1, requestId: "first" });
    root.scaling.y = 3;
    expect(capture("second").error).toMatch(/uniform/);
  });

  it("rejects world shear even when all decomposed scale lengths match", () => {
    const { scene, root, capture } = fixture();
    root.scaling.set(2, 1, Math.sqrt(2.5));
    const bone = new TransformNode("Root", scene);
    bone.parent = root;
    bone.rotationQuaternion = Quaternion.RotationAxis(Vector3.Forward(), Math.PI / 4);
    expect(capture().error).toMatch(/shear/);
  });

  it("ignores stale replies and clears ownership on slot retirement", () => {
    const { scene, root, binding, controller, capture } = fixture();
    const bone = new TransformNode("Root", scene);
    bone.parent = root;
    const old = capture();
    capture("second");
    controller.setPose({ type: "setRagdollPose", slotId: 1, requestId: "first", bones: [{ ...old.bones![0]!, position: { x: 99, y: 0, z: 0 } }] });
    controller.clear({ type: "clearRagdollPose", slotId: 1, requestId: "first" });
    controller.update();
    expect(bone.getAbsolutePosition().x).toBe(0);
    expect(controller.isDriven(1)).toBe(true);
    retirePlaySlot(binding, 1);
    expect(controller.isDriven(1)).toBe(false);
  });

  it("holds physics poses while animation commands arrive and resumes seeking after disable", () => {
    const { scene, root, binding, controller, capture } = fixture();
    const bone = new TransformNode("Root", scene);
    bone.parent = root;
    const animation = new Animation("move", "position", 30, Animation.ANIMATIONTYPE_VECTOR3);
    animation.setKeys([{ frame: 0, value: Vector3.Zero() }, { frame: 30, value: new Vector3(10, 0, 0) }]);
    const group = new AnimationGroup("Walk", scene);
    group.addTargetedAnimation(animation, bone);
    group.start(true);
    group.pause();
    binding.slotAnimationGroups = new Map([[1, [group]]]);
    const host = sceneAnimHostFromBinding(binding, { animationGroups: [group] });
    const command = { type: "animState" as const, slotId: 1, stateId: "walk", clipName: "Walk", normalisedTime: 0.5, blendWeights: { walk: 1 } };
    applyAnimStateToScene(host, command);
    expect(bone.position.x).toBe(5);
    expect(capture().bones![0]!.position.x).toBe(5);
    applyAnimStateToScene(host, { ...command, normalisedTime: 1 });
    controller.update();
    expect(bone.position.x).toBe(5);
    controller.clear({ type: "clearRagdollPose", slotId: 1, requestId: "first" });
    applyAnimStateToScene(host, { ...command, normalisedTime: 1 });
    expect(bone.position.x).toBe(10);
  });

  it("waits for model preparation and captures a settled load whose promise remains registered", async () => {
    const { scene, root, binding, controller, replies, capture } = fixture();
    let resolve!: () => void;
    const load = new Promise<void>((done) => { resolve = done; });
    binding.slotAnimLoads!.set(1, load);
    capture();
    controller.update();
    expect(replies).toHaveLength(0);
    const wrapper = new TransformNode("__importScale", scene);
    wrapper.parent = root;
    const conversion = new TransformNode("__root__", scene);
    conversion.parent = wrapper;
    const bone = new TransformNode("Hips", scene);
    bone.parent = conversion;
    bone.position.y = 2;
    resolve();
    await load;
    controller.update();
    expect(replies).toHaveLength(1);
    expect(replies[0]!.bones).toMatchObject([{ name: "Hips", parentName: null, position: { x: 0, y: 2, z: 0 } }]);
    controller.update();
    expect(replies).toHaveLength(1);
  });

  it("reports failed or missing models and ignores obsolete load results after a new capture", async () => {
    const { scene, root, binding, controller, replies, capture } = fixture();
    let reject!: (error: Error) => void;
    const obsolete = new Promise<void>((_resolve, fail) => { reject = fail; });
    binding.slotAnimLoads!.set(1, obsolete);
    capture("obsolete");
    const current = Promise.resolve();
    binding.slotAnimLoads!.set(1, current);
    const bone = new TransformNode("Hips", scene);
    bone.parent = root;
    capture("current");
    reject(new Error("obsolete model"));
    await current;
    controller.update();
    expect(replies).toHaveLength(1);
    expect(replies[0]!.requestId).toBe("current");
    expect(replies[0]!.error).toBeUndefined();
    const failed = Promise.reject(new Error("source unavailable"));
    binding.slotAnimLoads!.set(1, failed);
    capture("failed");
    await failed.catch(() => {});
    expect(replies.at(-1)).toMatchObject({ requestId: "failed", error: expect.stringContaining("source unavailable") });
    binding.slotAnimLoads!.delete(1);
    binding.meshes.delete(1);
    capture("missing");
    expect(replies.at(-1)).toMatchObject({ requestId: "missing", error: expect.stringContaining("loaded Model") });
  });

  it("rejects replacement generations even when the actor placeholder is reused", () => {
    const { scene, root, binding, controller, replies, capture } = fixture();
    const bone = new TransformNode("Hips", scene);
    bone.parent = root;
    capture();
    binding.slotAnimLoads!.set(1, new Promise<void>(() => {}));
    controller.update();
    expect(replies.at(-1)?.error).toMatch(/model changed/);
    controller.update();
    expect(replies).toHaveLength(2);
    binding.slotAnimLoads!.delete(1);
    capture("second");
    bone.dispose();
    controller.update();
    expect(replies.at(-1)?.error).toMatch(/bones were replaced/);
  });

  it("accepts a connected selected subtree and rejects skipped ancestors", () => {
    const { scene, root, capture } = fixture();
    const hip = new TransformNode("Hip", scene);
    hip.parent = root;
    const knee = new TransformNode("Knee", scene);
    knee.parent = hip;
    const foot = new TransformNode("Foot", scene);
    foot.parent = knee;
    expect(capture("gap", ["Hip", "Foot"]).error).toMatch(/skipped parents/);
    const subtree = capture("subtree", ["Knee", "Foot"]);
    expect(subtree.error).toBeUndefined();
    expect(subtree.bones!.map((bone) => [bone.name, bone.parentName])).toEqual([["Knee", null], ["Foot", "Knee"]]);
  });

  it("preserves animated bones outside a selected ragdoll subtree", () => {
    const { scene, root, binding, capture } = fixture();
    const hip = new TransformNode("Hip", scene);
    hip.parent = root;
    const arm = new TransformNode("Arm", scene);
    arm.parent = hip;
    arm.position.x = 1;
    const animation = new Animation("move", "position", 30, Animation.ANIMATIONTYPE_VECTOR3);
    animation.setKeys([{ frame: 0, value: Vector3.Zero() }, { frame: 30, value: new Vector3(10, 0, 0) }]);
    const group = new AnimationGroup("Walk", scene);
    group.addTargetedAnimation(animation, hip);
    group.start(true);
    group.pause();
    binding.slotAnimationGroups = new Map([[1, [group]]]);
    applyAnimStateToScene(sceneAnimHostFromBinding(binding, { animationGroups: [group] }), {
      type: "animState", slotId: 1, stateId: "walk", clipName: "Walk", normalisedTime: 0.5, blendWeights: { walk: 1 },
    });
    expect(capture("partial", ["Arm"]).bones![0]!.position.x).toBe(6);
    expect(hip.position.x).toBe(5);
  });
});
