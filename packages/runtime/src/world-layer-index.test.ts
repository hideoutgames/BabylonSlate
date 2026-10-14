import { describe, expect, it } from "vitest";
import { ClassRegistry, World, type Actor } from "@babylonslate/object-model";
import { sceneLayerActors } from "./world-layer-index";

function newWorld(): World {
  return new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
}

function spawn(world: World, guid: string, sceneLayerId: string | null): Actor {
  return world.spawnActorNow(world.createActor({ classId: "Actor", guid, sceneLayerId }));
}

const guids = (actors: readonly Actor[]) => actors.map((actor) => actor.guid);

describe("Scene Layer actor index", () => {
  it("lists each layer's actors in world order, apart from the main world's and other layers'", () => {
    const world = newWorld();
    for (const [guid, layer] of [["a1", "A"], ["main", null], ["b1", "B"], ["a2", "A"], ["b2", "B"]] as const) spawn(world, guid, layer);
    expect(guids(sceneLayerActors(world, "A"))).toEqual(["a1", "a2"]);
    expect(guids(sceneLayerActors(world, "B"))).toEqual(["b1", "b2"]);
    expect(sceneLayerActors(world, "absent")).toEqual([]);
  });

  it("follows spawns, destroys and reassignments, and leaves a list already handed out unchanged", () => {
    const world = newWorld();
    spawn(world, "a1", "A");
    const moving = spawn(world, "moving", null);
    const before = sceneLayerActors(world, "A");
    expect(guids(before)).toEqual(["a1"]);

    spawn(world, "a2", "A");
    expect(guids(sceneLayerActors(world, "A"))).toEqual(["a1", "a2"]);
    expect(guids(before)).toEqual(["a1"]);

    // An actor reassigned in place joins its layer once the structure change is announced, at its world position.
    moving.sceneLayerId = "A";
    world.markStructureChanged();
    expect(guids(sceneLayerActors(world, "A"))).toEqual(["a1", "moving", "a2"]);
    moving.sceneLayerId = "B";
    world.markStructureChanged();
    expect(guids(sceneLayerActors(world, "A"))).toEqual(["a1", "a2"]);
    expect(guids(sceneLayerActors(world, "B"))).toEqual(["moving"]);

    world.destroyActor("a1");
    world.flushPending();
    expect(guids(sceneLayerActors(world, "A"))).toEqual(["a2"]);
  });

  it("keeps each World's index separate", () => {
    const first = newWorld();
    const second = newWorld();
    spawn(first, "one", "A");
    spawn(second, "two", "A");
    expect(guids(sceneLayerActors(first, "A"))).toEqual(["one"]);
    expect(guids(sceneLayerActors(second, "A"))).toEqual(["two"]);
  });
});
