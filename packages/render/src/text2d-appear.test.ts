import { Material, Mesh, StandardMaterial } from "@babylonjs/core";
import { installTextureBytes } from "./mesh-assets";
import { afterEach, expect, it } from "vitest";
import { createTestEngine } from "./create-null-engine";
import { createText2DMesh, updateText2DAppear } from "./text2d-mesh";
import { applyAssignMesh, applyText2DAppearCommand, createSnapshotSceneBinding, createPlayMesh } from "./snapshot-apply";
import type { GlyphMetricsProvider } from "./text2d-layout";
import { ResourceCache } from "./resource-cache";

const handles: ReturnType<typeof createTestEngine>[] = [];
afterEach(() => { for (const handle of handles.splice(0)) { handle.scene.dispose(); handle.engine.dispose(); } });
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
  const text2d = { text: "AB", appearModes: ["fade" as const], appearTransition: "linear" as const, appearInterval: 0, appearDuration: 1, appearProgress: 0 };
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
