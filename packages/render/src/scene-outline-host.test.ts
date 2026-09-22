import { afterEach, describe, expect, it } from "vitest";
import { Material, MeshBuilder, NullEngine, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import { createActor, createDefaultScene, createMeshComponent, outlineBindings } from "@babylonslate/core";
import { SceneRenderCoordinator } from "./scene-render-coordinator";
import { SceneOutlineHost, isOutlineOnlySceneEdit } from "./scene-outline-host";
import { EditorSceneSync } from "./editor-scene-sync";
import { setSceneRenderSettings } from "./scene-render-mode";
import { GRID_MESH_NAME } from "./editor-grid";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanups.splice(0)) dispose(); });
function setup() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const renderer = new SceneRenderCoordinator(scene);
  const host = new SceneOutlineHost(scene, renderer, () => {});
  cleanups.push(() => { host.dispose(); renderer.dispose(); engine.dispose(); });
  return { scene, host };
}
function authored(actorId: string, width = 2) {
  return outlineBindings(actorId, [{ id: "ink", classId: "OutlineComponent", properties: { color: [1, 0, 0], width } }]);
}

describe("authored scene outline host", () => {
  it("selects triangle visuals without admitting line or wireframe topology", () => {
    const { scene, host } = setup();
    const solid = MeshBuilder.CreateBox("solid", {}, scene);
    const lines = MeshBuilder.CreateLines("lines", { points: [Vector3.Zero(), Vector3.Up()] }, scene);
    const wire = MeshBuilder.CreateBox("wire", {}, scene);
    wire.material = new StandardMaterial("wire", scene);
    wire.material.fillMode = Material.WireFrameFillMode;
    host.replaceActors([{ id: "actor", meshes: [solid, lines, wire], bindings: [] }]);
    host.setSelection(["actor"]);
    expect(host.selection.selected()).toEqual([solid]);
    expect(host.view.contributions.get("selection")?.targets.flatMap(target => target.meshes)).toEqual([solid]);
    host.selection.clear();
    expect(host.view.contributions.has("selection")).toBe(false);
    expect(solid.renderOutline).toBeFalsy();
  });
  it("recognizes only outline edits for the graph-preserving authoring route", () => {
    const previous = createDefaultScene();
    const actor = createActor("a", "A", { components: [createMeshComponent("mesh")] });
    previous.actors = [actor];
    const next = structuredClone(previous);
    next.actors[0]!.components.push({ id: "ink", classId: "OutlineComponent", properties: { width: 3 } });
    next.settings.celShading = { outlinesEnabled: false, outlineWidth: 4 };
    expect(isOutlineOnlySceneEdit(previous, next)).toBe(true);
    next.actors[0]!.transform.position[0] = 3;
    expect(isOutlineOnlySceneEdit(previous, next)).toBe(false);
  });

  it("keeps regular instance model parts while excluding a separately authored child actor", () => {
    const { scene } = setup();
    const sync = new EditorSceneSync(scene, undefined, { freezeActiveMeshes: false });
    const document = createDefaultScene();
    document.actors = [createActor("parent", "Parent", { components: [createMeshComponent("parent-mesh")] }),
      createActor("child", "Child", { parentId: "parent", components: [createMeshComponent("child-mesh")] })];
    sync.apply(document);
    const parent = sync.meshForActor("parent")!, child = sync.meshForActor("child")!;
    const source = MeshBuilder.CreateBox("model-source", {}, scene);
    const part = source.createInstance("model-instance"); part.parent = parent;
    expect(sync.visualMeshesForActor("parent")).toContain(part);
    expect(sync.visualMeshesForActor("parent")).not.toContain(child);
    expect(parent.isWorldMatrixFrozen).toBe(true);
    expect(scene._activeMeshesFrozen).toBe(false);
    sync.dispose();
  });
  it("keeps grouped instance identities and survivors when selection or a component is removed", () => {
    const { scene, host } = setup();
    setSceneRenderSettings(scene, { mode: "cel" });
    const source = MeshBuilder.CreateBox("asset", {}, scene);
    const first = source.createInstance("first"), second = source.createInstance("second");
    const part = MeshBuilder.CreateBox("model-part", {}, scene);
    host.replaceActors([{ id: "a", meshes: [first, part], bindings: authored("a") },
      { id: "b", meshes: [second], bindings: [] }]);
    host.setSelection(["b"]);
    expect(host.view.owner.identityFor(first)).toBe(host.view.owner.identityFor(part));
    expect(host.view.owner.identityFor(second)).not.toBe(host.view.owner.identityFor(first));
    const identity = host.view.owner.identityFor(second);
    host.setActor("a", [first, part], []);
    expect(host.view.contributions.has("component:a:ink")).toBe(false);
    expect(host.view.contributions.get("global")?.targets.map((target) => target.key)).toEqual(["a", "b"]);
    expect(host.selection.selected()).toEqual([second]);
    host.selection.clear();
    expect(host.view.contributions.has("selection")).toBe(false);
    expect(host.view.owner.identityFor(second)).toBe(identity);
    expect(part.renderOutline).toBeFalsy();
  });

  it("updates a late replacement without touching another actor and leaves repeated snapshots unchanged", () => {
    const { scene, host } = setup();
    const a = MeshBuilder.CreateBox("a", {}, scene), b = MeshBuilder.CreateBox("b", {}, scene);
    const bindings = authored("a");
    host.replaceActors([{ id: "a", meshes: [a], bindings }, { id: "b", meshes: [b], bindings: authored("b") }]);
    host.setSelection(["a"]);
    const revision = host.view.revision;
    host.replaceActors([{ id: "a", meshes: [a], bindings }, { id: "b", meshes: [b], bindings: authored("b") }]);
    expect(host.view.revision).toBe(revision);
    a.dispose();
    const loaded = MeshBuilder.CreateBox("loaded-part", {}, scene);
    host.setActor("a", [loaded], bindings);
    expect(host.selection.selected()).toEqual([loaded]);
    expect(host.view.contributions.get("component:b:ink")?.targets[0]?.meshes).toEqual([b]);
    host.removeActor("a");
    expect(host.selection.selected()).toEqual([]);
    expect(host.view.contributions.get("component:b:ink")?.targets[0]?.meshes).toEqual([b]);
  });

  it("preserves the complete host snapshot when replacement identities are rejected", () => {
    const { scene, host } = setup();
    const a = MeshBuilder.CreateBox("a", {}, scene), b = MeshBuilder.CreateBox("b", {}, scene);
    host.replaceActors([{ id: "a", meshes: [a], bindings: authored("a") }]);
    host.setSelection(["a"]);
    const revision = host.view.revision, identity = host.view.owner.identityFor(a);
    expect(() => host.replaceActors([{ id: "b", meshes: [b], bindings: authored("b") },
      { id: "conflict", meshes: [b], bindings: authored("conflict") }])).toThrow(/same actor key/);
    expect(host.view.revision).toBe(revision);
    expect(host.view.owner.identityFor(a)).toBe(identity);
    expect(host.view.contributions.get("component:a:ink")?.targets[0]?.meshes).toEqual([a]);
    host.setSelection([]); host.setSelection(["a"]);
    expect(host.selection.selected()).toEqual([a]);
    expect(host.view.contributions.has("component:b:ink")).toBe(false);
  });

  it("keeps editor guides out of gameplay masks and removes only global CEL on a mode change", () => {
    const { scene, host } = setup();
    const mesh = MeshBuilder.CreateBox("receiver", {}, scene);
    const guide = MeshBuilder.CreateBox(GRID_MESH_NAME, {}, scene);
    setSceneRenderSettings(scene, { mode: "cel" });
    host.replaceActors([{ id: "a", meshes: [mesh, guide], bindings: authored("a") }]);
    host.refreshSettings();
    expect(host.view.meshesForGroup("strict")).toEqual([mesh]);
    setSceneRenderSettings(scene, { mode: "pbr" });
    host.refreshSettings();
    expect(host.view.contributions.has("global")).toBe(false);
    expect(host.view.contributions.has("component:a:ink")).toBe(true);
    host.removeActor("a");
    expect(host.view.active).toBe(false);
  });
});
