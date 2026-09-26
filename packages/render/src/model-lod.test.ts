import { afterEach, describe, expect, it } from "vitest";
import {
  Bone,
  FreeCamera,
  Matrix,
  Mesh,
  MorphTarget,
  MorphTargetManager,
  Skeleton,
  Vector3,
  VertexBuffer,
  type Scene,
} from "@babylonjs/core";
import { normalizeRenderingQuality } from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { encodeTriangleGlb, encodeUvSphereGlb } from "./glb-test-fixtures";
import { loadModelContainer } from "./model-container";
import { attachModelLods, generateModelLods } from "./model-lod";
import { updateSceneRenderingSettings } from "./render-settings";
import { participatesInShadows } from "./shadow-mesh-policy";
import { visualMeshes } from "./visual-meshes";

const handles: ReturnType<typeof createTestEngine>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.scene.dispose();
    handle.engine.dispose();
  }
});

async function sphereModel() {
  const handle = createTestEngine();
  handles.push(handle);
  const { scene } = handle;
  const container = await loadModelContainer(scene, encodeUvSphereGlb(), "sphere.glb");
  const lods = await generateModelLods(container);
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
  return { scene, container, lods, instantiate };
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
    first.instance.dispose();
    expect(geometry.isDisposed()).toBe(false);
    second.instance.dispose();
    expect(geometry.isDisposed()).toBe(true);
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
});
