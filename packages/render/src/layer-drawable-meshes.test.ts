import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { afterEach, describe, expect, it } from "vitest";
import { keepLayerDrawableMeshes, layerDrawableMeshes, layerDrawableMeshWork, verifyLayerDrawableMeshes } from "./layer-drawable-meshes";

/**
 * A HUD as the compositor builds one: an actor root that draws nothing and is hidden, its drawn child, a disabled form
 * control part under it, and a second visible actor.
 */
function hud() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  new UniversalCamera("camera", new Vector3(0, 0, -10), scene);
  const root = new Mesh("actor-1", scene);
  root.isVisible = false;
  const label = MeshBuilder.CreatePlane("label", { size: 1 }, scene);
  label.parent = root;
  const caret = MeshBuilder.CreatePlane("caret", { size: 1 }, scene);
  caret.parent = root;
  caret.setEnabled(false);
  const icon = MeshBuilder.CreatePlane("icon", { size: 1 }, scene);
  keepLayerDrawableMeshes(scene);
  return { engine, scene, root, label, caret, icon };
}

const names = (meshes: readonly AbstractMesh[] | undefined) => meshes?.map((mesh) => mesh.name);
/** What the list must hold: the Scene's enabled, visible meshes in its order. */
const filtered = (scene: Scene) => scene.meshes.filter((mesh) => mesh.isEnabled() && mesh.isVisible).map((mesh) => mesh.name);

describe("layer drawable meshes", () => {
  const engines: NullEngine[] = [];
  afterEach(() => {
    verifyLayerDrawableMeshes(false);
    while (engines.length) engines.pop()!.dispose();
  });

  function make() {
    const made = hud();
    engines.push(made.engine);
    return made;
  }

  it("lists only the meshes that can draw, in the Scene's order", () => {
    const { scene } = make();
    expect(names(layerDrawableMeshes(scene))).toEqual(["label", "icon"]);
    expect(names(scene.getActiveMeshCandidates().data as AbstractMesh[])?.slice(0, scene.getActiveMeshCandidates().length)).toEqual(["label", "icon"]);
  });

  it.each<[string, (made: ReturnType<typeof hud>) => void, string[]]>([
    ["a hidden root gains a drawable child", ({ scene, root }) => {
      const badge = MeshBuilder.CreatePlane("badge", { size: 1 }, scene);
      badge.parent = root;
    }, ["label", "icon", "badge"]],
    ["a disabled control part is enabled", ({ caret }) => caret.setEnabled(true), ["label", "caret", "icon"]],
    ["its parent is disabled", ({ root }) => root.setEnabled(false), ["icon"]],
    ["a mesh is added", ({ scene }) => MeshBuilder.CreatePlane("added", { size: 1 }, scene), ["label", "icon", "added"]],
    ["a mesh is removed", ({ label }) => label.dispose(), ["icon"]],
    ["a mesh is hidden", ({ label }) => { label.isVisible = false; }, ["icon"]],
    ["a hidden mesh is shown", ({ root }) => { root.isVisible = true; }, ["actor-1", "label", "icon"]],
    ["a child that inherits visibility is re-parented under a hidden root", ({ icon, root }) => {
      icon.inheritVisibility = true;
      icon.parent = root;
    }, ["label"]],
    ["a child that inherits visibility of a hidden transform node", ({ scene, icon }) => {
      const node = new TransformNode("node", scene);
      icon.inheritVisibility = true;
      icon.parent = node;
      node.isVisible = false;
    }, ["label"]],
    ["a mesh is given geometry or a Material", ({ scene, root, label }) => {
      label.geometry!.applyToMesh(root);
      label.material = new StandardMaterial("material", scene);
    }, ["label", "icon"]],
  ])("follows the frame %s", (_name, change, expected) => {
    const made = make();
    layerDrawableMeshes(made.scene);
    change(made);
    expect(names(layerDrawableMeshes(made.scene))).toEqual(expected);
    expect(names(layerDrawableMeshes(made.scene))).toEqual(filtered(made.scene));
    expect(layerDrawableMeshWork(made.scene)!.mismatches).toBe(0);
  });

  it("keeps a mesh whose writes the journal cannot hear whatever its state", () => {
    const { scene, label } = make();
    // A class or object that redefines the visibility write (as a splat part's proxy does).
    let shown = true;
    Object.defineProperty(label, "isVisible", { get: () => shown, set: (value: boolean) => { shown = value; }, configurable: true });
    MeshBuilder.CreatePlane("added", { size: 1 }, scene);
    layerDrawableMeshes(scene);
    label.isVisible = false;
    expect(names(layerDrawableMeshes(scene))).toEqual(["label", "icon", "added"]);
  });

  it("checks against a full filter while verifying, and every 32nd frame otherwise, healing and counting a difference", () => {
    const { engine, scene, label, icon } = make();
    const unheard = (mesh: AbstractMesh) => {
      // A write past every hooked setter: nothing tells the list.
      (mesh as unknown as { _nodeDataStorage: { _isVisible: boolean } })._nodeDataStorage._isVisible = false;
    };
    layerDrawableMeshes(scene);
    unheard(label);
    engine.endFrame();
    expect(names(layerDrawableMeshes(scene))).toEqual(["label", "icon"]);
    for (let frame = 0; frame < 32; frame += 1) {
      engine.endFrame();
      layerDrawableMeshes(scene);
    }
    expect(names(layerDrawableMeshes(scene))).toEqual(["icon"]);
    expect(layerDrawableMeshWork(scene)).toMatchObject({ mismatches: 1, extraMembers: 1, missingMembers: 0, misordered: 0 });

    verifyLayerDrawableMeshes(true);
    unheard(icon);
    engine.endFrame();
    expect(names(layerDrawableMeshes(scene))).toEqual([]);
    expect(layerDrawableMeshWork(scene)).toMatchObject({ mismatches: 2, extraMembers: 2 });
  });

  it("computes a hidden root's world matrix with its drawn child's, as Babylon's loop did", () => {
    const { scene, root, label, caret } = make();
    label.position.x = 1;
    scene.render();
    root.position.x = 5;
    scene.render();
    // Read from the cache: the frame itself must have computed both.
    expect(label.worldMatrixFromCache.m[12]).toBe(6);
    expect(root.worldMatrixFromCache.m[12]).toBe(5);
    // A disabled part is computed when it can draw again, as before.
    caret.setEnabled(true);
    scene.render();
    expect(caret.worldMatrixFromCache.m[12]).toBe(5);
  });

  it("stops serving a disposed Scene", () => {
    const { scene } = make();
    scene.dispose();
    expect(layerDrawableMeshes(scene)).toBeUndefined();
    expect(layerDrawableMeshWork(scene)).toBeNull();
  });
});
