import { describe, expect, it } from "vitest";
import { ClassRegistry, World } from "@babylonslate/object-model";
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
