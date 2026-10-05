import { Material, Mesh, StandardMaterial } from "@babylonjs/core";
import { installAssetBytes } from "@babylonslate/assets";
import { installTextureBytes } from "./mesh-assets";
import { afterEach, expect, it, vi } from "vitest";
import { identityTransform, parseText2DProperties } from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { createText2DMesh, updateText2DAppear } from "./text2d-mesh";
import { applyAssignMaterial, applyAssignMesh, applyComponentTransformsCommand, applyOverlayVisualStyleCommand, applyText2DAppearCommand, createSnapshotSceneBinding, createPlayMesh, playComponentMeshName, retirePlaySlot, type AssignMeshPart } from "./snapshot-apply";
import { overlayVisualStyle } from "./overlay-visual-style";
import type { GlyphMetricsProvider } from "./text2d-layout";
import { ResourceCache } from "./resource-cache";
import { encodeParentedAnimatedTriangleGlb } from "./glb-test-fixtures";
import * as modelContainer from "./model-container";

const handles: ReturnType<typeof createTestEngine>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const handle of handles.splice(0)) { handle.scene.dispose(); handle.engine.dispose(); } });
function host() { const handle = createTestEngine(); handles.push(handle); return handle; }
const metrics: GlyphMetricsProvider = {
  measureGlyph: (_ch, style) => ({ width: style.size / 200, height: style.size / 100, advance: style.size / 200, bearingX: 0, bearingY: 0, source: "bitmap" }),
  measureImage: (_guid, size) => ({ width: size / 100, height: size / 100 }),
};

it("reveals formatted glyphs, images and underlines together while preserving stacked effects", () => {
  const { scene } = host();
  const resourceCache = new ResourceCache();
  scene.onDisposeObservable.addOnce(() => resourceCache.dispose());
  const root = createText2DMesh(scene, "rich", {
    text: "[u][color=red][b][wave=2][rotate=45]A[img=photo]B[/rotate][/wave][/b][/color][/u]",
    size: 32, appearModes: ["fade", "scale", "slide"], appearTransition: "linear",
    appearInterval: 0.1, appearDuration: 0.2, appearStart: "hidden",
  }, { resourceCache, textureBytes: installTextureBytes(new Map([["photo", new Uint8Array([1, 2, 3])]])) }, { rich: true, metrics });
  const children = root.getChildMeshes();
  const [a, image, b] = children.slice(0, 3);
  const underlines = children.filter((child) => child.name.includes(":underline:"));
  expect(children).toHaveLength(6);
  expect(children.every((child) => child.visibility === 0)).toBe(true);
  updateText2DAppear(root, 1);
  root.metadata.tickText2DEffects(0.7);
  const rest = children.map((child) => ({ y: child.position.y, rotation: child.rotation.z }));
  updateText2DAppear(root, 0.5); // 0.2s of a 0.4s timeline: A finished, image halfway, B waiting.
  expect(a!.visibility).toBe(1);
  expect(image!.visibility).toBeCloseTo(0.5);
  expect((image!.material as StandardMaterial).diffuseTexture).toBeTruthy();
  for (const child of children) {
    expect(child.material!.needAlphaBlendingForMesh(child)).toBe(true);
    // Fade must preserve low alpha instead of discarding it at the cutout threshold.
    expect(child.material!.transparencyMode).toBe(Material.MATERIAL_ALPHABLEND);
  }
  expect(b!.visibility).toBe(0);
  expect(image!.scaling.x).toBeCloseTo(0.5);
  expect(image!.position.y).toBeCloseTo(rest[1]!.y - 0.16);
  expect(image!.rotation.z).toBeCloseTo(rest[1]!.rotation);
  expect(image!.rotation.z).not.toBe(0);
  expect(underlines.map((line) => line.visibility)).toEqual([1, 0.5, 0]);
  updateText2DAppear(root, 1);
  expect(children.every((child) => child.visibility === 1)).toBe(true);
  expect(image!.scaling.x).toBe(1);
  expect(image!.position.y).toBeCloseTo(rest[1]!.y);
});

