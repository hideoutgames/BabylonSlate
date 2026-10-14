import { Matrix, Quaternion, Vector3, VertexBuffer, type Mesh, type StandardMaterial } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createTestEngine } from "./create-null-engine";
import { writeOverlayBoxTransform } from "./overlay-transform-box";
import { textMaterialGlyphBinding } from "./text-material-block";
import { createText2DMesh, text2DMeshLayout, updateText2DAppear } from "./text2d-mesh";
import type { GlyphMetricsProvider, Text2DLayoutItem } from "./text2d-layout";

const handles: Array<ReturnType<typeof createTestEngine>> = [];
afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.scene.dispose();
    handle.engine.dispose();
  }
});
function host() {
  const handle = createTestEngine();
  handles.push(handle);
  return handle;
}

function fixedMetrics(): GlyphMetricsProvider {
  return {
    measureGlyph(_ch, style) {
      const world = style.size / 100;
      return { width: world * 0.5, height: world, bearingX: 0, bearingY: 0, advance: world * 0.5, source: "bitmap" };
    },
    measureImage(_guid, sizePx) {
      return { width: sizePx / 100, height: sizePx / 100 };
    },
  };
}

/** One `A` glyph in a 64x64 atlas; every other character falls back to Bitmap. */
const msdfAssets = {
  fontMsdfJson: new Map([["font-1", new TextEncoder().encode(JSON.stringify({
    info: { size: 32 },
    common: { scaleW: 64, scaleH: 64 },
    chars: [{ id: 65, x: 0, y: 0, width: 16, height: 16, xoffset: 0, yoffset: 0, xadvance: 16 }],
  }))]]),
  fontMsdfPng: new Map([["font-1", new Uint8Array([1, 2, 3])]]),
};

/** Direct children that draw glyphs: batches and per-glyph planes alike. */
function glyphMeshes(root: Mesh): Mesh[] {
  return root.getChildMeshes(true).filter((child) => child.metadata?.text2dGlyph) as Mesh[];
}
const positionsOf = (mesh: Mesh) => Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!);
const uvsOf = (mesh: Mesh) => Array.from(mesh.getVerticesData(VertexBuffer.UVKind)!);
const drawn = (items: readonly Text2DLayoutItem[]) => items.filter((item) => item.kind === "glyph" && item.ch?.trim());

/** Corners of the plane a glyph used to get as its own mesh, posed with Babylon's own transform maths. */
function perGlyphCorners(item: Text2DLayoutItem, msdf: boolean): number[] {
  const scale = item.style.bold && msdf ? 1.08 : 1;
  const rotation = item.style.italic && msdf ? -0.2 : 0;
  const pose = Matrix.Compose(new Vector3(scale, scale, 1), Quaternion.RotationYawPitchRoll(0, 0, rotation), new Vector3(item.x, item.y, 0));
  const halfW = Math.max(item.width, 0.001) / 2;
  const halfH = Math.max(item.height, 0.001) / 2;
  return [[-halfW, -halfH], [halfW, -halfH], [halfW, halfH], [-halfW, halfH]].flatMap(([x, y]) => {
    const corner = Vector3.TransformCoordinates(new Vector3(x, y, 0), pose);
    return [corner.x, corner.y, corner.z];
  });
}

