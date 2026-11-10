import { afterEach, describe, expect, it, vi } from "vitest";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { ObjectRenderer } from "@babylonjs/core/Rendering/objectRenderer";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { cullOutlineMembers, cullStrictOccluders, writesSceneDepth } from "./shared-outline-occluders";

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
  const cull = (candidates: readonly AbstractMesh[] = [member, front, near, beside], occludes?: (mesh: AbstractMesh) => boolean) =>
    cullStrictOccluders(candidates, (mesh) => mesh === member, camera, 512, 256, 2, list, scratch, occludes);
  const observe = () => { renderer.renderList = list; lightDirty.mockClear(); };
  return { scene, camera, box, member, front, near, beside, list, lightDirty, cull, observe };
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
    const { front, near, list, lightDirty, cull, observe } = setup();
    cull(); observe();
    front.isVisible = false; near.isVisible = true;
    expect(names(cull())).toEqual(["member", "near"]);
    expect(names(list)).toEqual(["member", "near"]);
    // The list never emptied, so Babylon ran no pass over the Scene for it.
    expect(lightDirty).not.toHaveBeenCalled();
  });

  it("follows occluders entering and leaving", () => {
    const { front, near, list, lightDirty, cull, observe } = setup();
    cull(); observe();
    near.isVisible = true;
    expect(names(cull())).toEqual(["member", "front", "near"]);
    front.isVisible = false; near.isVisible = false;
    expect(names(cull())).toEqual(["member"]);
    expect(names(list)).toEqual(["member"]);
    expect(lightDirty).not.toHaveBeenCalled();
  });

  it("follows a new order of the same occluders", () => {
    const { member, front, near, beside, list, lightDirty, cull, observe } = setup();
    near.isVisible = true;
    cull(); observe();
    expect(names(cull([member, near, front, beside]))).toEqual(["member", "near", "front"]);
    expect(names(list)).toEqual(["member", "near", "front"]);
    expect(lightDirty).not.toHaveBeenCalled();
  });

  it("tells Babylon nothing when the list fills: no light define reads a mask's list", () => {
    const { member, list, lightDirty, cull, observe } = setup();
    member.isVisible = false;
    expect(cull()).toHaveLength(0);
    observe();
    member.isVisible = true;
    expect(names(cull())).toEqual(["member", "front"]);
    expect(names(list)).toEqual(["member", "front"]);
    // What a mask draws comes and goes with the view: a pass over the Scene's meshes each time would cost a hitch.
    expect(lightDirty).not.toHaveBeenCalled();
  });

  it("draws, over a mask seeded from the scene's depth, only the occluders that depth lacks, and every member", () => {
    const { scene, member, front, near, cull } = setup();
    near.isVisible = true;
    const glass = new StandardMaterial("glass", scene);
    glass.alpha = 0.5;
    near.material = glass;
    // The opaque box in front is in the scene's depth already; the blended one is not.
    expect(names(cull(undefined, (mesh) => !writesSceneDepth(mesh)))).toEqual(["member", "near"]);
    // A member is drawn whatever the scene's depth holds of it: the mask needs its identity.
    member.material = glass;
    front.material = glass;
    expect(names(cull(undefined, (mesh) => !writesSceneDepth(mesh)))).toEqual(["member", "front", "near"]);
    expect(names(cull(undefined, () => false))).toEqual(["member"]);
  });
});

/**
 * The camera sees 8.46 units to either side of the origin at the members' depth (a 512 by 256 view, 0.8 radians tall).
 */
