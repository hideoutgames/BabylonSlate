import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene } from "@haptic/core";
import { createActorDisplayNamesSelector } from "./scene-actor-names";

function sceneWith(...actors: Array<[string, string]>) {
  const scene = createDefaultScene();
  scene.actors = actors.map(([id, name]) => createActor(id, name));
  return scene;
}

describe("createActorDisplayNamesSelector", () => {
  it("keeps its names while ids and names are unchanged, and names again when either changes", () => {
    const select = createActorDisplayNamesSelector();
    const first = select(sceneWith(["a", "Box"], ["b", "Box"], ["c", "Lamp"]));
    expect([...first]).toEqual([["a", "Box (a)"], ["b", "Box (b)"], ["c", "Lamp"]]);

    // A transform edit: new actor objects, same ids and names.
    const moved = sceneWith(["a", "Box"], ["b", "Box"], ["c", "Lamp"]);
    moved.actors[0] = { ...moved.actors[0]!, transform: { ...moved.actors[0]!.transform, position: [4, 0, 0] } };
    expect(select(moved)).toBe(first);

    expect([...select(sceneWith(["a", "Box"], ["b", "Crate"], ["c", "Lamp"]))]).toEqual([["a", "Box"], ["b", "Crate"], ["c", "Lamp"]]);
    expect([...select(sceneWith(["a", "Box"], ["c", "Lamp"], ["b", "Crate"]))].map(([id]) => id)).toEqual(["a", "c", "b"]);
    expect([...select(sceneWith(["a", "Box"]))]).toEqual([["a", "Box"]]);
    expect(select(null).size).toBe(0);
  });
});
