import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import { createActor, createDefaultScene, createMeshComponent } from "@haptic/core";
import { createInProcessRuntime } from "./driver";

const COMPONENT_COMMANDS = ["setActorOutlines", "setFogVolumes", "setAreaLights", "configureRenderTargetCapture"];

describe("render slots", () => {
  it("gives an actor that reuses a released slot none of the previous owner's component commands", async () => {
    const commands: CommandMessage[] = [];
    const scene = createDefaultScene();
    scene.actors = [createActor("decorated", "Decorated", { components: [
      createMeshComponent("mesh"),
      { id: "ink", classId: "OutlineComponent", properties: { width: 2 } },
      { id: "fog", classId: "FogVolumeComponent", properties: { shape: "box", size: [2, 2, 2] } },
      { id: "panel", classId: "AreaRectLightComponent", properties: { width: 2 } },
      { id: "lens", classId: "RenderTargetCaptureComponent", properties: {} },
    ] })];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: scene, onCommand: (command) => commands.push(command) });
    try {
      await runtime.loadScripts([{ assetGuid: "plain-script", classId: "Plain", parentClassId: "Actor",
        source: "export function onBeginPlay() {}", anchors: [], entryPoints: [] }]);
      runtime.realizePlayWorld();
      expect(commands).toContainEqual(expect.objectContaining({ type: "spawn", actorGuid: "decorated", slotId: 0 }));
      for (const type of COMPONENT_COMMANDS) expect(commands.map((command) => command.type)).toContain(type);
      runtime.start();
      expect(runtime.executeConsoleCommand("destroyactor decorated").success).toBe(true);
      commands.length = 0;
      const replacement = runtime.spawnScriptedActor({ classId: "Plain" })!;
      expect(commands[0]).toMatchObject({ type: "spawn", actorGuid: replacement.guid, slotId: 0 });
      expect(commands.filter((command) => COMPONENT_COMMANDS.includes(command.type))).toEqual([]);
      expect(commands).not.toContainEqual(expect.objectContaining({ type: "assignMesh", meshKind: null }));
    } finally {
      runtime.stop();
    }
  });

  it("clears a slot's visual when its last Play renderable stops rendering", async () => {
    const commands: CommandMessage[] = [];
    const scene = createDefaultScene();
    scene.actors = [createActor("crate", "Crate", { classId: "Hider", components: [
      { id: "col", classId: "ColliderComponent", properties: { renderInGame: true,
        shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } } },
    ] })];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: scene, onCommand: (command) => commands.push(command) });
    try {
      await runtime.loadScripts([{ assetGuid: "hider-script", classId: "Hider", parentClassId: "Actor",
        source: 'export function Update(ctx) { ctx.setVariableOn(ctx.getComponentById(ctx.self, "col"), "renderInGame", false); }',
        anchors: [], entryPoints: [{ name: "Update", event: "Update", isAsync: false }] }]);
      runtime.realizePlayWorld();
      const shown = commands.find((command): command is Extract<CommandMessage, { type: "assignMesh" }> => command.type === "assignMesh");
      expect(shown).toMatchObject({ actorGuid: "crate", meshKind: expect.stringMatching(/^collider:/) });
      commands.length = 0;
      runtime.invokeScriptEvent("Hider", "Update", runtime.getWorld().findActor("crate")!);
      expect(commands.filter((command) => command.type === "assignMesh")).toEqual([
        expect.objectContaining({ slotId: shown!.slotId, actorGuid: "crate", meshAssetGuid: null, meshKind: null }),
      ]);
    } finally {
      runtime.stop();
    }
  });
});