describe("static glyph batching", () => {
  it("draws all static glyphs of one material with a single mesh", () => {
    const { scene } = host();
    const root = createText2DMesh(scene, "label", { text: "Feature Test HUD", size: 32 }, undefined, { metrics: fixedMetrics() });
    // Fourteen drawn glyphs; the two spaces draw nothing.
    expect(text2DMeshLayout(root)!.items.filter((item) => item.ch?.trim())).toHaveLength(14);
    const [batch, ...others] = glyphMeshes(root);
    expect(others).toEqual([]);
    expect(batch!.getTotalVertices()).toBe(14 * 4);
    expect(batch!.getTotalIndices()).toBe(14 * 6);
    expect(batch!.isPickable).toBe(false);
    expect(batch!.parent).toBe(root);
  });

  it("bakes each MSDF glyph's bold and italic pose and atlas rectangle into the batch", () => {
    const { scene } = host();
    const root = createText2DMesh(
      scene,
      "msdf",
      { text: "[b]A[/b][i]A[/i]A", renderer: "msdf", size: 32, fontAssetGuid: "font-1" },
      msdfAssets,
      { rich: true },
    );
    const [batch, ...others] = glyphMeshes(root);
    expect(others).toEqual([]);
    const items = drawn(text2DMeshLayout(root)!.items);
    expect(items.map((item) => [item.style.bold, item.style.italic])).toEqual([[true, false], [false, true], [false, false]]);
    const positions = positionsOf(batch!);
    const expected = items.flatMap((item) => perGlyphCorners(item, true));
    expect(positions).toHaveLength(expected.length);
    positions.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 5));
    // The A cell is 16x16 at the atlas origin of a 64x64 sheet, V up: u 0..0.25, v 0.75..1.
    expect(uvsOf(batch!)).toEqual([0, 0.75, 0.25, 0.75, 0.25, 1, 0, 1].concat(
      [0, 0.75, 0.25, 0.75, 0.25, 1, 0, 1],
      [0, 0.75, 0.25, 0.75, 0.25, 1, 0, 1],
    ));
  });

  it("keeps one batch per MSDF style and per material kind, in glyph order", () => {
    const { scene } = host();
    const root = createText2DMesh(
      scene,
      "mixed",
      { text: "[color=FF0000]A[/color]AB", renderer: "msdf", size: 32, fontAssetGuid: "font-1", color: [0, 1, 0] },
      msdfAssets,
      { rich: true },
    );
    const sources = glyphMeshes(root).map((mesh) => [mesh.metadata.text2dSource, mesh.getTotalVertices() / 4]);
    // Red A (msdf), green A (msdf), B (bitmap fallback): three materials, one quad each.
    expect(sources).toEqual([["msdf", 1], ["msdf", 1], ["bitmap", 1]]);
    const [red, green] = glyphMeshes(root);
    expect(red!.material).not.toBe(green!.material);
    const plain = createText2DMesh(scene, "plain", { text: "AAB", renderer: "msdf", size: 32, fontAssetGuid: "font-1" }, msdfAssets);
    expect(glyphMeshes(plain).map((mesh) => [mesh.metadata.text2dSource, mesh.getTotalVertices() / 4])).toEqual([["msdf", 2], ["bitmap", 1]]);
  });

  it("gives bitmap glyphs the atlas rectangle a standalone glyph plane gets", () => {
    const { scene } = host();
    const options = { rich: true, metrics: fixedMetrics() };
    const batched = createText2DMesh(scene, "batched", { text: "ABA", size: 32 }, undefined, options);
    // A letter effect keeps every glyph on its own plane, with the same atlas packing.
    const separate = createText2DMesh(scene, "separate", { text: "[shake=1]ABA[/shake]", size: 32 }, undefined, options);
    const planes = glyphMeshes(separate);
    expect(planes).toHaveLength(3);
    const [batch, ...others] = glyphMeshes(batched);
    expect(others).toEqual([]);
    expect(uvsOf(batch!)).toEqual(planes.flatMap(uvsOf));
    expect(new Set(planes.map((plane) => uvsOf(plane).join())).size).toBe(2);
    expect((batch!.material as StandardMaterial).diffuseTexture).toBeTruthy();
    const items = drawn(text2DMeshLayout(batched)!.items);
    const positions = positionsOf(batch!);
    const expected = items.flatMap((item) => perGlyphCorners(item, false));
    positions.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 5));
  });

  it("keeps glyphs with a letter effect on their own animated plane", () => {
    const { scene } = host();
    const root = createText2DMesh(scene, "fx", { text: "A[wave=2]B[/wave]C", size: 32 }, undefined, { rich: true, metrics: fixedMetrics() });
    const meshes = glyphMeshes(root);
    expect(meshes.map((mesh) => mesh.getTotalVertices() / 4)).toEqual([2, 1]);
    const [batch, wave] = meshes;
    expect(batch!.metadata.text2dBatch).toBe(true);
    expect(wave!.metadata.text2dBatch).toBeUndefined();
    const tick = (root.metadata as { tickText2DEffects: (time: number) => void }).tickText2DEffects;
    tick(0.25);
    const staticVersion = batch!.computeWorldMatrix().updateFlag;
    const y = wave!.position.y;
    tick(0.5);
    scene.incrementRenderId();
    expect(wave!.position.y).not.toBeCloseTo(y);
    expect(batch!.computeWorldMatrix().updateFlag).toBe(staticVersion);
    // The batch holds A and C where the layout put them; B is not in it.
    const items = text2DMeshLayout(root)!.items;
    const quads = positionsOf(batch!);
    expect(quads[0]).toBeCloseTo(items[0]!.x - items[0]!.width / 2, 5);
    expect(quads[12]).toBeCloseTo(items[2]!.x - items[2]!.width / 2, 5);
  });

  it.each(["fade", "scale", "slide", "instant"])("keeps one plane per glyph for the %s reveal", (mode) => {
    const { scene } = host();
    const root = createText2DMesh(scene, "reveal", { text: "ABC", size: 32, appearModes: [mode], appearInterval: 0.1, appearDuration: 0.2 }, undefined, { rich: true, metrics: fixedMetrics() });
    expect(glyphMeshes(root).map((mesh) => mesh.getTotalVertices())).toEqual([4, 4, 4]);
  });

  it("shows or hides a batch whole when a reveal without modes starts hidden", () => {
    const { scene } = host();
    const root = createText2DMesh(scene, "hidden", { text: "ABC", size: 32, appearStart: "hidden" }, undefined, { rich: true, metrics: fixedMetrics() });
    const [batch] = glyphMeshes(root);
    expect(glyphMeshes(root)).toHaveLength(1);
    expect(batch!.visibility).toBe(0);
    // Without reveal modes a character is either not yet revealed or revealed; no partial state exists.
    updateText2DAppear(root, 0.5);
    expect(batch!.visibility).toBe(0);
    updateText2DAppear(root, 1);
    expect(batch!.visibility).toBe(1);
    updateText2DAppear(root, 0);
    expect(batch!.visibility).toBe(0);
  });

  it("keeps underlines and inline images as their own planes beside the batch", () => {
    const { scene } = host();
    const root = createText2DMesh(scene, "deco", { text: "[u]AB[/u][img=photo]", size: 32 }, undefined, { rich: true, metrics: fixedMetrics() });
    const names = glyphMeshes(root).map((mesh) => mesh.name.replace(/^deco:/, "").replace(/:\d+$/, ""));
    expect(names.sort()).toEqual(["glyphs", "image", "underline"]);
    const batch = glyphMeshes(root).find((mesh) => mesh.metadata.text2dBatch)!;
    expect(batch.getTotalVertices()).toBe(8);
  });

  it("keeps a Text Material's glyphs on planes that bind their own atlas rectangle", () => {
    const { scene } = host();
    const root = createText2DMesh(scene, "material", { text: "AB", size: 32, materialGuid: "letters" }, undefined, { metrics: fixedMetrics() });
    const meshes = glyphMeshes(root);
    expect(meshes).toHaveLength(2);
    const [left, right] = meshes.map((mesh) => textMaterialGlyphBinding(mesh)!);
    expect(left!.atlasRect).not.toEqual(right!.atlasRect);
  });

  it("spreads batched glyphs with the box but keeps their size while an overlay-box resize is dragged", () => {
    const { scene } = host();
    const root = createText2DMesh(scene, "drag", { text: "ABC", size: 32 }, undefined, { metrics: fixedMetrics() });
    const start = { position: [0, 0, 0] as [number, number, number], rotationZ: 0, scale: [1, 1, 1] as [number, number, number] };
    writeOverlayBoxTransform(root, { ...start, scale: [2, 1, 1] }, start);
    writeOverlayBoxTransform(root, { ...start, scale: [3, 1, 1] }, start);
    root.computeWorldMatrix(true);
    const [batch] = glyphMeshes(root);
    const world = batch!.computeWorldMatrix(true);
    const positions = positionsOf(batch!);
    const items = drawn(text2DMeshLayout(root)!.items);
    items.forEach((item, glyph) => {
      const xs = [0, 1, 2, 3].map((corner) => Vector3.TransformCoordinates(new Vector3(positions[glyph * 12 + corner * 3], positions[glyph * 12 + corner * 3 + 1], 0), world).x);
      expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(item.x * 3, 5);
      expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(item.width, 5);
    });
  });

  it("releases the batch geometry and materials with the text", () => {
    const { scene } = host();
    const before = { meshes: scene.meshes.length, geometries: scene.geometries.length, materials: scene.materials.length, textures: scene.textures.length };
    createText2DMesh(scene, "gone", { text: "Hello", size: 32 }, undefined, { metrics: fixedMetrics() }).dispose();
    expect({ meshes: scene.meshes.length, geometries: scene.geometries.length, materials: scene.materials.length, textures: scene.textures.length }).toEqual(before);
  });
});
