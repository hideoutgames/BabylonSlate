import { expect, it } from "vitest";
import { ClassRegistry, World } from "@babylonslate/object-model";
import { overlayLayoutKey } from "@babylonslate/core";
import { SceneLayerLayout } from "./scene-layer-layout";
import { SceneLayerFocusNavigation } from "./scene-layer-focus";
import { focusLayoutEntry, revealFocusedElement } from "./scene-layer-focus-layout";

it("keeps an offscreen focus target reachable and reveals nested scroll viewports from inside out", () => {
  const world = new World({ seed: 1, dt: 0.1, classRegistry: new ClassRegistry() });
  const layer = world.createSceneLayer({ assetGuid: "menu", zOrder: 0 });
  const actor = world.createActor({ guid: "menu", classId: "SceneLayerActor", sceneLayerId: layer.guid });
  const attach = (id: string, classId: string, parentId: string | null, properties: Record<string, unknown>) => {
    const component = world.createComponent({ guid: id, classId, parentId, variables: properties });
    actor.attachComponent(component); return component;
  };
  const outer = attach("outer", "2DScrollBoxComponent", null, { width: 4, height: 4 });
  const inner = attach("inner", "2DScrollBoxComponent", "outer", { width: 4, height: 8 });
  attach("list", "2DVerticalBoxComponent", "inner", { width: 4, heightMode: "content" });
  const buttons = Array.from({ length: 6 }, (_, index) => attach(`item-${index}`, "2DButtonComponent", "list", { width: 4, widthMode: "fixed", height: 2, heightMode: "fixed" }));
  world.spawnActorNow(actor);
  const layout = new SceneLayerLayout();
  layout.update(layer.guid, world.getActors(), 100);
  const target = buttons[5]!;
  const before = focusLayoutEntry(layout, world, actor, target)!;
  expect(before.rect.y + before.rect.height / 2).toBeLessThan(-2);
  const scrollOrder: string[] = [];
  const navigation = new SceneLayerFocusNavigation(world, undefined, {
    canRun: () => true, event: () => {},
    bounds: (owner, component) => focusLayoutEntry(layout, world, owner, component)?.rect,
    onFocusChange: (owner, component) => revealFocusedElement(layout, world, owner, component, (layerId, actorId, componentId, x, y) => {
      scrollOrder.push(componentId);
      const scroll = actor.components.find((entry) => entry.guid === componentId)!;
      const state = layout.entries(layerId).get(overlayLayoutKey(actorId, componentId))!.scroll!;
      scroll.setVariable("scrollX", Math.max(0, Math.min(state.maxX, state.x + x)));
      scroll.setVariable("scrollY", Math.max(0, Math.min(state.maxY, state.y + y)));
      layout.update(layerId, world.getActors(), 100);
    }),
  });
  expect(navigation.setFocus(target)).toBe(true);
  expect(scrollOrder).toEqual(["inner", "outer"]);
  expect(inner.getVariable("scrollY")).toBe(4);
  expect(outer.getVariable("scrollY")).toBe(4);
  const after = focusLayoutEntry(layout, world, actor, target)!;
  expect(after.rect.y - after.rect.height / 2).toBeGreaterThanOrEqual(-2);
  expect(after.rect.y + after.rect.height / 2).toBeLessThanOrEqual(2);
});