it("reveals all characters simultaneously with zero interval and reverses the same poses", () => {
  const { scene } = host();
  const root = createText2DMesh(scene, "together", {
    text: "[b]AB[/b][img=photo]", appearModes: ["fade", "scale"],
    appearTransition: "cubicOut", appearInterval: 0, appearDuration: 1,
  }, undefined, { rich: true, metrics });
  updateText2DAppear(root, 0.5);
  for (const child of root.getChildMeshes()) {
    expect(child.visibility).toBeCloseTo(0.875);
    expect(child.scaling.x).toBeCloseTo(0.875);
  }
  updateText2DAppear(root, 0);
  expect(root.getChildMeshes().every((child) => child.visibility === 0)).toBe(true);
});

it("targets one text component, keeps atlas identity, and retains progress when its visual is recreated", () => {
  const { scene } = host();
  const binding = createSnapshotSceneBinding();
  const text2d = parseText2DProperties({ text: "AB", appearModes: ["fade"], appearTransition: "linear", appearInterval: 0, appearDuration: 1, appearProgress: 0 }, { rich: true });
  applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 0, primaryComponentId: "rich", meshKind: "2drichtext", meshAssetGuid: null, text2d });
  const root = binding.meshes.get(0)!;
  const child = root.getChildMeshes()[0] as Mesh;
  const material = child.material;
  applyText2DAppearCommand(binding, { type: "setText2DAppear", slotId: 0, componentId: "other", progress: 1 });
  expect(child.visibility).toBe(0);
  applyText2DAppearCommand(binding, { type: "setText2DAppear", slotId: 0, componentId: "rich", progress: 0.5 });
  expect(binding.meshes.get(0)).toBe(root);
  expect(child.material).toBe(material);
  expect(child.visibility).toBeCloseTo(0.5);
  const recreated = createPlayMesh(scene, 0, "2drichtext", null, binding);
  expect(recreated.getChildMeshes()[0]!.visibility).toBeCloseTo(0.5);
});

function richPart(componentId: string, parentId: string | null = null): AssignMeshPart {
  return {
    componentId, parentId, meshKind: "2drichtext", meshAssetGuid: null,
    position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
    text2d: parseText2DProperties({ text: "AB", appearModes: ["fade"], appearTransition: "linear",
      appearInterval: 0, appearDuration: 1, appearProgress: 0 }, { rich: true }),
  };
}

function partGlyph(root: Mesh, componentId: string): Mesh {
  const part = root.getChildMeshes().find((mesh) => mesh.name === playComponentMeshName(0, componentId))!;
  return part.getChildMeshes(true).find((mesh) => mesh.metadata?.text2dGlyph) as Mesh;
}

it("routes nested component reveals without walking glyph hierarchies and replaces retired visual indexes", () => {
  const { scene } = host();
  const binding = createSnapshotSceneBinding();
  const assign = () => applyAssignMesh(scene, binding, {
    type: "assignMesh", slotId: 0, meshKind: "2drichtext", meshAssetGuid: null,
    parts: [richPart("a"), richPart("b", "a")],
  });
  const reveal = (componentId: string, progress: number) =>
    applyText2DAppearCommand(binding, { type: "setText2DAppear", slotId: 0, componentId, progress });
  assign();
  const first = binding.meshes.get(0)!;
  const a = partGlyph(first, "a"), b = partGlyph(first, "b");
  // A reveal tick must not allocate/traverse a collection of every glyph in the actor.
  const traversal = vi.spyOn(first, "getChildMeshes");
  for (let step = 1; step <= 10; step++) {
    reveal("a", step / 20);
    reveal("b", 1 - step / 40);
  }
  expect(a.visibility).toBeCloseTo(0.5);
  expect(b.visibility).toBeCloseTo(0.75);
  expect(traversal).not.toHaveBeenCalled();

  assign();
  expect(first.isDisposed()).toBe(true);
  const second = binding.meshes.get(0)!;
  const nextA = partGlyph(second, "a"), nextB = partGlyph(second, "b");
  reveal("b", 0.4);
  expect(nextA.visibility).toBe(0);
  expect(nextB.visibility).toBeCloseTo(0.4);
  retirePlaySlot(binding, 0);
  expect(second.isDisposed()).toBe(true);
  reveal("b", 1);
  assign();
  const reused = binding.meshes.get(0)!;
  const reusedA = partGlyph(reused, "a"), reusedB = partGlyph(reused, "b");
  reveal("a", 0.9);
  expect(reusedA.visibility).toBeCloseTo(0.9);
  expect(reusedB.visibility).toBe(0);
});

