import { afterEach, describe, expect, it, vi } from "vitest";
import { Mesh, NullEngine, Scene } from "@babylonjs/core";
import { createActor, createDefaultScene, parseDeformerProperties, type DeformerBinding } from "@babylonslate/core";

// The host owns identity and transactions. GPU allocation is the boundary;
// shader, texture and pixels are exercised by the renderer/browser proofs.
const gpu = vi.hoisted(() => ({ active: new Map<object, unknown>(), reject: undefined as object | undefined }));
vi.mock("./lattice-deformer", () => ({
  setMeshLatticeDeformer(mesh: object, config: unknown) {
    if (mesh === gpu.reject && config) throw new Error("GPU allocation rejected");
    if (config) gpu.active.set(mesh, config); else gpu.active.delete(mesh);
  },
  disposeMeshLatticeDeformer(mesh: object) { gpu.active.delete(mesh); },
  refreshMeshLatticeDeformer() {},
}));
import { SceneDeformerHost, isDeformerOnlySceneEdit } from "./scene-deformer-host";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); gpu.active.clear(); gpu.reject = undefined; });
const binding = (target: string, strength = 1): DeformerBinding => ({ id: `cage-${target}`,
  ...parseDeformerProperties({ enabled: true, targetMeshComponentId: target, strength }) });
function setup() {
  const engine = new NullEngine(); engines.push(engine);
  const scene = new Scene(engine), host = new SceneDeformerHost(scene);
  return { scene, host };
}

describe("scene deformer ownership", () => {
  it("keeps control edits on the live path while material and attachment changes require reconciliation", () => {
    const previous = createDefaultScene();
    previous.actors = [createActor("owner", "Owner", { components: [
      { id: "mesh", classId: "MeshComponent", properties: { meshKind: "box" } },
      { id: "cage", classId: "DeformerComponent", properties: { targetMeshComponentId: "mesh", strength: 1 } },
    ] })];
    const next = structuredClone(previous);
    next.actors[0]!.components[1]!.properties.strength = 0.5;
    expect(isDeformerOnlySceneEdit(previous, next)).toBe(true);
    next.actors[0]!.components[0]!.properties.materialAssetGuid = "new-material";
    expect(isDeformerOnlySceneEdit(previous, next)).toBe(false);
    delete next.actors[0]!.components[0]!.properties.materialAssetGuid;
    next.actors[0]!.components[1]!.parentId = "mesh";
    expect(isDeformerOnlySceneEdit(previous, next)).toBe(false);
  });
  it("rebinds a retained component to its asynchronously replaced visual without affecting siblings", () => {
    const { scene, host } = setup();
    const first = new Mesh("First Model", scene), sibling = new Mesh("Sibling Model", scene);
    const roots = new Map([["first", first], ["sibling", sibling]]);
    const resolve = (id: string) => roots.get(id) ?? null;
    host.setActor("actor", [binding("first"), binding("sibling", 0.25)], resolve);
    const replacement = new Mesh("Replacement Model", scene); roots.set("first", replacement);
    host.setActor("actor", [binding("first", 0.5), binding("sibling", 0.25)], resolve, true);
    expect(gpu.active.has(first)).toBe(false);
    expect(gpu.active.get(replacement)).toMatchObject({ strength: 0.5, targetMeshComponentId: "first" });
    expect(gpu.active.get(sibling)).toMatchObject({ strength: 0.25 });
    host.setActor("actor", [binding("sibling", 0.25)], resolve);
    expect(gpu.active.has(replacement)).toBe(false);
    host.retainActors(new Set());
    expect(gpu.active.size).toBe(0);
  });

  it("restores the previous actor snapshot when a later cage allocation fails", () => {
    const { scene, host } = setup();
    const first = new Mesh("First", scene), rejected = new Mesh("Rejected", scene);
    const resolve = (id: string) => id === "first" ? first : rejected;
    host.setActor("actor", [binding("first", 0.25)], resolve);
    gpu.reject = rejected;
    expect(() => host.setActor("actor", [binding("first", 0.75), binding("rejected")], resolve)).toThrow("GPU allocation rejected");
    expect(gpu.active.get(first)).toMatchObject({ strength: 0.25 });
    expect(gpu.active.has(rejected)).toBe(false);
    host.dispose(); expect(gpu.active.size).toBe(0);
  });

  it("ignores missing, disposed and sibling-scene visuals while retaining valid targets", () => {
    const { scene, host } = setup();
    const valid = new Mesh("Valid", scene), disposed = new Mesh("Disposed", scene); disposed.dispose();
    const foreign = new Mesh("Foreign", new Scene(scene.getEngine()));
    const roots = new Map([["valid", valid], ["disposed", disposed], ["foreign", foreign]]);
    host.setActor("actor", [binding("missing"), binding("disposed"), binding("foreign"), binding("valid")], (id) => roots.get(id) ?? null);
    expect([...gpu.active.keys()]).toEqual([valid]);
    host.dispose(); host.setActor("actor", [binding("valid")], () => valid);
    expect(gpu.active.size).toBe(0);
  });
});
