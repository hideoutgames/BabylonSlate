import { describe, expect, it } from "vitest";
import { createActor, createDefaultSceneSettings, createMeshComponent } from "@babylonslate/core";
import { isPlayEngineCommandType, type CommandMessage } from "@babylonslate/bridge";
import { createInProcessRuntime } from "./driver";

describe("runtime deformers", () => {
  it("batches tick control edits without geometry reassignment and sends nothing for unchanged frames", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: { name: "Cages", viewportMode: "3d", settings: createDefaultSceneSettings(), folders: [], actors: [
        createActor("owner", "Owner", { classId: "Rig", components: [createMeshComponent("mesh"),
          { id: "cage", classId: "DeformerComponent", properties: { enabled: true, targetMeshComponentId: "mesh" } }] }),
        createActor("sibling", "Sibling", { components: [createMeshComponent("sibling-mesh")] }),
      ] }, onCommand: (command) => commands.push(command) });
    const updates = () => commands.filter((command) => command.type === "setActorDeformers");
    try {
      await runtime.loadScripts([{ assetGuid: "rig", classId: "Rig", parentClassId: "Actor", anchors: [],
        entryPoints: ["onTick", "Disable", "Invalid"].map((name) => ({ name, event: name, isAsync: false })),
        source: `
          export function onTick(ctx) {
            const cage = ctx.getComponentById(ctx.self, "cage");
            ctx.callComponentFunction(cage, "setDeformerControlPointOffset", { index: 0, offset: { x: 1, y: 2, z: 3 } });
            ctx.callComponentFunction(cage, "setDeformerControlPointOffset", { index: 7, offset: { x: 0, y: 1, z: 0 } });
            ctx.setVariableOn(cage, "strength", 0.5);
          }
          export function Disable(ctx) { ctx.setVariableOn(ctx.getComponentById(ctx.self, "cage"), "enabled", false); }
          export function Invalid(ctx) {
            ctx.setVariable("invalid", ctx.callComponentFunction(ctx.getComponentById(ctx.self, "cage"), "setDeformerControlPointOffset", { index: 64, offset: { x: 1, y: 0, z: 0 } }).success);
            ctx.callComponentFunction(ctx.self, "resetDeformerControlPoints", {});
          }
        ` }]);
      runtime.realizePlayWorld(); runtime.start();
      const owner = runtime.getWorld().findActor("owner")!;
      const initial = updates().length;
      const meshAssignments = commands.filter((command) => command.type === "assignMesh").length;
      const physics = runtime.getPhysicsSync()!.getBackend();
      const originalColliders = structuredClone(physics.listDebugColliders());
      runtime.tick();
      expect(updates()).toHaveLength(initial + 1);
      const changed = updates().at(-1)!;
      expect(isPlayEngineCommandType(changed.type)).toBe(true);
      expect(changed).toMatchObject({ actorId: "owner", deformers: [{ id: "cage", targetMeshComponentId: "mesh", strength: 0.5 }] });
      expect(changed.deformers[0]!.offsets.slice(0, 3)).toEqual([1, 2, 3]);
      expect(changed.deformers[0]!.offsets.slice(21)).toEqual([0, 1, 0]);
      expect(physics.listDebugColliders()).toEqual(originalColliders);
      runtime.tick(); runtime.tick();
      expect(updates()).toHaveLength(initial + 1);
      runtime.invokeScriptEvent("Rig", "Invalid", owner);
      expect(owner.getVariable("invalid")).toBe(false);
      expect(updates()).toHaveLength(initial + 1);
      runtime.invokeScriptEvent("Rig", "Disable", owner);
      expect(updates().at(-1)).toMatchObject({ actorId: "owner", deformers: [] });
      expect(updates().at(-1)!.revision).toBeGreaterThan(changed.revision);
      expect(commands.filter((command) => command.type === "assignMesh")).toHaveLength(meshAssignments);
      expect(updates().some((command) => command.actorId === "sibling")).toBe(false);
      expect(physics.listDebugColliders()).toEqual(originalColliders);
    } finally { runtime.stop(); }
  });
});
