import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundingInfo, Matrix, Mesh, MeshBuilder, MultiMaterial, NullEngine, Scene, StandardMaterial, Vector3, VertexBuffer, type Effect } from "@babylonjs/core";
import { InternalTexture, InternalTextureSource } from "@babylonjs/core/Materials/Textures/internalTexture";
import { LatticePluginMaterial } from "@babylonjs/core/Meshes/lattice.material";
import { bindMeshLatticeDeformer, disposeMeshLatticeDeformer, flushSceneLatticeDeformers, hasMeshLatticeDeformer, markLatticeComponentRoot, refreshMeshLatticeDeformer, setMeshLatticeDeformer, type LatticeDeformerConfig } from "./lattice-deformer";
import { applyMaterialBounds, setMaterialBoundsExpansion, updateDynamicMaterialBounds } from "./material-bounds";
import { managedRenderReservations } from "./managed-render-resources";
import { onSceneReadinessDirty } from "./scene-readiness-signal";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); });
function fixture() {
  const engine = new NullEngine(), scene = new Scene(engine);
  engine.getCaps().textureFloat = true; engine.getCaps().maxVertexTextureImageUnits = 16;
  vi.spyOn(engine, "webGLVersion", "get").mockReturnValue(2);
  // NullEngine has no 3D GPU texture backend. Keep the real stock lattice and
  // plugin, replacing only the device allocation/upload boundary.
  vi.spyOn(engine, "createRawTexture3D").mockImplementation((_data, width, height, depth) => {
    const texture = new InternalTexture(engine, InternalTextureSource.Raw3D);
    texture.width = width; texture.height = height; texture.depth = depth;
    texture.isReady = true; return texture;
  });
  vi.spyOn(engine, "updateRawTexture3D").mockImplementation(() => {});
  const root = new Mesh("component", scene), mesh = MeshBuilder.CreateBox("part", { size: 2 }, scene);
  mesh.parent = root; mesh.material = new StandardMaterial("surface", scene);
  cleanups.push(() => { scene.dispose(); engine.dispose(); });
  return { engine, scene, root, mesh };
}
function cage(offset = 2): LatticeDeformerConfig {
  return { enabled: true, resolution: [2, 2, 2], strength: 1, offsets: Array.from({ length: 24 }, (_, i) => i % 3 === 0 ? offset : 0), fitToMesh: true, boundsMin: [-1, -1, -1], boundsMax: [1, 1, 1] };
}

