import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene, createDefaultSceneLayer } from "@babylonslate/core";
import type { CommandMessage } from "@babylonslate/bridge";
import { createInProcessRuntime } from "./driver";

describe("SceneLayer layout runtime", () => {
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
      const menu = runtime.getWorld().findActor("menu")!;
      const column = menu.components.find(c => c.guid === "column")!;
      expect(column.transform.position.y).toBe(-1.5);
      runtime.applySceneLayerScroll(liveLayer.guid, "menu", "viewport", 0, 99);
      expect(column.transform.position.y).toBe(1.5);
      for (let i = 0; i < 3; i++) runtime.tick();
      expect(column.transform.position.y).toBe(1.5);
      expect(menu.components.find(c => c.guid === "b")!.transform.scale).toEqual({ x: 1, y: 1, z: 1 });
      const layouts = commands.filter((c): c is Extract<CommandMessage, { type: "sceneLayerLayout" }> => c.type === "sceneLayerLayout");
      expect(layouts.at(-1)?.entries.find(e => e.componentId === "b")?.clip).toEqual({ x: 0, y: 0, width: 4, height: 4 });
      runtime.removeSceneLayer(liveLayer.guid);
      expect(runtime.getWorld().findActor("menu")).toBeUndefined();
    } finally { runtime.stop(); }
  });
});
