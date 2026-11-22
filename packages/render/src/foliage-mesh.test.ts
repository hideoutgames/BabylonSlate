import { afterEach, expect, it, vi } from "vitest";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { createActor, createDefaultScene, identitySerializedTransform, packFoliageTransforms } from "@haptic/core";
import { installAssetBytes, normalizeModelPayload } from "@haptic/assets";
import { EditorSceneSync } from "./editor-scene-sync";
import { createTestEngine } from "./test-support/test-engine";
import { encodeTriangleGlb } from "./glb-test-fixtures";
import { createFoliageMesh, foliagePreparation, refreshFoliageMaterials } from "./foliage-mesh";
import { glbContainerLoadCount } from "./glb-anim";
import { keepsDrawingOutsideView } from "./play-view-culling";
import type { ModelLodSet } from "./model-lod";
/** The levels of detail a Model's cache hands foliage, when a test replaces them (generation is the Model cache's own work). */
const lodOverride = vi.hoisted(() => ({ current: null as null | (() => Promise<ModelLodSet | null>) }));
vi.mock("./glb-anim", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./glb-anim")>();
  return {
    ...actual,
    acquireGlbContainer: (...args: Parameters<typeof actual.acquireGlbContainer>) => {
      const lease = actual.acquireGlbContainer(...args);
      const lods = lodOverride.current;
      return lods ? { ...lease, lods } : lease;
    },
  };
});
const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); vi.restoreAllMocks(); lodOverride.current = null; });

it("shares model vertices while keeping stroke and cell instance buffers independent", async () => {
  const { engine, scene } = createTestEngine();
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  const material = new StandardMaterial("leaves", scene);
  material.metadata = { boundsPadding: 2 };
  const assets = { modelSources: new Map([["tree", installAssetBytes(encodeTriangleGlb(), "model/gltf-binary")]]), resolveMaterial: () => material };
  const data = { groupId: "forest", batches: [{ modelGuid: "tree", materialGuid: "leaf-material", transforms: packFoliageTransforms([identitySerializedTransform(), { ...identitySerializedTransform(), position: [4, 0, 0] }, { ...identitySerializedTransform(), position: [40, 0, 0] }]) }] };
  const a = createFoliageMesh(scene, "stroke-a", data, assets);
  const b = createFoliageMesh(scene, "stroke-b", { batches: [{ modelGuid: "tree", transforms: packFoliageTransforms([{ ...identitySerializedTransform(), position: [12, 0, 0] }]) }] }, assets);
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
  const root = createFoliageMesh(scene, "deleted", { batches: [{ modelGuid: "m", transforms: packFoliageTransforms([identitySerializedTransform()]) }] }, { modelBytes: new Map([["m", encodeTriangleGlb()]]) });
  root.dispose();
  await foliagePreparation(root);
  expect(scene.meshes.some((mesh) => mesh.name.startsWith("deleted:"))).toBe(false);
});

