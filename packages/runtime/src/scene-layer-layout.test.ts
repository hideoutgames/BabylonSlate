import { describe, expect, it, vi } from "vitest";
import { ClassRegistry, World, type Actor, type ActorComponent } from "@babylonslate/object-model";
import { SceneLayerLayout } from "./scene-layer-layout";

function row(world: World, layerId: string, id: string, authoredX: number) {
  const actor = world.createActor({ guid: id, classId: "SceneLayerActor", sceneLayerId: layerId });
  const box = world.createComponent({ guid: "box", classId: "2DHorizontalBoxComponent", variables: { width: 4, height: 2 } });
  const child = world.createComponent({ guid: "child", classId: "2DButtonComponent", parentId: "box" });
  child.transform.position.x = authoredX;
  actor.attachComponent(box); actor.attachComponent(child); world.spawnActorNow(actor);
  return { actor, box, child };
}

describe("runtime layout ownership", () => {
  it("serializes only layout inputs, ignores cyclic runtime references, and preserves authored poses per live owner", () => {
    const world = new World({ seed: 1, dt: 0.1, classRegistry: new ClassRegistry() });
    const layout = new SceneLayerLayout();
    const a = row(world, "layer-a", "a", 7);
    const b = row(world, "layer-b", "b", 9);
    a.child.setVariable("target", a.actor);
    expect(() => layout.update("layer-a", world.getActors(), 100)).not.toThrow();
    layout.update("layer-b", world.getActors(), 100);
    a.child.setVariable("otherRuntimeObject", { self: a.child });
    expect(layout.update("layer-a", world.getActors(), 100)).toBeNull();
    a.box.destroyed = true; a.child.parentId = null;
    layout.update("layer-a", world.getActors(), 100);
    expect(a.child.transform.position.x).toBe(7);
    expect(b.child.transform.position.x).not.toBe(9);
  });

  it("arranges replacement objects even when their serialized source matches the previous instance", () => {
    const world = new World({ seed: 1, dt: 0.1, classRegistry: new ClassRegistry() });
    const layout = new SceneLayerLayout();
    const first = row(world, "layer", "actor", 7);
    layout.update("layer", [first.actor], 100);
    const replacementWorld = new World({ seed: 2, dt: 0.1, classRegistry: new ClassRegistry() });
    const replacement = row(replacementWorld, "layer", "actor", 7);
    expect(layout.update("layer", [replacement.actor], 100)).not.toBeNull();
    expect(replacement.child.transform.position.x).toBe(-1.5);
    expect(layout.update("layer", [replacement.actor], 100)).toBeNull();
  });
});

