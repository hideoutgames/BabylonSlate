import { expect, it } from "vitest";
import { createActor, createDefaultScene, createDefaultSceneLayer } from "@babylonslate/core";
import type { CommandMessage } from "@babylonslate/bridge";
import { createInProcessRuntime } from "./driver";

it("realizes a joystick with its component transform, independent materials, and axis configuration in the layer", () => {
  const hud = createDefaultSceneLayer();
  hud.actors = [createActor("controls", "Controls", { classId: "SceneLayerActor", components: [{
    id: "stick", classId: "2DJoystickComponent", parentId: null,
    transform: { position: [2, -3, 0], rotation: [0, 0, 0, 1], scale: [2, 2, 1] },
    properties: { backgroundMaterialGuid: "base", joystickMaterialGuid: "thumb", horizontalControl: "dpad-x", radius: 3 },
  }] })];
  const commands: CommandMessage[] = [];
  const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true, seedDemoActors: false,
    playScene: createDefaultScene(), sceneLayerLibrary: { hud }, onCommand: command => commands.push(command) });
  try {
    runtime.realizePlayWorld();
    const layer = runtime.createSceneLayer("hud", 0);
    const assignment = commands.find(command => command.type === "assignMesh" && command.actorGuid === `${layer?.guid}:controls`);
    expect(assignment).toMatchObject({ type: "assignMesh", sceneLayerId: layer?.guid, hitTest: "block", parts: [{
      componentId: "stick", meshKind: "2djoystick", position: [2, -3, 0], scale: [2, 2, 1],
      joystick: { backgroundMaterialGuid: "base", joystickMaterialGuid: "thumb", radius: 3, horizontalControl: "dpad-x", verticalControl: "joystick-y" },
    }] });
  } finally { runtime.stop(); }
});