it("retains reveal, style and motion through topology changes and restarted asynchronous publication", async () => {
  const { scene } = host();
  const binding = createSnapshotSceneBinding();
  binding.modelSources = new Map([["model", installAssetBytes(encodeParentedAnimatedTriangleGlb("model"))]]);
  let finishLoad!: () => void;
  const gate = new Promise<void>((resolve) => { finishLoad = resolve; });
  const loadModel = modelContainer.loadModelContainer;
  // Hold only asset loading; construction, parenting, reveal routing and publication stay real.
  vi.spyOn(modelContainer, "loadModelContainer").mockImplementation(async (...args) => {
    await gate;
    return loadModel(...args);
  });
  applyAssignMesh(scene, binding, {
    type: "assignMesh", slotId: 0, primaryComponentId: "a", meshKind: "2drichtext", meshAssetGuid: null,
    text2d: richPart("a").text2d,
  });
  const live = binding.meshes.get(0)!;
  const liveGlyph = live.getChildMeshes()[0]!;
  applyAssignMesh(scene, binding, {
    type: "assignMesh", slotId: 0, meshKind: "2drichtext", meshAssetGuid: null,
    parts: [richPart("a"), richPart("b"), {
      componentId: "model", parentId: null, meshKind: "box", meshAssetGuid: "model",
      position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
    }],
  });
  let load = binding.slotAnimLoads!.get(0)!;
  try {
    const prepared = scene.meshes.find((mesh) => mesh.name === "actor-0" && mesh !== live) as Mesh;
    const preparedA = partGlyph(prepared, "a"), preparedB = partGlyph(prepared, "b");
    const liveTraversal = vi.spyOn(live, "getChildMeshes");
    const preparedTraversal = vi.spyOn(prepared, "getChildMeshes");
    applyText2DAppearCommand(binding, { type: "setText2DAppear", slotId: 0, componentId: "a", progress: 0.4 });
    applyText2DAppearCommand(binding, { type: "setText2DAppear", slotId: 0, componentId: "b", progress: 0.7 });
    applyOverlayVisualStyleCommand(binding, { type: "setOverlayVisualStyle", slotId: 0, componentId: "a", style: { opacity: 0.25, tint: [0.5, 1, 1, 1] } });
    applyComponentTransformsCommand(binding, { type: "setComponentTransforms", slotId: 0,
      parts: [{ componentId: "a", transform: { ...identityTransform(), position: { x: 2, y: 3, z: 0 } } }] });
    expect(binding.meshes.get(0)).toBe(live);
    expect(liveGlyph.visibility).toBeCloseTo(0.4);
    expect(preparedA.visibility).toBeCloseTo(0.4);
    expect(preparedB.visibility).toBeCloseTo(0.7);
    expect(overlayVisualStyle(liveGlyph).opacity).toBe(0.25);
    expect(overlayVisualStyle(preparedA).opacity).toBe(0.25);
    expect((preparedA.parent as Mesh).position.asArray()).toEqual([2, 3, 0]);
    expect(liveTraversal).not.toHaveBeenCalled();
    expect(preparedTraversal).not.toHaveBeenCalled();
    applyAssignMaterial(scene, binding, { type: "assignMaterial", slotId: 0, componentId: "model", materialAssetGuid: "replacement" });
    load = binding.slotAnimLoads!.get(0)!;
    const restarted = scene.meshes.find((mesh) => mesh.name === "actor-0" && mesh !== live && !mesh.isDisposed()) as Mesh;
    const restartedA = partGlyph(restarted, "a"), restartedB = partGlyph(restarted, "b");
    expect(prepared.isDisposed()).toBe(true);
    expect(overlayVisualStyle(restartedA).opacity).toBe(0.25);
    expect((restartedA.parent as Mesh).position.asArray()).toEqual([2, 3, 0]);
    finishLoad();
    await load;
    expect(binding.meshes.get(0)).toBe(restarted);
    expect(live.isDisposed()).toBe(true);
    applyText2DAppearCommand(binding, { type: "setText2DAppear", slotId: 0, componentId: "a", progress: 0.9 });
    expect(restartedA.visibility).toBeCloseTo(0.9);
    expect(restartedB.visibility).toBeCloseTo(0.7);
  } finally {
    finishLoad();
    await load.catch(() => {});
  }
});