describe("unchanged layer detection", () => {
  function settled() {
    const world = new World({ seed: 1, dt: 0.1, classRegistry: new ClassRegistry() });
    const layout = new SceneLayerLayout();
    const owner = row(world, "layer", "a", 7);
    expect(layout.update("layer", world.getActors(), 100)).not.toBeNull();
    return { world, layout, ...owner, update: () => layout.update("layer", world.getActors(), 100) };
  }
  const readsVariables = (...owners: Array<Actor | ActorComponent>) => owners.map((owner) => vi.spyOn(owner, "getVariable"));

  it("reads no variable of a layer nothing wrote to, and ignores rewriting a value with itself", () => {
    const f = settled();
    f.actor.setVariable("visible", true);
    f.update();
    const reads = readsVariables(f.actor, f.box, f.child);
    expect(f.update()).toBeNull();
    f.box.setVariable("width", 4);
    f.actor.setVariable("visible", true);
    expect(f.update()).toBeNull();
    expect(reads.flatMap((read) => read.mock.calls)).toHaveLength(0);
  });

  it("arranges again after a variable write, then settles", () => {
    const f = settled();
    f.box.setVariable("width", 8);
    expect(f.update()).not.toBeNull();
    expect(f.child.transform.position.x).toBe(-3.5);
    const reads = readsVariables(f.actor, f.box, f.child);
    expect(f.update()).toBeNull();
    expect(reads.flatMap((read) => read.mock.calls)).toHaveLength(0);
  });

  it("settles after a write the layout does not read instead of re-checking every tick", () => {
    const f = settled();
    f.child.setVariable("hoverCount", 1);
    expect(f.update()).toBeNull();
    const reads = readsVariables(f.child);
    expect(f.update()).toBeNull();
    expect(reads[0]!.mock.calls).toHaveLength(0);
  });

  it.each([
    ["an actor position", (f: ReturnType<typeof settled>) => { f.actor.transform.position.y = 3; }],
    ["an actor scale", (f: ReturnType<typeof settled>) => { f.actor.transform.scale.x = 2; }],
    ["a component rotation", (f: ReturnType<typeof settled>) => { f.child.transform.rotation.z = 0.5; f.child.transform.rotation.w = Math.sqrt(0.75); }],
    ["a component position", (f: ReturnType<typeof settled>) => { f.child.transform.position.y = 2; }],
    ["a component's parent", (f: ReturnType<typeof settled>) => { f.child.parentId = null; }],
  ])("arranges again after %s changes in place, then settles", (_, change) => {
    const f = settled();
    change(f);
    expect(f.update()).not.toBeNull();
    expect(f.update()).toBeNull();
  });

  it("keeps a script's in-place pose edit as the design pose", () => {
    const f = settled();
    f.actor.transform.position.y = 3;
    f.update();
    expect(f.actor.transform.position.y).toBe(3);
    expect(f.update()).toBeNull();
    expect(f.actor.transform.position.y).toBe(3);
  });

  it("arranges the actors and components it is given when the list changes", () => {
    const f = settled();
    const extra = f.world.createActor({ guid: "extra", classId: "SceneLayerActor", sceneLayerId: "layer" });
    f.world.spawnActorNow(extra);
    expect(f.update()).not.toBeNull();
    const added = f.world.createComponent({ guid: "added", classId: "2DButtonComponent", parentId: "box" });
    f.actor.attachComponent(added);
    expect(f.update()).not.toBeNull();
    added.destroyed = true;
    expect(f.update()).not.toBeNull();
    expect(f.update()).toBeNull();
  });

  it("re-fits to a safe area or pixel density that changed", () => {
    const world = new World({ seed: 1, dt: 0.1, classRegistry: new ClassRegistry() });
    const layout = new SceneLayerLayout();
    const actor = world.createActor({ guid: "screen", classId: "SceneLayerActor", sceneLayerId: "layer" });
    actor.attachComponent(world.createComponent({ guid: "safe", classId: "2DSafeAreaComponent", variables: { width: 10, height: 10 } }));
    actor.attachComponent(world.createComponent({ guid: "content", classId: "2DMaterialComponent", parentId: "safe", variables: { widthMode: "fill", heightMode: "fill" } }));
    world.spawnActorNow(actor);
    const update = (ppu: number, insets: { left?: number; top?: number }) => layout.update("layer", world.getActors(), ppu, {}, insets);
    const content = () => layout.entries("layer").get("screen/content")?.rect;
    expect(update(100, {})).not.toBeNull();
    expect(content()).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(update(100, {})).toBeNull();
    expect(update(100, { left: 1, top: 2 })).not.toBeNull();
    expect(content()).toEqual({ x: 0.5, y: -1, width: 9, height: 8 });
    expect(update(100, { left: 1, top: 2 })).toBeNull();
    expect(update(100, { left: 0, top: 0 })).not.toBeNull();
    expect(content()).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(update(50, { left: 0, top: 0 })).not.toBeNull();
  });

  it("re-measures a texture whose size loads or changes after the layer was laid out", () => {
    const world = new World({ seed: 1, dt: 0.1, classRegistry: new ClassRegistry() });
    const layout = new SceneLayerLayout();
    const actor = world.createActor({ guid: "icon", classId: "SceneLayerActor", sceneLayerId: "layer" });
    actor.attachComponent(world.createComponent({ guid: "tex", classId: "2DTextureComponent", variables: { textureGuid: "atlas" } }));
    world.spawnActorNow(actor);
    const sizes: Record<string, { width: number; height: number }> = {};
    const update = () => layout.update("layer", world.getActors(), 100, sizes);
    const width = () => layout.entries("layer").get("icon/tex")?.rect.width;
    expect(update()).not.toBeNull();
    expect(update()).toBeNull();
    sizes.atlas = { width: 200, height: 100 };
    expect(update()).not.toBeNull();
    expect(width()).toBe(2);
    expect(update()).toBeNull();
    sizes.atlas = { width: 400, height: 100 };
    expect(update()).not.toBeNull();
    expect(width()).toBe(4);
    sizes.atlas!.width = 600;
    expect(update()).not.toBeNull();
    expect(width()).toBe(6);
    expect(update()).toBeNull();
  });
});
