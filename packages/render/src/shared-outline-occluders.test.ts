import { afterEach, describe, expect, it, vi } from "vitest";
import { MeshBuilder, NullEngine, Scene, UniversalCamera, Vector3, type AbstractMesh } from "@babylonjs/core";
import { ObjectRenderer } from "@babylonjs/core/Rendering/objectRenderer";
import { cullStrictOccluders } from "./shared-outline-occluders";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanups.splice(0)) dispose(); });

const names = (meshes: readonly AbstractMesh[]) => meshes.map((mesh) => mesh.name);

/**
 * One member at the origin seen from -10 on Z; `front` and `near` sit between it and the camera and cover it, `beside`
 * is next to it on screen and cannot. `near` starts hidden. `list` is what an outline mask pass hands to Babylon's
 * ObjectRenderer; `lightDirty` counts the whole-scene light invalidations Babylon runs when it sees that list refill.
 */
function setup() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new UniversalCamera("camera", new Vector3(0, 0, -10), scene);
  camera.setTarget(Vector3.Zero());
  const box = (name: string, x: number, z: number) => {
    const mesh = MeshBuilder.CreateBox(name, {}, scene);
    mesh.position.set(x, 0, z);
    mesh.computeWorldMatrix(true);
    return mesh;
  };
  const member = box("member", 0, 0), front = box("front", 0, -5), near = box("near", 0.2, -3), beside = box("beside", 5, 0);
  near.isVisible = false;
  const renderer = new ObjectRenderer("occluders", scene);
  cleanups.push(() => { renderer.dispose(); scene.dispose(); engine.dispose(); });
  const list: AbstractMesh[] = [], scratch: AbstractMesh[] = [];
  const lightDirty = vi.spyOn(member, "_markSubMeshesAsLightDirty");
  const cull = (candidates: readonly AbstractMesh[] = [member, front, near, beside]) =>
    cullStrictOccluders(candidates, (mesh) => mesh === member, camera, 512, 256, 2, list, scratch);
  const observe = () => { renderer.renderList = list; lightDirty.mockClear(); };
  return { member, front, near, beside, list, lightDirty, cull, observe };
}

describe("strict occluder cull and the render list Babylon observes", () => {
  it("leaves the observed list alone while the occluders do not change", () => {
    const { list, lightDirty, cull, observe } = setup();
    expect(names(cull())).toEqual(["member", "front"]);
    observe();
    for (let frame = 0; frame < 3; frame++) expect(cull()).toBe(list);
    expect(names(list)).toEqual(["member", "front"]);
    expect(lightDirty).not.toHaveBeenCalled();
  });

  it("replaces an occluder with another when the count stays the same", () => {
    const { front, near, list, cull, observe } = setup();
    cull(); observe();
    front.isVisible = false; near.isVisible = true;
    expect(names(cull())).toEqual(["member", "near"]);
    expect(names(list)).toEqual(["member", "near"]);
  });

  it("follows occluders entering and leaving", () => {
    const { front, near, list, cull, observe } = setup();
    cull(); observe();
    near.isVisible = true;
    expect(names(cull())).toEqual(["member", "front", "near"]);
    front.isVisible = false; near.isVisible = false;
    expect(names(cull())).toEqual(["member"]);
    expect(names(list)).toEqual(["member"]);
  });

  it("follows a new order of the same occluders", () => {
    const { member, front, near, beside, list, cull, observe } = setup();
    near.isVisible = true;
    cull(); observe();
    expect(names(cull([member, near, front, beside]))).toEqual(["member", "near", "front"]);
    expect(names(list)).toEqual(["member", "near", "front"]);
  });

  it("still tells Babylon when the list goes from empty to populated", () => {
    const { member, list, lightDirty, cull, observe } = setup();
    member.isVisible = false;
    expect(cull()).toHaveLength(0);
    observe();
    member.isVisible = true;
    expect(names(cull())).toEqual(["member", "front"]);
    expect(names(list)).toEqual(["member", "front"]);
    expect(lightDirty).toHaveBeenCalled();
  });
});