describe("component lattice resource ownership", () => {
  it("keeps imported geometry shared, uploads only changed controls, and releases reservations", () => {
    const { engine, root, mesh } = fixture();
    const shared = mesh.clone("other")!; shared.parent = null;
    const positions = [...mesh.getVerticesData(VertexBuffer.PositionKind)!];
    const upload = vi.spyOn(LatticePluginMaterial.prototype, "refreshData");
    setMeshLatticeDeformer(root, cage());
    const calls = upload.mock.calls.length;
    expect(managedRenderReservations(engine).resourceBytes).toBe(128);
    expect(mesh.geometry).toBe(shared.geometry);
    expect([...mesh.getVerticesData(VertexBuffer.PositionKind)!]).toEqual(positions);
    expect(hasMeshLatticeDeformer(mesh)).toBe(true);
    expect(hasMeshLatticeDeformer(shared)).toBe(false);
    setMeshLatticeDeformer(root, cage()); refreshMeshLatticeDeformer(root);
    expect(upload).toHaveBeenCalledTimes(calls);
    setMeshLatticeDeformer(root, cage(3));
    expect(upload).toHaveBeenCalledTimes(calls + 1);
    expect(engine.createRawTexture3D).toHaveBeenCalledTimes(1);
    expect(mesh.getBoundingInfo().boundingBox.maximum.x).toBe(4);
    disposeMeshLatticeDeformer(root);
    expect(mesh.getBoundingInfo().boundingBox.maximum.x).toBe(1);
    expect(managedRenderReservations(engine).resourceBytes).toBe(0);
  });

  it("uses one component-local cage for model parts and late parentless LODs, excluding attached components", () => {
    const { root, mesh, scene } = fixture();
    root.position.x = 10;
    const attached = MeshBuilder.CreateBox("attachedComponent", { size: 2 }, scene);
    attached.parent = root; attached.position.x = 100; markLatticeComponentRoot(attached);
    setMeshLatticeDeformer(root, cage());
    const lod = MeshBuilder.CreateBox("lod", { size: 1 }, scene); lod.material = mesh.material; mesh.addLODLevel(10, lod);
    refreshMeshLatticeDeformer(root);
    expect(hasMeshLatticeDeformer(lod)).toBe(true);
    expect(hasMeshLatticeDeformer(attached)).toBe(false);
    const matrices = new Map<string, Matrix>(), vectors = new Map<string, number[]>();
    const effect = { setFloat: vi.fn(), setTexture: vi.fn(), setMatrix: (name: string, matrix: Matrix) => matrices.set(name, matrix.clone()), setVector3: (name: string, value: Vector3) => vectors.set(name, value.asArray()), setFloat3: (name: string, ...value: number[]) => vectors.set(name, value) } as unknown as Effect;
    bindMeshLatticeDeformer(effect, lod);
    expect(vectors.get("lattice_min")).toEqual([-1, -1, -1]);
    expect(Vector3.TransformCoordinates(new Vector3(10, 0, 0), matrices.get("slateWorldToLattice")!).asArray()).toEqual([0, 0, 0]);
    bindMeshLatticeDeformer(effect, attached);
    expect(effect.setFloat).toHaveBeenLastCalledWith("slateLatticeEnabled", 0);
  });

  it("allocates nothing for an identity cage and rolls back an unsupported device assignment", () => {
    const { engine, root, mesh, scene } = fixture();
    setMeshLatticeDeformer(root, cage(0));
    expect(managedRenderReservations(engine).resourceBytes).toBe(0);
    expect(hasMeshLatticeDeformer(mesh)).toBe(false);
    disposeMeshLatticeDeformer(root);
    const nested = new Mesh("unsupported", scene); nested.parent = root;
    engine.getCaps().textureFloat = false;
    expect(() => setMeshLatticeDeformer(root, cage())).toThrow("vertex float-texture sampling");
    expect(hasMeshLatticeDeformer(mesh)).toBe(false);
    expect(managedRenderReservations(engine).reservedBytes).toBe(0);
  });

  it("keeps component-owned regular instances batched while rejecting cages that could bleed into another component", () => {
    const { engine, root, mesh, scene } = fixture();
    const instance = mesh.createInstance("sameComponent"); instance.parent = root; instance.position.x = 2;
    setMeshLatticeDeformer(root, cage());
    expect(hasMeshLatticeDeformer(instance)).toBe(true);
    expect(instance.sourceMesh).toBe(mesh);
    expect(managedRenderReservations(engine).resourceBytes).toBe(128);
    const otherRoot = new Mesh("otherComponent", scene); markLatticeComponentRoot(otherRoot);
    const foreign = mesh.createInstance("foreignComponent"); foreign.parent = otherRoot;
    expect(() => refreshMeshLatticeDeformer(root)).toThrow("different components");
    expect(hasMeshLatticeDeformer(foreign)).toBe(false);
    foreign.dispose(); refreshMeshLatticeDeformer(root);
    expect(managedRenderReservations(engine).resourceBytes).toBe(128);
  });

  it("refreshes material and submaterial shadow ownership and readiness without uploading unchanged controls", () => {
    const { root, mesh, scene } = fixture();
    const original = mesh.material!;
    const dirty = vi.fn(), unsubscribe = onSceneReadinessDirty(scene, dirty); cleanups.push(unsubscribe);
    setMeshLatticeDeformer(root, cage());
    expect(original.shadowDepthWrapper).not.toBeNull();
    const upload = vi.spyOn(LatticePluginMaterial.prototype, "refreshData");
    const replacement = new StandardMaterial("replacement", scene);
    const slots = new MultiMaterial("slots", scene); slots.subMaterials = [replacement]; mesh.material = slots;
    flushSceneLatticeDeformers(scene);
    expect(original.shadowDepthWrapper).toBeNull();
    expect(replacement.shadowDepthWrapper).not.toBeNull();
    slots.subMaterials[0] = original;
    flushSceneLatticeDeformers(scene);
    expect(replacement.shadowDepthWrapper).toBeNull();
    expect(original.shadowDepthWrapper).not.toBeNull();
    expect(upload).not.toHaveBeenCalled();
    expect(dirty).toHaveBeenCalledTimes(3);
    disposeMeshLatticeDeformer(root);
    expect(original.shadowDepthWrapper).toBeNull();
  });
});

it("combines cage expansion, dynamic geometry, and material padding without losing their original bounds", () => {
  const { mesh } = fixture();
  mesh.material!.metadata = { boundsPadding: 2 };
  updateDynamicMaterialBounds(mesh, new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
  setMaterialBoundsExpansion(mesh, new BoundingInfo(new Vector3(-1, -1, -1), new Vector3(8, 1, 1)));
  expect(mesh.getBoundingInfo().boundingBox.maximum.asArray()).toEqual([8, 3, 3]);
  updateDynamicMaterialBounds(mesh, new Vector3(-2, -2, -2), new Vector3(2, 2, 2));
  expect(mesh.getBoundingInfo().boundingBox.maximum.asArray()).toEqual([8, 4, 4]);
  setMaterialBoundsExpansion(mesh, null);
  expect(mesh.getBoundingInfo().boundingBox.maximum.asArray()).toEqual([4, 4, 4]);
  mesh.material!.metadata.boundsPadding = 0; applyMaterialBounds(mesh);
  expect(mesh.getBoundingInfo().boundingBox.maximum.asArray()).toEqual([2, 2, 2]);
});
