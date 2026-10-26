import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import { createActor, createDefaultScene, createDefaultSceneLayer, createMeshComponent, type SerializedScene } from "@haptic/core";
import { sceneAssetClassId, sceneLayerAssetClassId } from "@haptic/object-model";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

/** A SceneScript / SceneLayerScript that records its lifecycle on its owner and in the log. */
function lifecycleScript(classId: string, parentClassId: "Scene" | "SceneLayer"): CompiledScript {
  return {
    classId, parentClassId, assetGuid: classId.split(":")[1]!, anchors: [],
    variables: [{ name: "score", type: "int", defaultValue: 5 }],
    source: `export function begin(ctx) {
        ctx.self.setVariable("began", ctx.self.getVariable("score"));
        ctx.log("log", "Script", "begin:" + ${JSON.stringify(classId)} + ":" + ctx.self.guid);
      }
      export function tick(ctx) { ctx.self.setVariable("ticks", Number(ctx.self.getVariable("ticks") ?? 0) + 1); }
      export function destroyed(ctx) { ctx.log("log", "Script", "destroyed:" + ${JSON.stringify(classId)} + ":" + ctx.self.guid); }`,
    entryPoints: [
      { name: "begin", event: "onBeginPlay", isAsync: false },
      { name: "tick", event: "onTick", isAsync: false },
      { name: "destroyed", event: "onDestroyed", isAsync: false },
    ],
  };
}

function logs(commands: readonly CommandMessage[]): string[] {
  return commands.flatMap((command) => command.type === "log" ? [String((command as { message: string }).message)] : []);
}

function scene(name: string, layers: string[] = []): SerializedScene {
  const value = { ...createDefaultScene(), name, actors: [createActor("hero", "Hero")] };
  value.settings.sceneLayers = layers.map((assetGuid, index) => ({ assetGuid, zOrder: index, enabled: true }));
  return value;
}

describe("SceneScript and SceneLayerScript", () => {
  it("runs the main Scene's script from its readiness until the Scene changes", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: scene("Level1"), playSceneGuid: "level-1",
      sceneLibrary: { "level-2": scene("Level2") },
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([lifecycleScript(sceneAssetClassId("level-1"), "Scene")]);
    runtime.realizePlayWorld();
    const level1 = runtime.getWorld().currentScene!;
    expect(level1.classId).toBe(sceneAssetClassId("level-1"));
    // Class variable defaults apply before Begin Play reads them.
    expect(level1.getVariable("began")).toBe(5);
    expect(runtime.getWorld().findActor("hero")).toBeDefined();
    runtime.start();
    runtime.tick();
    runtime.tick();
    expect(level1.getVariable("ticks")).toBe(2);

    runtime.executeConsoleCommand("changescene Level2");
    expect(logs(commands)).toContain(`destroyed:${sceneAssetClassId("level-1")}:${level1.guid}`);
    runtime.tick();
    expect(level1.getVariable("ticks")).toBe(2);
    // Level2 has no script: nothing runs on it.
    expect(runtime.getWorld().currentScene?.getVariable("began")).toBeUndefined();
    runtime.stop();
  });

  it("gives each Scene Layer instance its own script, ended when its owning Scene unloads", async () => {
    const commands: CommandMessage[] = [];
    const overlay = { ...createDefaultSceneLayer(), actors: [createActor("panel", "Panel", {
      classId: "SceneLayerActor", components: [createMeshComponent("panel-mesh", "box")] })] };
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: scene("Level1", ["overlay", "overlay"]), playSceneGuid: "level-1",
      sceneLibrary: { "level-2": scene("Level2") },
      sceneLayerLibrary: { overlay },
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([lifecycleScript(sceneLayerAssetClassId("overlay"), "SceneLayer")]);
    runtime.realizePlayWorld();
    const layers = [...runtime.getWorld().getSceneLayers()];
    expect(layers).toHaveLength(2);
    for (const layer of layers) {
      expect(layer.classId).toBe(sceneLayerAssetClassId("overlay"));
      expect(layer.getVariable("began")).toBe(5);
    }
    runtime.start();
    runtime.tick();
    expect(layers.map((layer) => layer.getVariable("ticks"))).toEqual([1, 1]);

    runtime.executeConsoleCommand("changescene Level2");
    for (const layer of layers) {
      expect(logs(commands)).toContain(`destroyed:${sceneLayerAssetClassId("overlay")}:${layer.guid}`);
    }
    runtime.tick();
    expect(layers.map((layer) => layer.getVariable("ticks"))).toEqual([1, 1]);
    runtime.stop();
  });
});
