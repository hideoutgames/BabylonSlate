import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene, createDefaultSceneLayer } from "@babylonslate/core";
import { Actor, ClassRegistry, SceneLayerActorSwitcher, World } from "@babylonslate/object-model";
import type { CommandMessage } from "@babylonslate/bridge";
import { createInProcessRuntime } from "./driver";
import { SceneLayerActorSwitchers } from "./scene-layer-actor-switcher";

const entryPoints = (...names: string[]) => names.map(name => ({ name, event: name, isAsync: false }));

describe("SceneLayer actor switcher", () => {
  it("spawns inherited prefab components with per-entry defaults, switches through graph functions and disposes stale selections", async () => {
    const layer = createDefaultSceneLayer();
    layer.actors = [createActor("switcher", "Menu", { classId: "Menu", properties: {
      initialIndex: 0, sceneLayerActors: [{ classId: "Panel", defaults: { title: "First", data: { count: 1 } } }, { classId: "Panel", defaults: { title: "Second" } }, "Actor"],
    } })];
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, playScene: createDefaultScene(), sceneLayerLibrary: { menu: layer }, onCommand: command => commands.push(command) });
    try {
      await runtime.loadScripts([
        { assetGuid: "base", classId: "BasePanel", parentClassId: "SceneLayerActor", anchors: [],
          components: [{ id: "caption", classId: "2DTextComponent", properties: { text: "Panel" } }],
          variables: [{ name: "title", type: "string", defaultValue: "Default" }],
          entryPoints: entryPoints("onBeginPlay", "onDestroyed", "onSceneLayerActorSwitchedTo", "onSceneLayerActorSwitchedFrom"),
          source: `export function onBeginPlay(ctx) { ctx.self.setVariable("beganWith", ctx.self.getVariable("title")); }
            export function onDestroyed(ctx) { ctx.self.setVariable("ended", true); }
            export function onSceneLayerActorSwitchedTo(ctx) { ctx.self.setVariable("entered", ctx.args.index); }
            export function onSceneLayerActorSwitchedFrom(ctx) { ctx.self.setVariable("left", ctx.args.index); }`,
        },
        { assetGuid: "panel", classId: "Panel", parentClassId: "BasePanel", anchors: [], entryPoints: [], source: "" },
        { assetGuid: "menu", classId: "Menu", parentClassId: "SceneLayerActorSwitcher", anchors: [],
          actorDefaults: { properties: { initialIndex: -1 } },
          entryPoints: entryPoints("onTick", "onSceneLayerActorSwitching", "onSceneLayerActorSwitched"),
          source: `export function onTick(ctx) {
            const next = ctx.self.getVariable("nextIndex");
            if (next !== undefined) {
              ctx.self.setVariable("nextIndex", undefined);
              ctx.self.setVariable("returned", ctx.callComponentFunction(ctx.self, "switchSceneLayerActor", { index: next }).actor);
              ctx.self.setVariable("queried", ctx.callComponentFunction(ctx.self, "getCurrentSceneLayerActor", {}).actor);
            }
          }
          export function onSceneLayerActorSwitching(ctx) { ctx.self.setVariable("switchingIndex", ctx.args.index); }
          export function onSceneLayerActorSwitched(ctx) { ctx.self.setVariable("switchedIndex", ctx.args.index); }`,
        },
      ]);
      runtime.realizePlayWorld();
      const liveLayer = runtime.createSceneLayer("menu")!;
      runtime.start();
      const switcher = runtime.getWorld().findActor("switcher") as SceneLayerActorSwitcher;
      const first = switcher.currentActor!;
      expect(first).toBeInstanceOf(Actor);
      expect(first.sceneLayerId).toBe(liveLayer.guid);
      expect(first.getVariable("parentId")).toBe(switcher.guid);
      expect(first.getVariable("title")).toBe("First");
      expect(first.getVariable("beganWith")).toBe("First");
      expect(first.getVariable("entered")).toBe(0);
      expect(first.components[0]).toMatchObject({ sourceId: "caption", classId: "2DTextComponent" });
      expect(first.components[0]!.guid).not.toBe("caption");
      expect(commands.some(command => command.type === "assignMesh" && command.actorGuid === first.guid)).toBe(true);
      (first.getVariable("data") as { count: number }).count = 5;
      expect((switcher.getVariable("sceneLayerActors") as Array<{ defaults: { data: { count: number } } }>)[0]!.defaults.data.count).toBe(1);

      switcher.setVariable("nextIndex", 1);
      runtime.tick();
      const second = switcher.currentActor!;
      expect(second).not.toBe(first);
      expect(second.getVariable("title")).toBe("Second");
      expect(first.destroyed).toBe(true);
      expect(first.getVariable("left")).toBe(0);
      expect(first.getVariable("ended")).toBe(true);
      expect(switcher.getVariable("returned")).toBe(second);
      expect(switcher.getVariable("queried")).toBe(second);
      expect(switcher.getVariable("switchingIndex")).toBe(1);
      expect(switcher.getVariable("switchedIndex")).toBe(1);
      expect(second.getVariable("entered")).toBe(1);

      switcher.setVariable("nextIndex", 2);
      runtime.tick();
      expect(switcher.currentActor).toBe(second);
      switcher.setVariable("nextIndex", 1);
      runtime.tick();
      expect(switcher.currentActor).toBe(second);
      switcher.setVariable("nextIndex", -1);
      runtime.tick();
      expect(switcher.currentActor).toBeNull();
      expect(switcher.currentIndex).toBe(-1);
      expect(second.destroyed).toBe(true);
      switcher.setVariable("nextIndex", 0);
      runtime.tick();
      const third = switcher.currentActor!;
      runtime.getWorld().destroyActor(third.guid);
      runtime.tick();
      expect(switcher.currentActor).toBeNull();
      switcher.setVariable("nextIndex", 0);
      runtime.tick();
      const last = switcher.currentActor!;
      runtime.removeSceneLayer(liveLayer.guid);
      expect(last.destroyed).toBe(true);
      expect(switcher.currentActor).toBeNull();
      expect(runtime.getWorld().getActors()).toHaveLength(0);
    } finally { runtime.stop(); }
  });

  it("keeps switchers out of world scenes and stops recursive prefab selections", async () => {
    const scene = createDefaultScene();
    scene.actors = [createActor("world-switcher", "Invalid", { classId: "RecursiveMenu" })];
    const layer = createDefaultSceneLayer();
    layer.actors = [createActor("root", "Root", { classId: "RecursiveMenu" })];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, playScene: scene, sceneLayerLibrary: { menu: layer } });
    try {
      await runtime.loadScripts([{ assetGuid: "recursive", classId: "RecursiveMenu", parentClassId: "SceneLayerActorSwitcher", anchors: [], entryPoints: [], source: "", actorDefaults: { properties: { sceneLayerActors: ["RecursiveMenu"] } } }]);
      runtime.realizePlayWorld();
      expect(runtime.getWorld().findActor("world-switcher")).toBeUndefined();
      const liveLayer = runtime.createSceneLayer("menu")!;
      expect(runtime.getWorld().getActors().length).toBeGreaterThan(0);
      expect(runtime.getWorld().getActors().length).toBeLessThan(40);
      runtime.removeSceneLayer(liveLayer.guid);
      expect(runtime.getWorld().getActors()).toHaveLength(0);
    } finally { runtime.stop(); }
  });

  it("retires the pending replacement when an outgoing actor destroys its switcher", () => {
    const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
    const layer = world.createSceneLayer({ assetGuid: "menu", zOrder: 0 });
    const switcher = world.createActor({ classId: "SceneLayerActorSwitcher", sceneLayerId: layer.guid, variables: { sceneLayerActors: ["SceneLayerActor", "SceneLayerActor"] } }) as SceneLayerActorSwitcher;
    world.spawnActorNow(switcher);
    const retired = new Set<Actor>();
    const actors: Actor[] = [];
    let destroyOnExit = false;
    const controller = new SceneLayerActorSwitchers({
      classes: world.classRegistry,
      alive: actor => !actor.destroyed && !retired.has(actor),
      spawn: (parent, classId, defaults) => {
        const actor = world.createActor({ classId, sceneLayerId: parent.sceneLayerId, variables: defaults });
        world.spawnActorNow(actor); actors.push(actor); return actor;
      },
      remove: actor => { retired.add(actor); controller.retire(actor); world.destroyActorInstance(actor); },
      event: (_actor, name) => {
        if (destroyOnExit && name === "onSceneLayerActorSwitchedFrom") {
          retired.add(switcher); controller.retire(switcher); world.destroyActorInstance(switcher);
        }
      },
    });
    controller.initialize(switcher);
    destroyOnExit = true;
    expect(controller.switchTo(switcher, 1)).toBeNull();
    world.flushPending();
    expect(actors).toHaveLength(2);
    expect(actors.every(actor => actor.destroyed)).toBe(true);
    expect(switcher.currentActor).toBeNull();
    expect(world.getActors()).toHaveLength(0);
  });
});
