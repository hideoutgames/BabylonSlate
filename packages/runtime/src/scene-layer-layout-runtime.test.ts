import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene, createDefaultSceneLayer } from "@babylonslate/core";
import type { CommandMessage } from "@babylonslate/bridge";
import { createInProcessRuntime } from "./driver";

describe("SceneLayer layout runtime", () => {
  it("retires a virtual row's nested virtual items and attached actor descendants when it leaves the window", async () => {
    const layer = createDefaultSceneLayer();
    layer.actors = [createActor("menu", "Menu", { classId: "SceneLayerActor", components: [
      { id: "list", classId: "2DVirtualizedListComponent", properties: { width: 4, height: 1, itemClassId: "Row", itemCount: 10, overscan: 0 } },
    ] })];
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, playScene: createDefaultScene(), sceneLayerLibrary: { menu: layer }, onCommand: command => commands.push(command) });
    try {
      await runtime.loadScripts([
        { assetGuid: "row-class", classId: "Row", parentClassId: "SceneLayerActor", source: "", anchors: [], entryPoints: [], components: [
          { id: "nested", classId: "2DVirtualizedListComponent", properties: { width: 1, height: 1, itemClassId: "Cell", itemCount: 3, overscan: 0 } },
        ] },
        { assetGuid: "cell-class", classId: "Cell", parentClassId: "SceneLayerActor", source: "", anchors: [], entryPoints: [], components: [
          { id: "surface", classId: "2DMaterialComponent", properties: {} },
        ] },
      ]);
      runtime.realizePlayWorld();
      const liveLayer = runtime.createSceneLayer("menu")!;
      runtime.start(); runtime.tick(); runtime.tick();
      const world = runtime.getWorld();
      const row = world.getActors().find(actor => actor.classId === "Row")!;
      const cell = world.getActors().find(actor => actor.classId === "Cell" && actor.getVariable("parentId") === row.guid)!;
      expect(cell).toBeDefined();
      const attached = world.createActor({ classId: "SceneLayerActor", sceneLayerId: liveLayer.guid, variables: { parentId: cell.guid } });
      const component = world.createComponent({ classId: "2DMaterialComponent" });
      attached.attachComponent(component); world.spawnActorNow(attached);
      runtime.applySceneLayerScroll(liveLayer.guid, liveLayer.guid + ":menu", "list", 0, 1);
      world.flushPending();
      expect(row.destroyed).toBe(true);
      expect(cell.destroyed).toBe(true);
      expect(attached.destroyed).toBe(true);
      expect(component.destroyed).toBe(true);
      expect(commands.some(command => command.type === "despawn" && command.actorGuid === cell.guid)).toBe(true);
      expect(world.getActors().some(actor => actor.classId === "Row" && actor.getVariable("itemIndex") === 1)).toBe(true);
    } finally { runtime.stop(); }
  });

  it("realizes a bounded prefab actor window for a large virtual list and disposes it with the layer", async () => {
    const layer = createDefaultSceneLayer();
    layer.actors = [createActor("menu", "Menu", { classId: "SceneLayerActor", components: [
      { id: "list", classId: "2DVirtualizedListComponent", properties: { width: 4, height: 3, itemClassId: "Row", itemCount: 10_000, overscan: 1 } },
    ] })];
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, maxActors: 32, preferSoftwarePhysics: true, playScene: createDefaultScene(), sceneLayerLibrary: { menu: layer }, onCommand: command => commands.push(command) });
    try {
      await runtime.loadScripts([{ assetGuid: "row-class", classId: "Row", parentClassId: "SceneLayerActor", source: "", anchors: [], entryPoints: [],
        components: [{ id: "surface", classId: "2DMaterialComponent", properties: {} }] }]);
      runtime.realizePlayWorld();
      const liveLayer = runtime.createSceneLayer("menu")!;
      runtime.start(); runtime.tick();
      const rows = () => runtime.getWorld().getActors().filter(actor => actor.classId === "Row");
      expect(rows().map(actor => actor.getVariable("itemIndex"))).toEqual([0, 1, 2, 3]);
      expect(commands.filter(command => command.type === "assignMesh" && command.sceneLayerId === liveLayer.guid && rows().some(row => row.guid === command.actorGuid))).toHaveLength(4);
      const retired = rows()[0]!, survivor = rows()[2]!;
      runtime.applySceneLayerScroll(liveLayer.guid, liveLayer.guid + ":menu", "list", 0, 2);
      runtime.tick();
      expect(rows().map(actor => actor.getVariable("itemIndex"))).toEqual([1, 2, 3, 4, 5]);
      expect(rows()).toContain(survivor);
      expect(retired.destroyed).toBe(true);
      expect(commands.some(command => command.type === "despawn" && command.actorGuid === retired.guid)).toBe(true);
      runtime.removeSceneLayer(liveLayer.guid);
      expect(rows()).toHaveLength(0);
    } finally { runtime.stop(); }
  });

  it("converts browser safe insets using each layer's bounds and reapplies them after resize", () => {
    const layer = (id: string, extent: number) => {
      const document = createDefaultSceneLayer();
      document.settings.layerBounds = { width: extent, height: extent };
      document.actors = [createActor(id, id, { classId: "SceneLayerActor", components: [
        { id: `${id}-safe`, classId: "2DSafeAreaComponent", properties: { width: 10, height: 10 } },
        { id: `${id}-content`, classId: "2DMaterialComponent", parentId: `${id}-safe`, properties: { widthMode: "fill", heightMode: "fill" } },
      ] })];
      return document;
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true, seedDemoActors: false,
      playScene: createDefaultScene(), sceneLayerLibrary: { small: layer("small", 10), large: layer("large", 20) },
      onCommand: (command) => commands.push(command) });
    try {
      runtime.realizePlayWorld(); runtime.createSceneLayer("small"); runtime.createSceneLayer("large");
      runtime.applySceneLayerResize(50, 50, 100, 100, { left: 10, top: 20 });
      const rect = (id: string) => commands.filter((command) => command.type === "sceneLayerLayout")
        .flatMap((command) => command.entries).filter((entry) => entry.componentId === `${id}-content`).at(-1)?.rect;
      expect(rect("small")).toEqual({ x: 0.5, y: -1, width: 9, height: 8 });
      expect(rect("large")).toEqual({ x: 1, y: -2, width: 8, height: 6 });
      runtime.applySceneLayerResize(50, 50, 200, 200, { left: 10, top: 20 });
      expect(rect("small")).toEqual({ x: 0.25, y: -0.5, width: 9.5, height: 9 });
      expect(rect("large")).toEqual({ x: 0.5, y: -1, width: 9, height: 8 });
      runtime.applySceneLayerResize(50, 50, 200, 200, { left: 0, top: 0 });
      expect(rect("small")).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    } finally { runtime.stop(); }
  });

  it("updates nested component transforms and clips after scrolling, retaining design size across ticks", () => {
    const layer = createDefaultSceneLayer();
    layer.actors = [createActor("menu", "Menu", { classId: "SceneLayerActor", components: [
      { id: "viewport", classId: "2DScrollBoxComponent", properties: { width: 4, height: 4 } },
      { id: "column", classId: "2DVerticalBoxComponent", parentId: "viewport", properties: { width: 4, heightMode: "content", gap: 1 } },
      { id: "a", classId: "2DTextComponent", parentId: "column", properties: { text: "One", wrapWidth: 200, wrapHeight: 300 } },
      { id: "b", classId: "2DTextComponent", parentId: "column", properties: { text: "Two", wrapWidth: 200, wrapHeight: 300 } },
    ] })];
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true, playScene: createDefaultScene(), sceneLayerLibrary: { menu: layer }, onCommand: command => commands.push(command) });
    try {
      runtime.realizePlayWorld();
      const liveLayer = runtime.createSceneLayer("menu")!;
      runtime.start(); runtime.tick();
      // Scene Layer actor guids are scoped to their layer instance.
      const menu = runtime.getWorld().findActor(liveLayer.guid + ":menu")!;
      const column = menu.components.find(c => c.guid === "column")!;
      expect(column.transform.position.y).toBe(-1.5);
      runtime.applySceneLayerScroll(liveLayer.guid, menu.guid, "viewport", 0, 99);
      expect(column.transform.position.y).toBe(1.5);
      for (let i = 0; i < 3; i++) runtime.tick();
      expect(column.transform.position.y).toBe(1.5);
      expect(menu.components.find(c => c.guid === "b")!.transform.scale).toEqual({ x: 1, y: 1, z: 1 });
      const layouts = commands.filter((c): c is Extract<CommandMessage, { type: "sceneLayerLayout" }> => c.type === "sceneLayerLayout");
      expect(layouts.at(-1)?.entries.find(e => e.componentId === "b")?.clip).toEqual({ x: 0, y: 0, width: 4, height: 4 });
      runtime.removeSceneLayer(liveLayer.guid);
      expect(runtime.getWorld().findActor(menu.guid)).toBeUndefined();
    } finally { runtime.stop(); }
  });
});
