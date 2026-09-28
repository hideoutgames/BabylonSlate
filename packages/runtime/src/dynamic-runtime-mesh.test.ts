import { describe, expect, it, vi } from "vitest";
import { createActor, createDefaultSceneSettings, identityTransform } from "@babylonslate/core";
import { dynamicMeshTransferables, isPlayEngineCommandType, type CommandMessage } from "@babylonslate/bridge";
import { ClassRegistry, World } from "@babylonslate/object-model";
import { createPhysicsBackend } from "@babylonslate/physics";
import { createInProcessRuntime } from "./driver";
import { DynamicRuntimeMeshSync } from "./dynamic-runtime-mesh";
import { PhysicsWorldSync } from "./physics-sync";

describe("dynamic runtime mesh component", () => {
  it("creates meshes through component references, sends only dirty ranges, and never redirects calls to actors or siblings", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: { name: "Runtime Mesh", viewportMode: "3d", settings: createDefaultSceneSettings(), folders: [], actors: [
        createActor("owner", "Owner", { classId: "Rig", components: [{ id: "sibling", classId: "DynamicRuntimeMeshComponent", properties: {} }] }),
      ] }, onCommand: (command) => commands.push(command) });
    const updates = () => commands.filter((command) => command.type === "dynamicMeshUpdate");
    try {
      await runtime.loadScripts([{ assetGuid: "rig", classId: "Rig", parentClassId: "Actor", anchors: [],
        entryPoints: ["Create", "Edit", "Material", "WrongTarget"].map((name) => ({ name, event: name, isAsync: false })),
        source: `
          export function Create(ctx) {
            const mesh = ctx.addComponent(ctx.self, "DynamicRuntimeMeshComponent");
            ctx.setVariable("mesh", mesh);
            ctx.setVariable("created", ctx.callComponentFunction(mesh, "setDynamicMeshGeometry", { positions: [0,0,0, 1,0,0, 0,1,0], indices: [0,1,2] }).success);
          }
          export function Edit(ctx) {
            const mesh = ctx.getVariable("mesh");
            ctx.callComponentFunction(mesh, "updateDynamicMeshVertices", { firstVertex: 1, positions: [2,0,0] });
            ctx.callComponentFunction(mesh, "updateDynamicMeshVertices", { firstVertex: 2, positions: [0,2,0] });
          }
          export function Material(ctx) { ctx.setVariableOn(ctx.getVariable("mesh"), "materialGuid", "surface"); }
          export function WrongTarget(ctx) { ctx.callComponentFunction(ctx.self, "clearDynamicMeshGeometry", {}); }
        ` }]);
      runtime.realizePlayWorld(); runtime.start();
      const owner = runtime.getWorld().findActor("owner")!;
      runtime.invokeScriptEvent("Rig", "Create", owner); runtime.tick();
      expect(owner.getVariable("created")).toBe(true);
      expect(updates()).toHaveLength(1);
      expect(isPlayEngineCommandType(updates()[0]!.type)).toBe(true);
      const first = structuredClone(updates()[0]!);
      const moved = structuredClone(first, { transfer: dynamicMeshTransferables(first) });
      expect(moved.update.vertexCount).toBe(3);
      expect(first.update.positions!.data.byteLength).toBe(0);
      const assignments = commands.filter((c) => c.type === "assignMesh").length;
      runtime.invokeScriptEvent("Rig", "Edit", owner); runtime.tick();
      expect(updates()).toHaveLength(2);
      expect(updates()[1]!.meshId).toBe(updates()[0]!.meshId);
      expect(updates()[1]!.update).toMatchObject({ reset: false, positions: { offset: 3, data: new Float32Array([2,0,0,0,2,0]) } });
      expect(updates()[1]!.update.indices).toBeUndefined();
      runtime.invokeScriptEvent("Rig", "Material", owner);
      expect(commands.filter((c) => c.type === "assignMaterial").at(-1)).toMatchObject({ componentId: expect.any(String), materialAssetGuid: "surface" });
      expect(commands.filter((c) => c.type === "assignMesh")).toHaveLength(assignments);
      runtime.invokeScriptEvent("Rig", "WrongTarget", owner); runtime.tick(); runtime.tick();
      expect(updates()).toHaveLength(2);
      expect(runtime.getPhysicsSync()!.getBackend().listDebugColliders()).toHaveLength(0);
      runtime.getWorld().destroyActor(owner.guid); runtime.tick();
      expect(updates()).toHaveLength(2);
    } finally { runtime.stop(); }
  });

  it("creates exact native triangle collision only when enabled and recooks only positions/topology", async () => {
    const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
    const owner = world.createActor({ classId: "Actor", guid: "owner", transform: identityTransform() });
    const parent = world.createComponent({ classId: "ActorComponent", guid: "offset", transform: { ...identityTransform(), position: { x: 4, y: 0, z: 0 } } });
    const component = world.createComponent({ classId: "DynamicRuntimeMeshComponent", guid: "mesh", parentId: "offset" });
    owner.attachComponent(parent); owner.attachComponent(component); world.spawnActorNow(owner);
    const meshes = new DynamicRuntimeMeshSync({ slot: () => 0, eligible: () => true, emit: () => {} });
    const backend = await createPhysicsBackend({ kind: "3d", gravity: { x: 0, y: 0, z: 0 }, allowSoftwareFallback: false });
    const physics = new PhysicsWorldSync(backend);
    const commit = vi.spyOn(backend, "applyColliderChanges");
    const trace = (x: number, y: number) => backend.lineTrace({ x, y, z: 5 }, { x, y, z: -5 });
    try {
      meshes.invoke(component, "setDynamicMeshGeometry", { positions: [0,0,0, 2,0,0, 0,2,0], indices: [0,1,2] });
      physics.syncFromWorld(world);
      expect(backend.listDebugColliders()).toHaveLength(0); expect(commit).not.toHaveBeenCalled();
      component.setVariable("enableCollision", true); physics.syncFromWorld(world);
      expect(trace(4.2, 0.2).actorId).toBe(owner.guid);
      expect(trace(5.8, 1.8).hit).toBe(false); // Inside its bounding box, outside the triangle.
      commit.mockClear();
      meshes.invoke(component, "updateDynamicMeshVertices", { firstVertex: 0, normals: [0,0,-1], uvs: [0.5,0.5] });
      component.setVariable("materialGuid", "surface"); physics.syncFromWorld(world);
      expect(commit).not.toHaveBeenCalled();
      meshes.invoke(component, "updateDynamicMeshVertices", { firstVertex: 0, positions: [0,0,2, 2,0,2, 0,2,2] });
      physics.syncFromWorld(world);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(trace(4.2, 0.2).location?.z).toBeCloseTo(2);
      parent.transform.position.x = 10; physics.syncFromWorld(world);
      expect(trace(4.2, 0.2).hit).toBe(false); expect(trace(10.2, 0.2).hit).toBe(true);
      component.setVariable("enableCollision", false); physics.syncFromWorld(world);
      expect(trace(10.2, 0.2).hit).toBe(false); expect(backend.listDebugColliders()).toHaveLength(0);
      component.setVariable("enableCollision", true); physics.syncFromWorld(world);
      const body = world.createComponent({ classId: "RigidBodyComponent", guid: "body", variables: {
        motionType: "dynamic", mass: 1, gravityScale: 0,
      } });
      owner.attachComponent(body); physics.syncFromWorld(world);
      physics.setActorLinearVelocity(owner.guid, { x: 1, y: 0, z: 0 });
      physics.step(1 / 60, world);
      expect(owner.transform.position.x).toBeGreaterThan(0);
      expect(trace(10.2 + owner.transform.position.x, 0.2).hit).toBe(true);
      meshes.invoke(component, "clearDynamicMeshGeometry", {}); physics.syncFromWorld(world);
      expect(backend.listDebugColliders()).toHaveLength(0);
    } finally { commit.mockRestore(); meshes.dispose(); physics.dispose(); }
  });
});
