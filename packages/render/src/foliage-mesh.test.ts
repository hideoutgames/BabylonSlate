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

it("distance-culls foliage cells, drops distant shadows, and sets dither fade bands scaled by lodDistanceScale", async () => {
  const { FreeCamera } = await import("@babylonjs/core/Cameras/freeCamera");
  const { updateSceneRenderingSettings } = await import("./render-settings");
  const { updateFoliageDistances } = await import("./foliage-mesh");
  const { engine, scene } = createTestEngine();
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  const camera = new FreeCamera("cam", new Vector3(0, 2, 0), scene);
  camera.getWorldMatrix();
  scene.activeCamera = camera;
  // Low quality uses lodDistanceScale = 0.75.
  updateSceneRenderingSettings(scene, { quality: { level: "low", custom: {} } });

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

  // Moving camera near the far cell restores drawing and shadows.
  camera.position.set(95, 2, 0);
  camera.getWorldMatrix();
  updateFoliageDistances(scene, camera, true);
  expect(far.isEnabled(false)).toBe(true);
  expect(far.metadata?.slateShadowDistanceCulled).toBe(false);
  expect(near.isEnabled(false)).toBe(false);
});
