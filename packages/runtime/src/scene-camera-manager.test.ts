import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import { createActor, createDefaultSceneSettings, type SerializedScene } from "@haptic/core";
import { createInProcessRuntime } from "./driver";

/** A Scene with a Hero that runs `onBeginPlay` and two camera rigs, one of them the Default Camera when `defaultCamera` names it. */
function cameraScene(defaultCamera: string | null): SerializedScene {
  const settings = createDefaultSceneSettings("2d");
  settings.defaultCameraActorId = defaultCamera;
  settings.cameraLocation2D = [3, -1];
  settings.cameraBounds2D = { width: 20, height: 10 };
  const rig = (id: string) => createActor(id, id, {
    components: [{ id: `${id}-lens`, classId: "CameraComponent", properties: { projectionMode: "orthographic" } }],
  });
  return {
    name: "Cameras",
    viewportMode: "2d",
    settings,
    folders: [],
    actors: [createActor("hero", "Hero", { classId: "Hero" }), rig("rig"), rig("other"),
      createActor("prop", "Prop", { components: [{ id: "mesh", classId: "MeshComponent", properties: {} }] })],
  };
}

async function runBeginPlay(scene: SerializedScene, body: string) {
  const commands: CommandMessage[] = [];
  const runtime = createInProcessRuntime({
    seed: 1, preferSoftwarePhysics: true, playScene: scene,
    onCommand: (command) => commands.push(command),
  });
  await runtime.loadScripts([{
    assetGuid: "hero-script", classId: "Hero", parentClassId: "Actor", anchors: [],
    source: `export function onBeginPlay(ctx) {\n${body}\n}`,
    entryPoints: [{ name: "onBeginPlay", event: "onBeginPlay", isAsync: false }],
  }]);
  runtime.realizePlayWorld();
  runtime.start();
  runtime.tick();
  const hero = runtime.getWorld().findActor("hero")!;
  return { runtime, commands, hero, world: runtime.getWorld() };
}

const READ_VIEW = `
  const manager = ctx.getSceneCameraManager();
  const view = () => [ctx.getVariableFrom(manager, "cameraActor"), ctx.getVariableFrom(manager, "cameraComponent")];`;

describe("Scene Camera Manager", () => {
  it("reports the Default Camera possessed at the start, then the Layer Camera after Possess Camera with None", async () => {
    const { runtime, commands, hero, world } = await runBeginPlay(cameraScene("rig"), `${READ_VIEW}
      ctx.setVariable("start", view());
      ctx.possessCamera(null);
      ctx.setVariable("released", view());`);
    try {
      const rig = world.findActor("rig")!;
      expect(hero.getVariable("start")).toEqual([rig, rig.components[0]]);
      expect(hero.getVariable("released")).toEqual([null, null]);
      expect(commands.filter((command) => command.type === "possessCamera").map((command) => command.slotId).at(-1)).toBeNull();
    } finally { runtime.stop(); }
  });

  it("switches to a possessed camera actor, and back to the Layer Camera for an actor without a Camera component", async () => {
    const { runtime, hero, world } = await runBeginPlay(cameraScene(null), `${READ_VIEW}
      const [other, prop] = ["other", "prop"].map((id) => ctx.getAllActorsOfClass("Actor").find((actor) => actor.guid === id));
      ctx.setVariable("start", view());
      ctx.possessCamera(other);
      ctx.setVariable("possessed", view());
      ctx.possessCamera(prop);
      ctx.setVariable("refused", view());`);
    try {
      const other = world.findActor("other")!;
      expect(hero.getVariable("start")).toEqual([null, null]);
      expect(hero.getVariable("possessed")).toEqual([other, other.components[0]]);
      expect(hero.getVariable("refused")).toEqual([null, null]);
    } finally { runtime.stop(); }
  });

  it("moves the Scene's own Layer Camera, starting from its Layer Camera Location", async () => {
    const { runtime, commands, hero, world } = await runBeginPlay(cameraScene(null), `
      const camera = ctx.getVariableFrom(ctx.getSceneCameraManager(), "layerCamera");
      ctx.setVariable("startLocation", ctx.getVariableFrom(camera, "location"));
      ctx.setVariableOn(camera, "zoom", 2);
      ctx.callComponentFunction(camera, "addLayerCameraOffset", { delta: { x: 1, y: 1 } });
      ctx.setVariable("camera", camera);`);
    try {
      const sceneCamera = world.currentScene!.camera;
      expect(hero.getVariable("camera")).toBe(sceneCamera);
      expect(hero.getVariable("startLocation")).toEqual({ x: 3, y: -1 });
      expect(sceneCamera.state).toEqual({ x: 4, y: 0, rotation: 0, zoom: 2 });
      expect(commands.flatMap((command) => command.type === "sceneCamera" ? [command] : [])).toEqual([
        { type: "sceneCamera", camera: { x: 3, y: -1, rotation: 0, zoom: 1 }, bounds: { width: 20, height: 10 } },
        { type: "sceneCamera", camera: { x: 3, y: -1, rotation: 0, zoom: 2 }, bounds: { width: 20, height: 10 } },
        { type: "sceneCamera", camera: { x: 4, y: 0, rotation: 0, zoom: 2 }, bounds: { width: 20, height: 10 } },
      ]);
    } finally { runtime.stop(); }
  });
});
