import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { ObjectRenderer } from "@babylonjs/core/Rendering/objectRenderer";
import { Scene } from "@babylonjs/core/scene";
import { rewriteRenderList, writeRenderListEntry } from "./observed-render-list";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanups.splice(0)) dispose(); });

const names = (meshes: readonly Mesh[]) => meshes.map((mesh) => mesh.name);

/**
 * Four meshes and a list that `renderers` of Babylon's object renderers draw. `lightDirty` counts the passes over the
 * Scene's meshes Babylon runs when it sees the list empty or fill: each marks every mesh, `bystander` included.
 */
function setup(initial: readonly string[], renderers = 1) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const meshes = Object.fromEntries(["a", "b", "c", "d"].map((name) => [name, MeshBuilder.CreateBox(name, {}, scene)])) as Record<string, Mesh>;
  const bystander = MeshBuilder.CreateBox("bystander", {}, scene);
  const list = initial.map((name) => meshes[name]!);
  for (let index = 0; index < renderers; index++) {
    const renderer = new ObjectRenderer(`renderer ${index}`, scene);
    renderer.renderList = list;
    cleanups.push(() => renderer.dispose());
  }
  cleanups.push(() => { scene.dispose(); engine.dispose(); });
  const lightDirty = vi.spyOn(bystander, "_markSubMeshesAsLightDirty");
  const pick = (...picked: string[]) => picked.map((name) => meshes[name]!);
  return { list, lightDirty, pick };
}

describe("a render list Babylon observes", () => {
  it("marks every mesh's lights dirty once per renderer when a populated list is emptied and refilled by push", () => {
    // The cost the helpers avoid: without it the assertions below would hold for any way of writing the list.
    const { list, lightDirty, pick } = setup(["a", "b"], 2);
    list.length = 0;
    for (const mesh of pick("a", "c")) list.push(mesh);
    expect(lightDirty).toHaveBeenCalledTimes(2);
  });

  it.each([
    { title: "replaces entries", next: ["a", "c"] },
    { title: "grows", next: ["a", "b", "c", "d"] },
    { title: "shrinks", next: ["d"] },
    { title: "reorders", next: ["b", "a"] },
  ])("$title of a populated list without a pass over the Scene", ({ next }) => {
    const { list, lightDirty, pick } = setup(["a", "b"], 2);
    expect(rewriteRenderList(list, pick(...next))).toBe(list);
    expect(names(list)).toEqual(next);
    expect(lightDirty).not.toHaveBeenCalled();
  });

  it("keeps only the entries the filter accepts, in order", () => {
    const { list, lightDirty, pick } = setup(["a", "b"]);
    rewriteRenderList(list, pick("d", "c", "b", "a"), (mesh) => mesh.name !== "c" && mesh.name !== "a");
    expect(names(list)).toEqual(["d", "b"]);
    expect(lightDirty).not.toHaveBeenCalled();
  });

  it("still tells Babylon when an empty list fills, once per renderer", () => {
    const { list, lightDirty, pick } = setup([], 2);
    rewriteRenderList(list, pick("a", "b", "c"));
    expect(names(list)).toEqual(["a", "b", "c"]);
    expect(lightDirty).toHaveBeenCalledTimes(2);
  });

  it("empties a list without a pass over the Scene, and fills it again as an empty list", () => {
    const { list, lightDirty, pick } = setup(["a", "b"]);
    rewriteRenderList(list, []);
    expect(list).toHaveLength(0);
    expect(lightDirty).not.toHaveBeenCalled();
    rewriteRenderList(list, pick("c"));
    expect(names(list)).toEqual(["c"]);
    expect(lightDirty).toHaveBeenCalledTimes(1);
  });

  it("writes entry by entry for a caller that filters as it goes", () => {
    const { list, lightDirty, pick } = setup(["a", "b", "c"]);
    let count = 0;
    for (const mesh of pick("c", "d")) writeRenderListEntry(list, count++, mesh);
    list.length = count;
    expect(names(list)).toEqual(["c", "d"]);
    expect(lightDirty).not.toHaveBeenCalled();
  });
});
