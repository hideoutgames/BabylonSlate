import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Bone,
  Camera,
  FreeCamera,
  Matrix,
  Mesh,
  MorphTarget,
  MorphTargetManager,
  Skeleton,
  StandardMaterial,
  TransformNode,
  Vector3,
  VertexBuffer,
  type Scene,
} from "@babylonjs/core";
import { normalizeRenderingQuality } from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { encodeTriangleGlb, encodeUvSphereGlb } from "./glb-test-fixtures";
import { loadModelContainer } from "./model-container";
import {
  attachModelLods,
  autoLodDiagnostics,
  generateModelLods,
  isAutoLodMaster,
} from "./model-lod";
import { followSceneRenderSettings, updateSceneRenderingSettings } from "./render-settings";
import { participatesInShadows } from "./shadow-mesh-policy";
import { visualMeshes } from "./visual-meshes";

const handles: ReturnType<typeof createTestEngine>[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) {
    handle.scene.dispose();
    handle.engine.dispose();
  }
});

async function sphereModel(cacheKey?: string, rings?: number, segments?: number) {
  const handle = createTestEngine();
  handles.push(handle);
  const { scene } = handle;
  const container = await loadModelContainer(scene, encodeUvSphereGlb(rings, segments), "sphere.glb");
  const lods = await generateModelLods(container, undefined, cacheKey);
  const instantiate = () => {
    const instance = container.instantiateModelsToScene((name) => name, false, { doNotInstantiate: true });
    const root = new Mesh("actor", scene);
    for (const node of instance.rootNodes) node.parent = root;
    attachModelLods(root, lods);
    const master = root.getChildMeshes().find((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.hasLODLevels);
    if (!master) throw new Error("Sphere received no automatic LOD");
    // Babylon keeps coverage levels coarsest-first; list them finest-first.
    const levels = [...master.getLODLevels()]
      .sort((a, b) => b.distanceOrScreenCoverage - a.distanceOrScreenCoverage)
      .map((level) => level.mesh!);
    return { root, master, levels, instance };
  };
  return { scene, engine: handle.engine, container, lods, instantiate };
}

/** Place a camera where the master's bounding sphere spans `screenSize` of the view height. */
function cameraAt(scene: Scene, master: Mesh, screenSize: number, camera = new FreeCamera("camera", Vector3.Zero(), scene)) {
  master.computeWorldMatrix(true);
  const sphere = master.getBoundingInfo().boundingSphere;
  const distance = sphere.radiusWorld / (screenSize * Math.tan(camera.fov / 2));
  camera.position.copyFrom(sphere.centerWorld.subtract(new Vector3(0, 0, distance)));
  camera.setTarget(sphere.centerWorld);
  camera.getViewMatrix(true);
  scene.activeCamera = camera;
  return camera;
}

describe("automatic model LOD", () => {
  it("draws simplified index buffers over the model's own vertex buffers", async () => {
    const { instantiate } = await sphereModel();
    const { root, master, levels } = instantiate();
    expect(levels.length).toBeGreaterThanOrEqual(2);
    let previous = master.getTotalIndices();
    for (const lod of levels) {
      expect(lod.getTotalIndices()).toBeLessThan(previous);
      previous = lod.getTotalIndices();
      expect(lod.getTotalVertices()).toBe(master.getTotalVertices());
      for (const kind of master.getVerticesDataKinds())
        expect(lod.getVertexBuffer(kind)!.getWrapperBuffer()).toBe(master.getVertexBuffer(kind)!.getWrapperBuffer());
      expect(lod.isBlocked).toBe(true);
      expect(lod.isPickable).toBe(false);
      expect(lod.parent).toBe(master);
      expect(participatesInShadows(lod)).toBe(false);
    }
    expect(visualMeshes(root)).toEqual([master]);
  });

  it("selects levels by screen coverage with hysteresis, the quality scale and the Auto LOD switch", async () => {
    const { scene, instantiate } = await sphereModel();
    const { master, levels } = instantiate();
    const camera = cameraAt(scene, master, 0.6);
    const select = (screenSize: number, view = camera) => {
      cameraAt(scene, master, screenSize, view);
      return scene.customLODSelector!(master, view);
    };
    // Level 1 starts below half the view height.
    expect(select(0.6)).toBe(master);
    expect(select(0.475)).toBe(master);
    expect(select(0.44)).toBe(levels[0]);
    expect(select(0.52)).toBe(levels[0]);
    expect(select(0.56)).toBe(master);
    expect(select(0.02)).toBe(levels.at(-1));

    updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality({ geometry: { autoLod: true, lodDistanceScale: 2 } }) });
    const scaled = new FreeCamera("scaled", Vector3.Zero(), scene);
    expect(select(0.44, scaled)).toBe(master);
    expect(select(0.2, scaled)).toBe(levels[0]);

    updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality({ geometry: { autoLod: false, lodDistanceScale: 1 } }) });
    expect(select(0.02, scaled)).toBe(master);
  });

  it("renders the selected level in place of its master", async () => {
    const { scene, instantiate } = await sphereModel();
    const { master, levels } = instantiate();
    cameraAt(scene, master, 0.9);
    await scene.whenReadyAsync();
    scene.render();
    expect(scene.getActiveIndices()).toBe(master.getTotalIndices());
    cameraAt(scene, master, 0.02, scene.activeCamera as FreeCamera);
    scene.render();
    expect(scene.getActiveIndices()).toBe(levels.at(-1)!.getTotalIndices());
  });

  it("releases shared level geometry with the last actor and rebuilds it for the next", async () => {
    const { scene, container, instantiate } = await sphereModel();
    const first = instantiate();
    const second = instantiate();
    const geometry = first.levels[0]!.geometry!;
    const indices = first.levels[0]!.getTotalIndices();
    expect(second.levels[0]!.geometry).toBe(geometry);
    expect(autoLodDiagnostics(scene).meshes).toBe(2);
    first.instance.dispose();
    expect(geometry.isDisposed()).toBe(false);
    expect(isAutoLodMaster(first.master)).toBe(false);
    expect(autoLodDiagnostics(scene).meshes).toBe(1);
    second.instance.dispose();
    expect(geometry.isDisposed()).toBe(true);
    expect(autoLodDiagnostics(scene).meshes).toBe(0);
    expect(scene.geometries).not.toContain(geometry);
    // The model's own buffers survive their levels.
    const source = container.meshes.find((mesh) => mesh.getTotalIndices() > 0) as Mesh;
    expect(source.getVertexBuffer(VertexBuffer.PositionKind)!.getBuffer()).not.toBeNull();
    const third = instantiate();
    expect(third.levels[0]!.geometry).not.toBe(geometry);
    expect(third.levels[0]!.geometry!.isDisposed()).toBe(false);
    expect(third.levels[0]!.getTotalIndices()).toBe(indices);
  });

  it("draws levels with the actor's material, skeleton and morph targets", async () => {
    const { scene, instantiate } = await sphereModel();
    const { master, levels } = instantiate();
    const skeleton = new Skeleton("rig", "rig", scene);
    new Bone("root", skeleton, null, Matrix.Identity());
    const morphs = new MorphTargetManager(scene);
    const target = new MorphTarget("bulge", 0.5, scene);
    target.setPositions(master.getVerticesData(VertexBuffer.PositionKind)!);
    morphs.addTarget(target);
    master.skeleton = skeleton;
    master.morphTargetManager = morphs;
    master.receiveShadows = true;
    cameraAt(scene, master, 0.9);
    scene.render();
    for (const lod of levels) {
      expect(lod.material).toBe(master.material);
      expect(lod.skeleton).toBe(skeleton);
      // Babylon drops a manager whose vertex count differs from the mesh.
      expect(lod.morphTargetManager).toBe(morphs);
      expect(lod.receiveShadows).toBe(true);
    }
  });

  it("hands a swapped actor material to every level before the next frame", async () => {
    const { scene, instantiate } = await sphereModel();
    const { master, levels } = instantiate();
    const material = new StandardMaterial("swapped", scene);
    master.material = material;
    for (const lod of levels) expect(lod.material).toBe(material);
  });

  it("selects levels by orthographic extent, independent of camera distance", async () => {
    const { scene, instantiate } = await sphereModel();
    const { master, levels } = instantiate();
    master.computeWorldMatrix(true);
    const sphere = master.getBoundingInfo().boundingSphere;
    const camera = new FreeCamera("ortho", Vector3.Zero(), scene);
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    const select = (screenSize: number, distance = 20) => {
      const half = sphere.radiusWorld / screenSize;
      camera.orthoTop = half;
      camera.orthoBottom = -half;
      camera.orthoLeft = -half;
      camera.orthoRight = half;
      camera.position.copyFrom(sphere.centerWorld.subtract(new Vector3(0, 0, distance)));
      camera.setTarget(sphere.centerWorld);
      camera.getViewMatrix(true);
      return scene.customLODSelector!(master, camera);
    };
    expect(select(0.6)).toBe(master);
    expect(select(0.44)).toBe(levels[0]);
    expect(select(0.44, 200)).toBe(levels[0]);
    expect(select(0.44, sphere.radiusWorld * 2)).toBe(levels[0]);
    expect(select(0.02)).toBe(levels.at(-1));
  });

  it("keeps ratio floors for deforming meshes, whose levels are measured in bind pose", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const container = await loadModelContainer(handle.scene, encodeUvSphereGlb(96, 192), "sphere.glb");
    const source = container.meshes.find((mesh) => mesh.getTotalIndices() > 0) as Mesh;
    source.morphTargetManager = new MorphTargetManager(handle.scene);
    const [first] = (await generateModelLods(container)).levelsFor(source)!;
    // The same sphere without deformation drops below 15% at this level.
    expect(first!.data.triangles).toBeGreaterThanOrEqual((0.45 * source.getTotalIndices()) / 3);
  });

  it("leaves CPU-skinned actors at full detail, since skinning rewrites their shared positions", async () => {
    const { scene, container, lods } = await sphereModel();
    const instance = container.instantiateModelsToScene((name) => name, false, { doNotInstantiate: true });
    const root = new TransformNode("actor", scene);
    for (const node of instance.rootNodes) node.parent = root;
    const part = root.getChildMeshes().find((mesh) => mesh.getTotalIndices() > 0) as Mesh;
    part.skeleton = new Skeleton("rig", "rig", scene);
    part.computeBonesUsingShaders = false;
    expect(attachModelLods(root, lods)).toBe(0);
    expect(part.hasLODLevels).toBe(false);
  });

  it("simplifies on the main thread when the worker fails", async () => {
    const terminate = vi.fn();
    class FailingWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: unknown = null;
      onmessageerror: unknown = null;
      terminate = terminate;
      postMessage() {
        setTimeout(() => this.onmessage?.({ data: { error: "worker crashed" } }), 0);
      }
    }
    vi.stubGlobal("Worker", FailingWorker);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { lods } = await sphereModel();
    expect(lods.indexBytes).toBeGreaterThan(0);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("worker crashed"));
  });

  it("leaves low-poly models at full detail", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const container = await loadModelContainer(handle.scene, encodeTriangleGlb(), "triangle.glb");
    const lods = await generateModelLods(container);
    expect(lods.indexBytes).toBe(0);
    const instance = container.instantiateModelsToScene((name) => name, false, { doNotInstantiate: true });
    const root = new Mesh("actor", handle.scene);
    for (const node of instance.rootNodes) node.parent = root;
    expect(attachModelLods(root, lods)).toBe(0);
  });
  it("sizes levels by screen-space error, so denser meshes keep a similar triangle count", async () => {
    const { instantiate } = await sphereModel(undefined, 96, 192);
    const { master, levels } = instantiate();
    // A fixed ratio would keep half of the source triangles at level 1.
    expect(levels[0]!.getTotalIndices()).toBeLessThan(master.getTotalIndices() * 0.15);
  });

  it("keeps the model's vertex buffers after a context restore releases every level", async () => {
    const { engine, container, instantiate } = await sphereModel();
    const first = instantiate();
    const second = instantiate();
    // Babylon rebuilds each Geometry that holds a shared buffer on restore.
    (engine as unknown as { _rebuildBuffers(): void })._rebuildBuffers();
    first.instance.dispose();
    second.instance.dispose();
    const source = container.meshes.find((mesh) => mesh.getTotalIndices() > 0) as Mesh;
    expect(source.getVertexBuffer(VertexBuffer.PositionKind)!.getBuffer()).not.toBeNull();
    expect(source.getVerticesData(VertexBuffer.PositionKind)).not.toBeNull();
    expect(instantiate().levels[0]!.getBoundingInfo().boundingSphere.radius).toBeLessThan(10);
  });

  it("reuses generated levels for another Scene loading the same model", async () => {
    const first = await sphereModel("sphere-model");
    const second = await sphereModel("sphere-model");
    const source = (model: typeof first) => model.container.meshes.find((mesh) => mesh.getTotalIndices() > 0) as Mesh;
    const levels = first.lods.levelsFor(source(first))!;
    expect(second.lods.levelsFor(source(second))!.map((level) => level.data)).toEqual(levels.map((level) => level.data));
    expect(second.lods.levelsFor(source(second))![0]!.data).toBe(levels[0]!.data);
  });

  it("follows the master's non-uniform scaling so levels shade like their master", async () => {
    const { scene, instantiate } = await sphereModel();
    const { root, master, levels } = instantiate();
    root.scaling.set(2, 1, 1);
    cameraAt(scene, master, 0.9);
    master.computeWorldMatrix(true);
    scene.render();
    expect(master.nonUniformScaling).toBe(true);
    for (const lod of levels) expect(lod.nonUniformScaling).toBe(true);
  });

  it("resolves quality from a followed Scene", async () => {
    const { scene, instantiate } = await sphereModel();
    const { master, levels } = instantiate();
    const camera = cameraAt(scene, master, 0.02);
    expect(scene.customLODSelector!(master, camera)).toBe(levels.at(-1));

    const owner = createTestEngine();
    handles.push(owner);
    updateSceneRenderingSettings(owner.scene, { quality: normalizeRenderingQuality({ geometry: { autoLod: false, lodDistanceScale: 1 } }) });
    followSceneRenderSettings(scene, owner.scene);
    expect(scene.customLODSelector!(master, new FreeCamera("fresh", camera.position.clone(), scene))).toBe(master);
  });

  it("reports how many visible meshes draw a simplified level", async () => {
    const { scene, instantiate } = await sphereModel();
    const { master, levels } = instantiate();
    cameraAt(scene, master, 0.9);
    expect(autoLodDiagnostics(scene)).toEqual({ meshes: 1, reduced: 0, trianglesSaved: 0 });
    cameraAt(scene, master, 0.02, scene.activeCamera as FreeCamera);
    expect(autoLodDiagnostics(scene)).toEqual({
      meshes: 1,
      reduced: 1,
      trianglesSaved: (master.getTotalIndices() - levels.at(-1)!.getTotalIndices()) / 3,
    });
  });
});