it("waits for initial foliage and refreshes late model sources and import scale with actor visibility", async () => {
  const { scene, engine } = createTestEngine();
  const sync = new EditorSceneSync(scene);
  disposers.push(() => { sync.dispose(); scene.dispose(); engine.dispose(); });
  const data = { ...createDefaultScene(), actors: [createActor("stroke", "Stroke", { visible: false, locked: true, components: [{ id: "foliage", classId: "FoliageComponent", properties: { batches: [{ modelGuid: "tree", transforms: packFoliageTransforms([identitySerializedTransform()]) }] } }] })] };
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
  sync.apply({ ...createDefaultScene(), actors: [createActor("stroke", "Stroke", { components: [{ id: "foliage", classId: "FoliageComponent", properties: { batches: [{ modelGuid: "tree", transforms: packFoliageTransforms([identitySerializedTransform()]) }] } }] })] });
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
  const properties = { batches: [{ modelGuid: "tree", transforms: packFoliageTransforms([identitySerializedTransform()]) }] };
  const foliage = (next: typeof properties) => ({ ...createDefaultScene(), actors: [createActor("stroke", "Stroke", { components: [{ id: "foliage", classId: "FoliageComponent", properties: next }] })] });
  sync.apply(foliage(properties));
  await sync.whenEditorModelsReady();
  const first = sync.meshForComponent("stroke", "foliage")!;
  sync.apply(foliage(properties));
  await sync.whenEditorModelsReady();
  expect(sync.meshForComponent("stroke", "foliage")).toBe(first);
  sync.apply(foliage({ batches: [{ modelGuid: "tree", transforms: packFoliageTransforms([identitySerializedTransform(), { ...identitySerializedTransform(), position: [4, 0, 0] }]) }] }));
  await sync.whenEditorModelsReady();
  const rebuilt = sync.meshForComponent("stroke", "foliage")!;
  expect(rebuilt).not.toBe(first);
  expect(rebuilt.getChildMeshes().find((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.hasThinInstances)?.thinInstanceCount).toBe(2);
});

/**
 * A meadow of three cells at x = 5, 50 and 100 drawing a Standard Material, at Low quality (distances scaled by 0.75:
 * cull 60 m, fade from 45 m, shadows to 30 m), seen from `camera`. `fade` binds a cell's Material for one draw and returns
 * the fade range the draw uploads; `casts` asks a shadow caster list whether a map would draw the cell.
 */
async function meadow(editor: boolean) {
  const { FreeCamera } = await import("@babylonjs/core/Cameras/freeCamera");
  const { Plane } = await import("@babylonjs/core/Maths/math.plane");
  const { RENDER_QUALITY_PROFILES } = await import("@haptic/core");
  const { updateSceneRenderingSettings } = await import("./render-settings");
  const { ShadowCasterList } = await import("./shadow-caster-list");
  const { showEveryFoliageCell } = await import("./foliage-mesh");
  const { engine, scene } = createTestEngine();
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  if (editor) showEveryFoliageCell(scene);
  const camera = new FreeCamera("cam", new Vector3(0, 2, 0), scene);
  scene.activeCamera = camera;
  updateSceneRenderingSettings(scene, { quality: RENDER_QUALITY_PROFILES.low });
  const material = new StandardMaterial("grass", scene);
  const assets = { modelSources: new Map([["grass", installAssetBytes(encodeTriangleGlb(), "model/gltf-binary")]]), resolveMaterial: () => material };
  const root = createFoliageMesh(scene, "meadow", {
    batches: [{
      modelGuid: "grass", materialGuid: "grass-material", cullDistance: 80, fadeRange: 20, shadowDistance: 40,
      transforms: packFoliageTransforms([5, 50, 100].map((x) => ({ ...identitySerializedTransform(), position: [x, 0, 0] }))),
    }],
  }, assets);
  await foliagePreparation(root);
  const cells = root.getChildMeshes().filter((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.hasThinInstances);
  expect(cells).toHaveLength(3);
  const at = (x: number) => cells.find((cell) => Math.abs(cell.getBoundingInfo().boundingSphere.centerWorld.x - x) < 5)!;
  const casters = new ShadowCasterList();
  for (const cell of cells) casters.add(cell);
  disposers.push(() => casters.dispose());
  const everywhere = [new Plane(0, 1, 0, 1000)];
  const casts = (cell: Mesh) => casters.queryPlanes(everywhere).includes(cell);
  const fade = (cell: Mesh) => {
    expect(material.isReadyForSubMesh(cell, cell.subMeshes[0]!, true)).toBe(true);
    const ubo = (material as unknown as { _uniformBuffer: { updateFloat2: (name: string, x: number, y: number) => void } })._uniformBuffer;
    const ranges: number[][] = [];
    const update = ubo.updateFloat2.bind(ubo);
    const spy = vi.spyOn(ubo, "updateFloat2").mockImplementation((name: string, x: number, y: number) => {
      if (name === "hapticFoliageFade") ranges.push([x, y]);
      update(name, x, y);
    });
    material.bindForSubMesh(cell.getWorldMatrix(), cell, cell.subMeshes[0]!);
    spy.mockRestore();
    return ranges[0];
  };
  return { scene, camera, root, near: at(5), mid: at(50), far: at(100), casts, fade };
}

it("distance-culls, shadow-culls and fades Play's foliage cells from the frame's camera, scaled by quality, without readiness", async () => {
  const { onSceneReadinessDirty } = await import("./scene-readiness-signal");
  const { scene, camera, near, mid, far, casts, fade } = await meadow(false);
  const readiness: string[] = [];
  disposers.push(onSceneReadinessDirty(scene, (reason) => readiness.push(reason)));
  scene.render();
  expect([near, mid, far].map((cell) => cell.isEnabled())).toEqual([true, true, false]);
  expect([near, mid, far].map(casts)).toEqual([true, false, false]);
  expect(fade(near)).toEqual([0, 0]);
  expect(fade(mid)).toEqual([45, 60]);
  // A hidden actor stays hidden whatever its distance: culling enables and disables, never changes visibility.
  near.isVisible = false;
  camera.position.set(95, 2, 0);
  scene.render();
  expect([near, mid, far].map((cell) => cell.isEnabled())).toEqual([false, true, true]);
  expect(near.isVisible).toBe(false);
  expect([mid, far].map(casts)).toEqual([false, true]);
  expect(fade(far)).toEqual([0, 0]);
  expect(readiness).toEqual([]);
});

it("applies new distances to Play's existing cells in the next frame", async () => {
  const { applyFoliageDistances } = await import("./foliage-mesh");
  const { scene, root, near, mid, far, casts, fade } = await meadow(false);
  scene.render();
  applyFoliageDistances(root, {
    batches: [{
      modelGuid: "grass", materialGuid: "grass-material", cullDistance: 200, fadeRange: 0, shadowDistance: 100,
      transforms: packFoliageTransforms([5, 50, 100].map((x) => ({ ...identitySerializedTransform(), position: [x, 0, 0] }))),
    }],
  });
  scene.render();
  // Low quality: cull 150 m, no fade, shadows to 75 m.
  expect([near, mid, far].map((cell) => cell.isEnabled())).toEqual([true, true, true]);
  expect([near, mid, far].map(casts)).toEqual([true, true, false]);
  expect(fade(mid)).toEqual([0, 0]);
});

it("applies a Foliage distance edit to the editor's foliage in place, through undo, and rebuilds for any other edit", async () => {
  const { isFoliageDistanceOnlySceneEdit } = await import("./foliage-mesh");
  const { scene, engine } = createTestEngine();
  const sync = new EditorSceneSync(scene);
  disposers.push(() => { sync.dispose(); scene.dispose(); engine.dispose(); });
  sync.setMeshAssets({ modelSources: new Map([["tree", installAssetBytes(encodeTriangleGlb(), "model/gltf-binary")]]) });
  const transforms = [identitySerializedTransform(), { ...identitySerializedTransform(), position: [40, 0, 0] as [number, number, number] }];
  const model = { modelGuid: "tree", materialGuid: null, weight: 1, minScale: 1, maxScale: 1, cullDistance: 120, fadeRange: 15, shadowDistance: 45 };
  const document = (cullDistance: number, positions = transforms) => {
    const base = createDefaultScene();
    return {
      ...base,
      settings: { ...base.settings, foliageGroups: [{ id: "trees", name: "Trees", models: [{ ...model, cullDistance }] }] },
      actors: [createActor("stroke", "Stroke", { components: [{ id: "foliage", classId: "FoliageComponent", properties: {
        groupId: "trees", batches: [{ modelGuid: "tree", materialGuid: null, cullDistance, fadeRange: 15, shadowDistance: 45, transforms: packFoliageTransforms(positions) }],
      } }] })],
    };
  };
  const original = document(120);
  sync.apply(original);
  await sync.whenEditorModelsReady();
  const root = sync.meshForComponent("stroke", "foliage")!;
  const cells = root.getChildMeshes().filter((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.hasThinInstances);
  expect(cells).toHaveLength(2);
  const edited = document(30);
  expect(isFoliageDistanceOnlySceneEdit(original, edited)).toBe(true);
  sync.apply(edited);
  await sync.whenEditorModelsReady();
  expect(sync.meshForComponent("stroke", "foliage")).toBe(root);
  expect(cells.every((cell) => !cell.isDisposed())).toBe(true);
  // Undo applies the earlier document the same way.
  expect(isFoliageDistanceOnlySceneEdit(edited, original)).toBe(true);
  sync.apply(original);
  await sync.whenEditorModelsReady();
  expect(sync.meshForComponent("stroke", "foliage")).toBe(root);
  // Moving an instance, or any other group setting, is not a distance edit.
  const moved = document(120, [identitySerializedTransform(), { ...identitySerializedTransform(), position: [41, 0, 0] }]);
  expect(isFoliageDistanceOnlySceneEdit(original, moved)).toBe(false);
  const reweighted = { ...original, settings: { ...original.settings, foliageGroups: [{ id: "trees", name: "Trees", models: [{ ...model, weight: 2 }] }] } };
  expect(isFoliageDistanceOnlySceneEdit(original, reweighted)).toBe(false);
  sync.apply(moved);
  await sync.whenEditorModelsReady();
  expect(sync.meshForComponent("stroke", "foliage")).not.toBe(root);
});

it("never culls or fades foliage cells in an editor view, however far its camera", async () => {
  const { scene, camera, near, mid, far, casts, fade } = await meadow(true);
  camera.position.set(-500, 2, 0);
  scene.render();
  for (const cell of [near, mid, far]) {
    expect(cell.isEnabled()).toBe(true);
    expect(casts(cell)).toBe(true);
    expect(fade(cell)).toEqual([0, 0]);
  }
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
      transforms: packFoliageTransforms([
        { ...identitySerializedTransform(), position: [5, 0, 0] },
        { ...identitySerializedTransform(), position: [50, 0, 0] },
      ]),
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
  nearMesh.metadata = { hapticFoliageFade: null };
  fadeMesh.metadata = { hapticFoliageFade: [85, 100] };

  expect(material.isReadyForSubMesh(nearMesh, nearMesh.subMeshes[0]!, false)).toBe(true);
  expect(material.isReadyForSubMesh(fadeMesh, fadeMesh.subMeshes[0]!, false)).toBe(true);
  material.freeze();

  const ubo = (material as unknown as { _uniformBuffer: { updateFloat2: (name: string, x: number, y: number) => void } })._uniformBuffer;
  expect(ubo).toBeDefined();
  const fadeCalls: Array<[number, number]> = [];
  const origUpdateFloat2 = ubo!.updateFloat2.bind(ubo);
  vi.spyOn(ubo!, "updateFloat2").mockImplementation((name: string, x: number, y: number) => {
    if (name === "hapticFoliageFade") fadeCalls.push([x, y]);
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

it.each([
  { largeWorld: false, eye: [1000, 2, 3] },
  { largeWorld: true, eye: [0, 0, 0] },
])("binds the fade eye in the space of the surface's world positions (Large World Rendering $largeWorld)", async ({ largeWorld, eye }) => {
  const { FreeCamera } = await import("@babylonjs/core/Cameras/freeCamera");
  const { CreateBox } = await import("@babylonjs/core/Meshes/Builders/boxBuilder");
  const { Scene } = await import("@babylonjs/core/scene");
  const { createHeadlessEngine } = await import("./large-world");
  const engine = createHeadlessEngine();
  const scene = new Scene(engine, { useFloatingOrigin: largeWorld });
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  // Far from the origin: with the floating origin, vPositionW is relative to this eye.
  const camera = new FreeCamera("cam", new Vector3(1000, 2, 3), scene);
  camera.getViewMatrix();
  scene.activeCamera = camera;
  const material = new StandardMaterial("foliage", scene);
  const mesh = CreateBox("fade", { size: 1 }, scene);
  mesh.material = material;
  mesh.metadata = { hapticFoliageFade: [85, 100] };
  expect(material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!, false)).toBe(true);
  const ubo = (material as unknown as { _uniformBuffer: { updateFloat3: (name: string, x: number, y: number, z: number) => void } })._uniformBuffer;
  const eyes: number[][] = [];
  const update = ubo.updateFloat3.bind(ubo);
  vi.spyOn(ubo, "updateFloat3").mockImplementation((name: string, x: number, y: number, z: number) => {
    if (name === "hapticFoliageCamera") eyes.push([x, y, z]);
    update(name, x, y, z);
  });
  material.bindForSubMesh(mesh.getWorldMatrix(), mesh, mesh.subMeshes[0]!);
  expect(eyes).toEqual([eye]);
});

it("reports once per Model when its levels of detail cannot attach to the foliage, which keeps full detail", async () => {
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  let attaches = 0;
  lodOverride.current = async () => ({
    levelsFor: () => { attaches++; throw new Error("index buffer rejected"); },
    indexBytes: 0,
    dispose: () => {},
  });
  const { engine, scene } = createTestEngine();
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  const assets = { modelSources: new Map([["tree", installAssetBytes(encodeTriangleGlb(), "model/gltf-binary")]]) };
  const strokes = ["a", "b"].map((name) => createFoliageMesh(scene, name, {
    batches: [{ modelGuid: "tree", transforms: packFoliageTransforms([identitySerializedTransform(), { ...identitySerializedTransform(), position: [40, 0, 0] }]) }],
  }, assets));
  await Promise.all(strokes.map((root) => foliagePreparation(root)));
  await vi.waitFor(() => expect(attaches).toBe(2));
  await Promise.resolve();
  const reports = warnings.mock.calls.filter(([message]) => String(message).includes("levels of detail"));
  expect(reports).toHaveLength(1);
  expect(String(reports[0]![0])).toContain("Model tree");
  expect(String(reports[0]![0])).toContain("index buffer rejected");
  const cells = strokes.flatMap((root) => root.getChildMeshes().filter((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.hasThinInstances));
  expect(cells.every((cell) => !cell.geometry!.id.includes(":lod"))).toBe(true);
});

