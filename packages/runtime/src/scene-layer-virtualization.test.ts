import { describe, expect, it } from "vitest";
import { ClassRegistry, World, type Actor } from "@babylonslate/object-model";
import { SceneLayerLayout } from "./scene-layer-layout";
import { SceneLayerVirtualization } from "./scene-layer-virtualization";

function fixture() {
  const registry = new ClassRegistry();
  for (const id of ["Item", "OtherItem"]) registry.register({ id, parentClassId: "SceneLayerActor", kind: "actor", variables: [], implementedInterfaces: [] });
  const world = new World({ seed: 1, dt: 0.1, classRegistry: registry });
  const root = world.createActor({ guid: "root", classId: "SceneLayerActor", sceneLayerId: "layer" });
  const list = world.createComponent({ guid: "list", classId: "2DVirtualizedListComponent", variables: { width: 4, height: 3, itemClassId: "Item", itemCount: 10_000, overscan: 1 } });
  root.attachComponent(list); world.spawnActorNow(root);
  const layout = new SceneLayerLayout(), virtualization = new SceneLayerVirtualization();
  const removed: Actor[] = [];
  let serial = 0;
  const spawn = (parent: Actor, classId: string, defaults: Record<string, unknown>) => {
    const item = world.createActor({ guid: `item-${++serial}`, classId, sceneLayerId: parent.sceneLayerId, variables: { ...defaults, parentId: parent.guid } });
    item.attachComponent(world.createComponent({ guid: `visual-${serial}`, classId: "2DMaterialComponent" }));
    world.spawnActorNow(item);
    return item;
  };
  const update = () => {
    layout.update("layer", world.getActors(), 100);
    const changed = virtualization.sync("layer", world.getActors(), layout.entries("layer"), spawn, actor => { removed.push(actor); world.destroyActorInstance(actor); });
    world.flushPending();
    layout.update("layer", world.getActors(), 100);
    return changed;
  };
  const items = () => world.getActors().filter(actor => actor !== root && !actor.destroyed);
  return { world, root, list, layout, virtualization, update, items, removed };
}

describe("virtualized SceneLayer actor ownership", () => {
  it("realizes only visible rows, preserves overlapping references and retires offscreen components", () => {
    const f = fixture();
    expect(f.update()).toBe(true);
    expect(f.items().map(actor => actor.getVariable("itemIndex"))).toEqual([0, 1, 2, 3]);
    const kept = f.items().find(actor => actor.getVariable("itemIndex") === 2)!;
    const retired = f.items()[0]!, retiredComponent = retired.components[0]!;
    expect(f.update()).toBe(false);
    f.list.setVariable("scrollY", 2);
    f.update();
    expect(f.items().map(actor => actor.getVariable("itemIndex"))).toEqual([1, 2, 3, 4, 5]);
    expect(f.items().find(actor => actor.getVariable("itemIndex") === 2)).toBe(kept);
    expect(retired.destroyed).toBe(true);
    expect(retiredComponent.destroyed).toBe(true);
    expect(f.layout.entries("layer").get(kept.guid)?.rect.y).toBe(1);
    f.list.setVariable("scrollY", 99999);
    f.update();
    expect(f.items().map(actor => actor.getVariable("itemIndex"))).toEqual([9996, 9997, 9998, 9999]);
    expect(f.items()).toHaveLength(4);
  });

  it("rebuilds changed item classes and releases disabled or removed containers", () => {
    const f = fixture(); f.update();
    const previous = [...f.items()];
    f.list.setVariable("itemClassId", "OtherItem"); f.update();
    expect(previous.every(actor => actor.destroyed)).toBe(true);
    expect(f.items().every(actor => actor.classId === "OtherItem")).toBe(true);
    f.list.setVariable("enabled", false); f.update();
    expect(f.items()).toHaveLength(0);
    f.list.setVariable("enabled", true); f.update();
    expect(f.items()).toHaveLength(4);
    f.list.destroyed = true; f.update();
    expect(f.items()).toHaveLength(0);
  });

  it("does not recurse into an ancestor item class or allocate empty data", () => {
    const f = fixture();
    f.list.setVariable("itemClassId", "SceneLayerActor");
    f.update(); expect(f.items()).toHaveLength(0);
    f.list.setVariable("itemClassId", "Item"); f.list.setVariable("itemCount", 0);
    f.update(); expect(f.items()).toHaveLength(0);
  });
});
