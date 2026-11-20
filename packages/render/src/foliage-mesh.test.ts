import { afterEach, expect, it, vi } from "vitest";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { createActor, createDefaultScene, identitySerializedTransform } from "@haptic/core";
import { installAssetBytes, normalizeModelPayload } from "@haptic/assets";
import { EditorSceneSync } from "./editor-scene-sync";
import { createTestEngine } from "./test-support/test-engine";
import { encodeTriangleGlb } from "./glb-test-fixtures";
import { createFoliageMesh, foliagePreparation, refreshFoliageMaterials } from "./foliage-mesh";
import { glbContainerLoadCount } from "./glb-anim";
import { keepsDrawingOutsideView } from "./play-view-culling";
const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); vi.restoreAllMocks(); });

it("shares model vertices while keeping stroke and cell instance buffers independent", async () => {
  const { engine, scene } = createTestEngine();
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  const material = new StandardMaterial("leaves", scene);
  material.metadata = { boundsPadding: 2 };
  const assets = { modelSources: new Map([["tree", installAssetBytes(encodeTriangleGlb(), "model/gltf-binary")]]), resolveMaterial: () => material };
  const data = { groupId: "forest", batches: [{ modelGuid: "tree", materialGuid: "leaf-material", transforms: [identitySerializedTransform(), { ...identitySerializedTransform(), position: [4, 0, 0] }, { ...identitySerializedTransform(), position: [40, 0, 0] }] }] };
  const a = createFoliageMesh(scene, "stroke-a", data, assets);
  const b = createFoliageMesh(scene, "stroke-b", { batches: [{ modelGuid: "tree", transforms: [{ ...identitySerializedTransform(), position: [12, 0, 0] }] }] }, assets);
  await Promise.all([foliagePreparation(a), foliagePreparation(b)]);
  const am = a.getChildMeshes().find((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.hasThinInstances)!;
  const bm = b.getChildMeshes().find((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.hasThinInstances)!;
  expect(am.thinInstanceCount).toBe(2);
  expect(am.material).toBe(material);
  expect(am.getVertexBuffer(VertexBuffer.PositionKind)!.getWrapperBuffer()).toBe(bm.getVertexBuffer(VertexBuffer.PositionKind)!.getWrapperBuffer());
  expect(glbContainerLoadCount(scene)).toBe(1);
  expect(am.thinInstanceGetWorldMatrices()[1]!.getTranslation().x).toBe(4);
  // Read the attributes actually bound for drawing, not the separate CPU matrix cache.
  expect(Array.from(am.getVertexBuffer("world3")!.getFloatData(am.thinInstanceCount)!)).toEqual([0, 0, 0, 1, 4, 0, 0, 1]);
  expect(Array.from(bm.getVertexBuffer("world3")!.getFloatData(bm.thinInstanceCount)!)).toEqual([12, 0, 0, 1]);
  const distantCell = a.getChildMeshes().find((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.hasThinInstances && mesh !== am)!;
  expect(Array.from(distantCell.getVertexBuffer("world3")!.getFloatData(distantCell.thinInstanceCount)!)).toEqual([40, 0, 0, 1]);
  // A cell's bounds hold its instances where they stand, and the view's cull is told it can trust them: a view that
  // does not see a cell draws none of its instances.
  for (const [cell, x] of [[am, [0, 4]], [distantCell, [40, 40]]] as const) {
    const box = cell.getBoundingInfo().boundingBox;
    expect(box.minimumWorld.x <= x[0] && box.maximumWorld.x >= x[1], `${box.minimumWorld.x}..${box.maximumWorld.x}`).toBe(true);
    expect(keepsDrawingOutsideView(cell)).toBe(false);
  }
  const source = am.source as Mesh;
  expect(source.isVerticesDataPresent("world0")).toBe(false);
  const paddedMaximum = am.getBoundingInfo().boundingBox.maximum.clone();
  refreshFoliageMaterials(a, { ...assets, resolveMaterial: () => null });
  expect(am.getBoundingInfo().boundingBox.maximum.x).toBeCloseTo(paddedMaximum.x - 2);
  expect(am.getBoundingInfo().boundingBox.maximum.y).toBeCloseTo(paddedMaximum.y - 2);
  a.dispose();
  expect(bm.isDisposed()).toBe(false);
  expect(bm.getVertexBuffer("world3")!.getBuffer()).not.toBeNull();
  expect(bm.getVertexBuffer(VertexBuffer.PositionKind)!.getBuffer()).not.toBeNull();
  expect(Array.from(bm.getVertexBuffer("world3")!.getFloatData(bm.thinInstanceCount)!)).toEqual([12, 0, 0, 1]);
  expect(scene.materials).toContain(material);
});

it("does not adopt a model after its foliage component is deleted", async () => {
  const { engine, scene } = createTestEngine();
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  const root = createFoliageMesh(scene, "deleted", { batches: [{ modelGuid: "m", transforms: [identitySerializedTransform()] }] }, { modelBytes: new Map([["m", encodeTriangleGlb()]]) });
  root.dispose();
  await foliagePreparation(root);
  expect(scene.meshes.some((mesh) => mesh.name.startsWith("deleted:"))).toBe(false);
});

it("waits for initial foliage and refreshes late model sources and import scale with actor visibility", async () => {
  const { scene, engine } = createTestEngine();
  const sync = new EditorSceneSync(scene);
  disposers.push(() => { sync.dispose(); scene.dispose(); engine.dispose(); });
  const data = { ...createDefaultScene(), actors: [createActor("stroke", "Stroke", { visible: false, locked: true, components: [{ id: "foliage", classId: "FoliageComponent", properties: { batches: [{ modelGuid: "tree", transforms: [identitySerializedTransform()] }] } }] })] };
  sync.apply(data);
  await sync.whenEditorModelsReady();
  const empty = sync.meshForComponent("stroke", "foliage")!;
  expect(empty.getChildMeshes()).toHaveLength(0);
  const modelSources = new Map([["tree", installAssetBytes(encodeTriangleGlb(), "model/gltf-binary")]]);
  sync.setMeshAssets({ modelSources });
  await sync.whenEditorModelsReady();
  const root = sync.meshForComponent("stroke", "foliage")!;
  const instance = root.getChildMeshes().find((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.hasThinInstances)!;
  expect(instance, JSON.stringify({ sameRoot: root === empty, meshes: scene.meshes.map((mesh) => ({ name: mesh.name, count: mesh instanceof Mesh ? mesh.thinInstanceCount : 0 })) })).toBeDefined();
  expect(instance.thinInstanceCount).toBe(1);
  expect(instance.isVisible).toBe(false);
  expect(instance.isPickable).toBe(false);
  sync.setMeshAssets({ modelSources, modelPayloads: new Map([["tree", normalizeModelPayload({ importScale: 3 })]]) });
  await sync.whenEditorModelsReady();
  const resized = sync.meshForComponent("stroke", "foliage")!.getChildMeshes().find((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.hasThinInstances)!;
  expect(root.isDisposed()).toBe(true);
  const scale = new Vector3(); resized.thinInstanceGetWorldMatrices()[0]!.decompose(scale);
  expect(scale.x).toBeCloseTo(3);
  sync.apply({ ...data, actors: [{ ...data.actors[0]!, visible: true, locked: false }] });
  await sync.whenEditorModelsReady();
  expect(resized.isVisible && resized.isPickable).toBe(true);
});

it("preserves the last foliage visual and reports a replacement failure even after the load settles", async () => {
  const { scene, engine } = createTestEngine();
  const sync = new EditorSceneSync(scene);
  disposers.push(() => { sync.dispose(); scene.dispose(); engine.dispose(); });
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  sync.setMeshAssets({ modelSources: new Map([["tree", installAssetBytes(encodeTriangleGlb(), "model/gltf-binary")]]) });
  sync.apply({ ...createDefaultScene(), actors: [createActor("stroke", "Stroke", { components: [{ id: "foliage", classId: "FoliageComponent", properties: { batches: [{ modelGuid: "tree", transforms: [identitySerializedTransform()] }] } }] })] });
  await sync.whenEditorModelsReady();
  const previous = sync.meshForComponent("stroke", "foliage")!;
  sync.setMeshAssets({ modelSources: new Map([["tree", installAssetBytes(new Uint8Array([0, 1, 2]), "model/gltf-binary")]]) });
  await vi.waitFor(() => expect(warnings.mock.calls.some(([message]) => String(message).includes("Visual publication failed"))).toBe(true));
  await expect(sync.whenEditorModelsReady()).rejects.toThrow();
  expect(sync.meshForComponent("stroke", "foliage")).toBe(previous);
  expect(previous.isDisposed()).toBe(false);
});

it("keeps an unchanged foliage visual across applies and rebuilds it when its properties are replaced", async () => {
  const { scene, engine } = createTestEngine();
  const sync = new EditorSceneSync(scene);
  disposers.push(() => { sync.dispose(); scene.dispose(); engine.dispose(); });
  sync.setMeshAssets({ modelSources: new Map([["tree", installAssetBytes(encodeTriangleGlb(), "model/gltf-binary")]]) });
  const properties = { batches: [{ modelGuid: "tree", transforms: [identitySerializedTransform()] }] };
  const foliage = (next: typeof properties) => ({ ...createDefaultScene(), actors: [createActor("stroke", "Stroke", { components: [{ id: "foliage", classId: "FoliageComponent", properties: next }] })] });
  sync.apply(foliage(properties));
  await sync.whenEditorModelsReady();
  const first = sync.meshForComponent("stroke", "foliage")!;
  sync.apply(foliage(properties));
  await sync.whenEditorModelsReady();
  expect(sync.meshForComponent("stroke", "foliage")).toBe(first);
  sync.apply(foliage({ batches: [{ modelGuid: "tree", transforms: [identitySerializedTransform(), { ...identitySerializedTransform(), position: [4, 0, 0] }] }] }));
  await sync.whenEditorModelsReady();
  const rebuilt = sync.meshForComponent("stroke", "foliage")!;
  expect(rebuilt).not.toBe(first);
  expect(rebuilt.getChildMeshes().find((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.hasThinInstances)?.thinInstanceCount).toBe(2);
});

it("distance-culls foliage cells, drops distant shadows without readiness churn, and sets dither fade bands scaled by lodDistanceScale", async () => {
  const { FreeCamera } = await import("@babylonjs/core/Cameras/freeCamera");
  const { RENDER_QUALITY_PROFILES } = await import("@haptic/core");
  const { updateSceneRenderingSettings } = await import("./render-settings");
  const { onSceneReadinessDirty } = await import("./scene-readiness-signal");
  const { updateFoliageDistances } = await import("./foliage-mesh");
  const { engine, scene } = createTestEngine();
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  const camera = new FreeCamera("cam", new Vector3(0, 2, 0), scene);
  camera.getViewMatrix();
  scene.activeCamera = camera;
  // Low quality uses lodDistanceScale = 0.75.
  updateSceneRenderingSettings(scene, { quality: RENDER_QUALITY_PROFILES.low });

  const assets = { modelSources: new Map([["grass", installAssetBytes(encodeTriangleGlb(), "model/gltf-binary")]]) };
  const root = createFoliageMesh(scene, "meadow", {
    batches: [{
      modelGuid: "grass",
      materialGuid: null,
      cullDistance: 80,
      fadeRange: 20,
      shadowDistance: 40,
      transforms: [
        { ...identitySerializedTransform(), position: [5, 0, 0] },
        { ...identitySerializedTransform(), position: [50, 0, 0] },
        { ...identitySerializedTransform(), position: [100, 0, 0] },
      ],
    }],
  }, assets);
  await foliagePreparation(root);

  const cells = root.getChildMeshes().filter((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.hasThinInstances);
  expect(cells).toHaveLength(3);
  const byX = (targetX: number) => cells.find((cell) => Math.abs(cell.getBoundingInfo().boundingSphere.centerWorld.x - targetX) < 5)!;
  const near = byX(5);
  const mid = byX(50);
  const far = byX(100);

  const readinessEvents: string[] = [];
  const unsubscribe = onSceneReadinessDirty(scene, (reason) => readinessEvents.push(reason));
  disposers.push(unsubscribe);

  // Effective distances at Low (0.75): cull = 60 m, fadeStart = 45 m, shadow = 30 m.
  updateFoliageDistances(scene, camera, true);
  expect(near.isEnabled(false)).toBe(true);
  expect(near.metadata?.slateShadowDistanceCulled).toBe(false);
  expect(near.metadata?.slateFoliageFade).toBeNull();

  expect(mid.isEnabled(false)).toBe(true);
  expect(mid.metadata?.slateShadowDistanceCulled).toBe(true);
  expect(mid.metadata?.slateFoliageFade).toEqual([45, 60]);

  expect(far.isEnabled(false)).toBe(false);
  expect(far.metadata?.slateShadowDistanceCulled).toBe(true);
  expect(far.metadata?.slateFoliageFade).toBeNull();

  // Hidden actor visibility is independent of distance culling (setEnabled vs isVisible).
  near.isVisible = false;

  // Moving camera near the far cell restores drawing and shadows with zero readiness invalidations.
  camera.position.set(95, 2, 0);
  camera.getViewMatrix();
  updateFoliageDistances(scene, camera, true);
  expect(far.isEnabled(false)).toBe(true);
  expect(far.metadata?.slateShadowDistanceCulled).toBe(false);
  expect(near.isEnabled(false)).toBe(false);
  expect(near.isVisible).toBe(false);
  expect(readinessEvents).toEqual([]);
});

it("swaps pre-built per-cell LOD geometries while sharing thin-instance matrix buffers", async () => {
  const { FreeCamera } = await import("@babylonjs/core/Cameras/freeCamera");
  const { RENDER_QUALITY_PROFILES } = await import("@haptic/core");
  const { updateSceneRenderingSettings } = await import("./render-settings");
  const { attachFoliageLodSet, updateFoliageDistances } = await import("./foliage-mesh");
  const { engine, scene } = createTestEngine();
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  const camera = new FreeCamera("cam", new Vector3(0, 2, 0), scene);
  camera.getViewMatrix();
  scene.activeCamera = camera;
  updateSceneRenderingSettings(scene, {
    quality: { ...RENDER_QUALITY_PROFILES.medium, geometry: { ...RENDER_QUALITY_PROFILES.medium.geometry, lodDistanceScale: 1, autoLod: true } },
  });

  const assets = { modelSources: new Map([["tree", installAssetBytes(encodeTriangleGlb(), "model/gltf-binary")]]) };
  const root = createFoliageMesh(scene, "grove", {
    batches: [{
      modelGuid: "tree",
      materialGuid: null,
      cullDistance: 100,
      fadeRange: 10,
      shadowDistance: 50,
      transforms: [
        { ...identitySerializedTransform(), position: [5, 0, 0] },
        { ...identitySerializedTransform(), position: [50, 0, 0] },
      ],
    }],
  }, assets);
  await foliagePreparation(root);

  const cells = root.getChildMeshes().filter((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.hasThinInstances);
  const near = cells.find((cell) => Math.abs(cell.getBoundingInfo().boundingSphere.centerWorld.x - 5) < 5)!;
  const mid = cells.find((cell) => Math.abs(cell.getBoundingInfo().boundingSphere.centerWorld.x - 50) < 5)!;
  const midLod0Geometry = mid.geometry!;
  const midWorld3Wrapper = mid.getVertexBuffer("world3")!.getWrapperBuffer();
  const midPosWrapper = mid.getVertexBuffer(VertexBuffer.PositionKind)!.getWrapperBuffer();

  // Attach a synthetic 1-level ModelLodSet (simplified index buffer, same vertex pool).
  attachFoliageLodSet(scene, {
    levelsFor: () => [{
      data: {
        coverage: 0.25,
        indices: new Uint16Array([0, 1, 2]),
        subMeshes: [{ materialIndex: 0, verticesStart: 0, verticesCount: 3, indexStart: 0, indexCount: 3 }],
        triangles: 1,
      },
    }],
    indexBytes: 6,
    dispose: () => {},
  });

  // Near cell stays on LOD0; mid cell (dist ~50 m >= 45 m * 1.05) switches to LOD1 sharing VB + world3.
  expect(near.geometry!.id).not.toContain(":lod1");
  expect(mid.geometry).not.toBe(midLod0Geometry);
  expect(mid.geometry!.id).toContain(":lod1");
  expect(mid.thinInstanceCount).toBe(1);
  expect(mid.getVertexBuffer("world3")!.getWrapperBuffer()).toBe(midWorld3Wrapper);
  expect(mid.getVertexBuffer(VertexBuffer.PositionKind)!.getWrapperBuffer()).toBe(midPosWrapper);

  // Disabling autoLod returns every cell to LOD0 without disposing pre-built LOD1.
  updateSceneRenderingSettings(scene, {
    quality: { ...RENDER_QUALITY_PROFILES.medium, geometry: { ...RENDER_QUALITY_PROFILES.medium.geometry, lodDistanceScale: 1, autoLod: false } },
  });
  updateFoliageDistances(scene, camera, true);
  expect(mid.geometry).toBe(midLod0Geometry);
});

it("updates FoliageFadePlugin uniforms per mesh across consecutive draws sharing a frozen material", async () => {
  const { FreeCamera } = await import("@babylonjs/core/Cameras/freeCamera");
  const { CreateBox } = await import("@babylonjs/core/Meshes/Builders/boxBuilder");
  const { engine, scene } = createTestEngine();
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  const camera = new FreeCamera("cam", new Vector3(1, 2, 3), scene);
  camera.getViewMatrix();
  scene.activeCamera = camera;

  const material = new StandardMaterial("shared-foliage", scene);
  const nearMesh = CreateBox("near", { size: 1 }, scene);
  const fadeMesh = CreateBox("fade", { size: 1 }, scene);
  nearMesh.material = material;
  fadeMesh.material = material;
  nearMesh.metadata = { slateFoliageFade: null };
  fadeMesh.metadata = { slateFoliageFade: [85, 100] };

  expect(material.isReadyForSubMesh(nearMesh, nearMesh.subMeshes[0]!, false)).toBe(true);
  expect(material.isReadyForSubMesh(fadeMesh, fadeMesh.subMeshes[0]!, false)).toBe(true);
  material.freeze();

  const ubo = material.getEffect() ? (material as unknown as { _uniformBuffer: { updateFloat2: (name: string, x: number, y: number) => void } })._uniformBuffer : null;
  expect(ubo).not.toBeNull();
  const fadeCalls: Array<[number, number]> = [];
  const origUpdateFloat2 = ubo!.updateFloat2.bind(ubo);
  vi.spyOn(ubo!, "updateFloat2").mockImplementation((name: string, x: number, y: number) => {
    if (name === "slateFoliageFade") fadeCalls.push([x, y]);
    origUpdateFloat2(name, x, y);
  });

  // Consecutive binds on the same frozen material skip mustRebind; hardBindForSubMesh must still update each mesh.
  material.bindForSubMesh(nearMesh.getWorldMatrix(), nearMesh, nearMesh.subMeshes[0]!);
  material.bindForSubMesh(fadeMesh.getWorldMatrix(), fadeMesh, fadeMesh.subMeshes[0]!);
  material.bindForSubMesh(nearMesh.getWorldMatrix(), nearMesh, nearMesh.subMeshes[0]!);

  expect(fadeCalls).toEqual([
    [0, 0],
    [85, 100],
    [0, 0],
  ]);
});