describe("members the view cannot show", () => {
  it("leaves out a member beside the screen, and the meshes that could only hide that one", () => {
    const { camera, box, member, front } = setup();
    const away = box("away", 20, 0), edge = box("edge", 3.5, -5);
    const members = new Set<AbstractMesh>([member, away]);
    const cull = () => names(cullStrictOccluders([member, front, edge, away], (mesh) => members.has(mesh), camera, 512, 256, 2));
    // `edge` sits between the camera and the way to `away`, on screen: it can hide no pixel of `member`.
    expect(cull()).toEqual(["member", "front"]);
    // Back in view, `away` is drawn, and so is what stands before it.
    away.position.x = 7; away.computeWorldMatrix(true);
    expect(cull()).toEqual(["member", "away", "front", "edge"]);
  });

  it("keeps a member beside the screen by less than its stroke", () => {
    const { camera, box, member } = setup();
    // Its nearest edge is 1.4% of the half width past the screen's: 3.5 pixels of a 512 pixel view.
    const beyond = box("beyond", 9.5, 0);
    const cull = (paddingPx: number) => names(cullStrictOccluders([member, beyond], () => true, camera, 512, 256, paddingPx));
    expect(cull(2)).toEqual(["member"]);
    expect(cull(8)).toEqual(["member", "beyond"]);
  });

  it("leaves out a member behind the camera, and keeps one that crosses its plane", () => {
    const { camera, box, member } = setup();
    // `across` straddles the camera's plane off to one side: the corners before the camera project beside the screen,
    // which says nothing of where the rest of it shows.
    const behind = box("behind", 0, -20), across = box("across", 3, -10);
    expect(names(cullStrictOccluders([member, behind, across], () => true, camera, 512, 256, 2))).toEqual(["member", "across"]);
  });

  it("keeps a member that is drawn whatever the view: its bounds do not say where it draws", () => {
    const { camera, box, member } = setup();
    const skinned = box("skinned", 20, 0), sky = box("sky", 0, -20);
    skinned.alwaysSelectAsActiveMesh = true;
    sky.infiniteDistance = true;
    expect(names(cullStrictOccluders([member, skinned, sky], () => true, camera, 512, 256, 2))).toEqual(["member", "skinned", "sky"]);
  });

  it("narrows a group without occluders the same way, in the list Babylon observes", () => {
    const { camera, box, member, lightDirty } = setup();
    const away = box("away", 20, 0);
    const list: AbstractMesh[] = [], scratch: AbstractMesh[] = [];
    const renderer = new ObjectRenderer("through", camera.getScene());
    cleanups.push(() => renderer.dispose());
    const cull = () => cullOutlineMembers([member, away], camera, 512, 256, 2, list, scratch);
    expect(names(cull())).toEqual(["member"]);
    renderer.renderList = list;
    lightDirty.mockClear();
    expect(cull()).toBe(list);
    // Its only member in view leaves and comes back: the list empties and fills, and Babylon runs no pass for it.
    member.position.x = -20; member.computeWorldMatrix(true);
    expect(cull()).toHaveLength(0);
    member.position.x = 0; member.computeWorldMatrix(true);
    away.position.x = 7; away.computeWorldMatrix(true);
    expect(names(cull())).toEqual(["member", "away"]);
    expect(lightDirty).not.toHaveBeenCalled();
  });
});

describe("what the colour pass writes into the scene's depth", () => {
  function fixture() {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    cleanups.push(() => { scene.dispose(); engine.dispose(); });
    const mesh = MeshBuilder.CreateBox("mesh", {}, scene);
    const material = (name: string, edit: (material: StandardMaterial) => void = () => {}) => {
      const created = new StandardMaterial(name, scene);
      edit(created);
      return created;
    };
    return { scene, mesh, material };
  }

  it.each([
    ["an opaque Material", () => {}, true],
    ["an alpha-tested Material", (material: StandardMaterial) => { material.transparencyMode = StandardMaterial.MATERIAL_ALPHATEST; }, true],
    ["a blended Material", (material: StandardMaterial) => { material.alpha = 0.5; }, false],
    ["a blended Material with a depth pre-pass", (material: StandardMaterial) => { material.alpha = 0.5; material.needDepthPrePass = true; }, true],
    ["a blended Material that forces its depth write", (material: StandardMaterial) => { material.alpha = 0.5; material.forceDepthWrite = true; }, true],
    ["an opaque Material that writes no depth", (material: StandardMaterial) => { material.disableDepthWrite = true; }, false],
  ] as const)("holds a mesh drawn with %s: %s", (_name, edit, expected) => {
    const { mesh, material } = fixture();
    mesh.material = material("material", edit);
    expect(writesSceneDepth(mesh)).toBe(expected);
  });

  it("holds a mesh without a Material, and not a mesh faded by its own visibility", () => {
    const { mesh, material } = fixture();
    expect(writesSceneDepth(mesh)).toBe(true);
    mesh.material = material("opaque");
    mesh.visibility = 0.5;
    expect(writesSceneDepth(mesh)).toBe(false);
  });

  it("holds a multi-Material mesh only when every part writes its depth", () => {
    const { scene, mesh, material } = fixture();
    const parts = new MultiMaterial("parts", scene);
    parts.subMaterials = [material("solid"), null, material("solid too")];
    mesh.material = parts;
    expect(writesSceneDepth(mesh)).toBe(true);
    parts.subMaterials = [material("solid"), material("glass", (glass) => { glass.alpha = 0.5; })];
    expect(writesSceneDepth(mesh)).toBe(false);
  });
});
