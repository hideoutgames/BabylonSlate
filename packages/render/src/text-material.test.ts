import { Matrix, Mesh, StandardMaterial, type Effect } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultMaterialDocument, lowerMaterialDocument, setMaterialDomain } from "@babylonslate/shader-graph";
import { createActor, createText2DComponent, parseText2DProperties } from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { MaterialLibrary } from "./material-library";
import { createText2DMesh, refreshText2DMaterials } from "./text2d-mesh";
import { textMaterialGlyphBinding } from "./text-material-block";
import { applyAssignMaterial, applyAssignMesh, createSnapshotSceneBinding } from "./snapshot-apply";
import { EditorSceneSync } from "./editor-scene-sync";
import { createDefaultScene } from "@babylonslate/core";

const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); });

function host() {
  const handle = createTestEngine();
  const library = new MaterialLibrary();
  const document = createDefaultMaterialDocument("Letters", "text");
  const assets = { resolveMaterial: (guid: string) => guid === "letters" ? library.resolve(handle.scene, guid, document) : null };
  disposers.push(() => { library.dispose(); handle.scene.dispose(); handle.engine.dispose(); });
  return { ...handle, library, document, assets };
}

describe("Text Materials", () => {
  it("round trips a dedicated text output and rejects world shading after a domain switch", () => {
    const document = createDefaultMaterialDocument();
    document.nodes.push({ id: "normal", type: "input.worldNormal", properties: {}, position: { x: 0, y: 0 } });
    const switched = setMaterialDomain(document, "text");
    expect(switched.nodes.some((node) => node.id === "normal")).toBe(false);
    const lowered = lowerMaterialDocument(JSON.parse(JSON.stringify(switched)));
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.plan.domain).toBe("text");
    expect(lowered.plan.outputs.color).toEqual({ kind: "constant", type: "vec4", value: [1, 1, 1, 1] });
  });

  it("keeps per-text atlases when two labels share a frozen Text Material", async () => {
    const { scene, assets, library, document } = host();
    scene.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
    const first = createText2DMesh(scene, "first", { text: "A", materialGuid: "letters" }, assets);
    const second = createText2DMesh(scene, "second", { text: "B", color: [0, 1, 0], materialGuid: "letters" }, assets);
    const firstGlyph = first.getChildMeshes()[0] as Mesh;
    const secondGlyph = second.getChildMeshes()[0] as Mesh;
    const material = library.resolve(scene, "letters", document)!;
    expect(firstGlyph.material).toBe(material);
    expect(secondGlyph.material).toBe(material);
    for (const glyph of [firstGlyph, secondGlyph]) await material.forceCompilationAsync(glyph);
    material.freeze();
    const samples: unknown[] = [];
    const effects = new Set<Effect>();
    for (const glyph of [firstGlyph, secondGlyph]) {
      const effect = glyph.subMeshes[0]!.effect!;
      if (!effects.has(effect)) {
        effects.add(effect);
        const original = effect.setTexture.bind(effect);
        vi.spyOn(effect, "setTexture").mockImplementation((name, texture) => {
          if (name.startsWith("textGlyphAtlas")) samples.push(texture);
          return original(name, texture);
        });
      }
      material.bindForSubMesh(glyph.computeWorldMatrix(true), glyph, glyph.subMeshes[0]!);
    }
    expect(samples.slice(-2)).toEqual([textMaterialGlyphBinding(firstGlyph)!.atlas, textMaterialGlyphBinding(secondGlyph)!.atlas]);
    expect(samples.at(-1)).not.toBe(samples.at(-2));
    first.dispose();
    expect(secondGlyph.material).toBe(material);
    expect(scene.textures).toContain(textMaterialGlyphBinding(secondGlyph)!.atlas);
  });

  it("preserves inline images and default glyphs for non-Text assignments", () => {
    const { scene, assets } = host();
    const root = createText2DMesh(scene, "rich", { text: "[u]AB[/u][img=photo]", materialGuid: "letters" }, assets, { rich: true });
    const image = root.getChildMeshes().find((mesh) => mesh.metadata?.text2dSource === "image")!;
    const imageMaterial = image.material;
    const surface = new StandardMaterial("Surface", scene);
    surface.metadata = { materialDomain: "surface" };
    refreshText2DMaterials(root, { resolveMaterial: () => surface });
    expect(image.material).toBe(imageMaterial);
    expect(root.getChildMeshes().every((glyph) => glyph.material !== surface)).toBe(true);
    const bitmap = root.getChildMeshes().find((mesh) => mesh.metadata?.text2dSource === "bitmap")!;
    expect((bitmap.material as StandardMaterial).diffuseTexture).toBeTruthy();
  });

  it("maps material UVs across the text box or independently over each glyph", () => {
    const { scene, assets } = host();
    const props = { text: "AB", size: 100, wrapWidth: 200, wrapHeight: 100, materialGuid: "letters" };
    const across = createText2DMesh(scene, "across", props, assets);
    const each = createText2DMesh(scene, "each", { ...props, materialUv: "glyph" }, assets);
    const [left, right] = across.getChildMeshes().map((glyph) => textMaterialGlyphBinding(glyph as Mesh)!);
    expect(right!.materialRect[0]).toBeGreaterThan(left!.materialRect[0]);
    expect(left!.materialRect[2]).toBeLessThan(1);
    for (const glyph of each.getChildMeshes()) expect(textMaterialGlyphBinding(glyph as Mesh)!.materialRect).toEqual([0, 0, 1, 1]);
  });

  it("updates editor text assignments and keeps Play glyph masks out of generic assignments", () => {
    const { scene, assets } = host();
    const component = createText2DComponent("label");
    component.properties = { ...component.properties, materialGuid: "letters" };
    const document = createDefaultScene("2d");
    document.actors = [createActor("actor", "Text", { components: [component] })];
    const sync = new EditorSceneSync(scene, undefined, assets);
    sync.apply(document);
    expect(scene.meshes.some((mesh) => mesh.metadata?.text2dGlyph && mesh.material?.metadata?.materialDomain === "text")).toBe(true);
    component.properties.materialGuid = null;
    sync.apply(document);
    expect(scene.meshes.some((mesh) => mesh.metadata?.text2dGlyph && mesh.material?.metadata?.materialDomain === "text")).toBe(false);
    sync.dispose();
    const binding = createSnapshotSceneBinding();
    binding.resolveMaterial = assets.resolveMaterial;
    applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 3, meshKind: "2dtext", meshAssetGuid: null,
      text2d: parseText2DProperties({ text: "A", materialGuid: "letters" }) });
    const glyph = binding.meshes.get(3)!.getChildMeshes()[0]!;
    const material = glyph.material;
    applyAssignMaterial(scene, binding, { type: "assignMaterial", slotId: 3, materialAssetGuid: null });
    expect(glyph.material).toBe(material);
    expect(glyph.material?.metadata?.materialDomain).toBe("text");
  });
});
