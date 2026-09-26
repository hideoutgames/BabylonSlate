import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene, type RagdollBonePose } from "@babylonslate/core";
import type { CommandMessage } from "@babylonslate/bridge";
import { createInProcessRuntime } from "./driver";

const pose: RagdollBonePose[] = [
  { name: "hips", parentName: null, position: { x: 0, y: 5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
  { name: "head", parentName: "hips", position: { x: 0, y: 6, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
];

function fixture(preferSoftwarePhysics = false) {
  const commands: CommandMessage[] = [];
  const scene = createDefaultScene();
  scene.actors = [createActor("hero", "Hero", { classId: "Hero", transform: {
    position: [0, 4, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
  }, components: [
    { id: "model", classId: "MeshComponent", properties: { assetGuid: "character", collisionMode: "none" } },
    { id: "rigid", classId: "RigidBodyComponent", properties: { motionType: "dynamic", mass: 60 } },
    { id: "collider", classId: "ColliderComponent", properties: { shape: { kind: "sphere", radius: 0.3 } } },
    { id: "ragdoll", classId: "RagdollComponent", properties: { enabled: false } },
  ] })];
  const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, playScene: scene, preferSoftwarePhysics,
    onCommand: (command) => commands.push(command),
  });
  return { runtime, commands };
}

function latestCapture(commands: CommandMessage[]) {
  const command = commands.filter((entry) => entry.type === "captureRagdollPose").at(-1);
  if (!command) throw new Error("Expected the runtime to request a skeletal pose");
  return command;
}

async function prepare(runtime: ReturnType<typeof createInProcessRuntime>) {
  await runtime.loadScripts([{
    assetGuid: "hero-script", classId: "Hero", parentClassId: "Actor", anchors: [],
    entryPoints: ["Enable", "Disable", "Impulse"].map((name) => ({ name, event: name, isAsync: false })),
    source: `
      export function Enable(ctx) { ctx.setVariableOn(ctx.getComponentById(ctx.self, "ragdoll"), "enabled", true); }
      export function Disable(ctx) { ctx.setVariableOn(ctx.getComponentById(ctx.self, "ragdoll"), "enabled", false); }
      export function Impulse(ctx) { ctx.callComponentFunction(ctx.getComponentById(ctx.self, "ragdoll"), "addImpulse", { impulse: { x: 60, y: 0, z: 0 }, strength: 1 }); }
    `,
  }]);
  await runtime.loadPhysics();
  runtime.realizePlayWorld();
  runtime.start();
  return runtime.getWorld().findActor("hero")!;
}

describe("skeletal ragdoll runtime lifecycle", () => {
  it("hands the captured pose to worker physics, routes impulses, and restores the ordinary body on disable", async () => {
    const { runtime, commands } = fixture();
    try {
      const actor = await prepare(runtime);
      const meshAssignments = commands.filter((command) => command.type === "assignMesh").length;
      runtime.invokeScriptEvent("Hero", "Enable", actor);
      expect(commands.filter((command) => command.type === "assignMesh")).toHaveLength(meshAssignments);
      const request = latestCapture(commands);
      const backend = runtime.getPhysicsSync()!.getBackend();
      expect(backend.getBodyTransform("body:hero")).not.toBeNull();
      runtime.applyRagdollPoseCaptured({ type: "ragdollPoseCaptured", slotId: request.slotId, requestId: request.requestId, bones: pose });
      expect(backend.getBodyTransform("body:hero")).toBeNull();
      expect(backend.listDebugColliders()).toHaveLength(2);
      expect(backend.sphereOverlap({ x: 0, y: 5, z: 0 }, 0.2).actorIds).toContain("hero");
      runtime.invokeScriptEvent("Hero", "Impulse", actor);
      for (let i = 0; i < 30; i++) runtime.tick();
      expect(actor.transform.position.x).toBeGreaterThan(0.1);
      expect(actor.transform.position.y).toBeLessThan(3.5);
      const lastPose = commands.filter((command) => command.type === "setRagdollPose").at(-1)!;
      const hips = lastPose.bones.find((bone) => bone.name === "hips")!;
      expect(actor.transform.position.y).toBeCloseTo(hips.position.y - 1, 4);

      runtime.invokeScriptEvent("Hero", "Disable", actor);
      expect(backend.getBodyTransform("body:hero")!.position.y).toBeCloseTo(actor.transform.position.y, 4);
      expect(backend.listDebugColliders()).toHaveLength(1);
      expect(commands.at(-1)?.type).not.toBe("setRagdollPose");
      expect(commands.some((command) => command.type === "clearRagdollPose" && command.requestId === request.requestId)).toBe(true);
    } finally { runtime.stop(); }
  });

  it("rejects stale captures after disable, model replacement, and stop", async () => {
    const { runtime, commands } = fixture();
    try {
      const actor = await prepare(runtime);
      runtime.invokeScriptEvent("Hero", "Enable", actor);
      const first = latestCapture(commands);
      runtime.invokeScriptEvent("Hero", "Disable", actor);
      runtime.applyRagdollPoseCaptured({ type: "ragdollPoseCaptured", slotId: first.slotId, requestId: first.requestId, bones: pose });
      expect(runtime.getPhysicsSync()!.getBackend().listDebugColliders()).toHaveLength(1);

      runtime.invokeScriptEvent("Hero", "Enable", actor);
      const second = latestCapture(commands);
      actor.components.find((component) => component.guid === "model")!.setVariable("assetGuid", "replacement-model");
      runtime.applyRagdollPoseCaptured({ type: "ragdollPoseCaptured", slotId: second.slotId, requestId: second.requestId, bones: pose });
      const third = latestCapture(commands);
      expect(third.requestId).not.toBe(second.requestId);
      expect(runtime.getPhysicsSync()!.getBackend().getBodyTransform("body:hero")).not.toBeNull();
      runtime.applyRagdollPoseCaptured({ type: "ragdollPoseCaptured", slotId: third.slotId, requestId: third.requestId, bones: pose });
      expect(runtime.getPhysicsSync()!.getBackend().getBodyTransform("body:hero")).toBeNull();
      runtime.stop();
      const count = commands.length;
      runtime.applyRagdollPoseCaptured({ type: "ragdollPoseCaptured", slotId: third.slotId, requestId: third.requestId, bones: pose });
      expect(commands).toHaveLength(count);
    } finally { runtime.stop(); }
  });

  it("reports failed capture and explicit software support once while preserving ordinary collision", async () => {
    for (const software of [false, true]) {
      const { runtime, commands } = fixture(software);
      try {
        const actor = await prepare(runtime);
        runtime.invokeScriptEvent("Hero", "Enable", actor);
        if (!software) {
          const request = latestCapture(commands);
          runtime.applyRagdollPoseCaptured({ type: "ragdollPoseCaptured", slotId: request.slotId, requestId: request.requestId, error: "Model has no skeleton" });
        }
        const errorCount = runtime.getDiagnostics().entries().reduce((total, entry) => total + entry.count, 0);
        for (let i = 0; i < 3; i++) runtime.tick();
        expect(runtime.getPhysicsSync()!.getBackend().getBodyTransform("body:hero")).not.toBeNull();
        expect(runtime.getDiagnostics().entries().reduce((total, entry) => total + entry.count, 0)).toBe(errorCount);
        expect(errorCount).toBeGreaterThan(0);
      } finally { runtime.stop(); }
    }
  });

  it("releases active physics when the renderer loses the skeleton", async () => {
    const { runtime, commands } = fixture();
    try {
      const actor = await prepare(runtime);
      runtime.invokeScriptEvent("Hero", "Enable", actor);
      const request = latestCapture(commands);
      runtime.applyRagdollPoseCaptured({ type: "ragdollPoseCaptured", slotId: request.slotId, requestId: request.requestId, bones: pose });
      expect(runtime.getPhysicsSync()!.getBackend().listDebugColliders()).toHaveLength(2);
      runtime.applyRagdollPoseCaptured({ type: "ragdollPoseCaptured", slotId: request.slotId, requestId: request.requestId, error: "The loaded skeleton was replaced" });
      expect(runtime.getPhysicsSync()!.getBackend().getBodyTransform("body:hero")).not.toBeNull();
      expect(runtime.getPhysicsSync()!.getBackend().listDebugColliders()).toHaveLength(1);
      expect(actor.components.find((component) => component.guid === "ragdoll")!.getVariable("status")).toBe("failed");
      const poseCount = commands.filter((command) => command.type === "setRagdollPose").length;
      runtime.tick();
      expect(commands.filter((command) => command.type === "setRagdollPose")).toHaveLength(poseCount);
    } finally { runtime.stop(); }
  });
});
