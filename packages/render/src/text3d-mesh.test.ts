import { Mesh, StandardMaterial, VertexBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createActor, createDefaultScene, createText3DComponent } from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { bundledAsciiTypeFace, TEXT3D_TEST_FONTFACE_T } from "./default-typeface";
import {
  actorVisualFingerprint,
  applySceneToBabylonScene,
  editorMeshName,
} from "./scene-loader";
import { createText3DMesh, resolveText3DFontData } from "./text3d-mesh";

describe("3D Text mesh", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  it("builds a flat T glyph with one unlit two-sided material", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const mesh = createText3DMesh(handle.scene, "letter-t", {
      text: "T",
      size: 1,
      depth: 0.1,
      color: [1, 0, 0],
      fontAssetGuid: "font-t",
    }, {
      fontFacetypeBytes: new Map([
        ["font-t", new TextEncoder().encode(JSON.stringify(TEXT3D_TEST_FONTFACE_T))],
      ]),
    });
    expect(mesh).toBeInstanceOf(Mesh);
    expect((mesh.metadata as { text3d?: boolean }).text3d).toBe(true);
    expect(mesh.subMeshes).toHaveLength(1);
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    expect(positions).not.toBeNull();
    const zs = new Set<number>();
    for (let i = 2; i < positions!.length; i += 3) {
      zs.add(Number(positions![i]!.toFixed(5)));
    }
    expect(zs.size).toBe(1);
    const indices = mesh.getIndices();
    expect(indices).not.toBeNull();
    expect(indices!.length).toBe(12);
    const material = mesh.material as StandardMaterial;
    expect(material).toBeInstanceOf(StandardMaterial);
    expect(material.disableLighting).toBe(true);
    expect(material.backFaceCulling).toBe(false);
    expect(material.twoSidedLighting).toBe(true);
    expect(material.emissiveColor.r).toBeCloseTo(1);
    expect(material.emissiveColor.g).toBeCloseTo(0);
    expect(material.emissiveColor.b).toBeCloseTo(0);
  });

  it("greedy-merges bundled ASCII T into two rectangles", () => {
    const outline = bundledAsciiTypeFace.glyphs.T?.o ?? "";
    const contours = outline.split("m ").filter((part) => part.length > 0);
    expect(contours).toHaveLength(2);
  });

  it("builds bundled T with at most four triangles", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const mesh = createText3DMesh(handle.scene, "bundled-t", {
      text: "T",
      size: 1,
      depth: 4,
      color: [1, 1, 1],
      fontAssetGuid: null,
    });
    const indices = mesh.getIndices();
    expect(indices).not.toBeNull();
    expect(indices!.length).toBeLessThanOrEqual(12);
  });

  it("falls back to a plane when no glyph paths exist", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const mesh = createText3DMesh(handle.scene, "blank", {
      text: " ",
      size: 2,
      depth: 0.1,
      color: [1, 1, 1],
      fontAssetGuid: "font-t",
    }, {
      fontFacetypeBytes: new Map([
        ["font-t", new TextEncoder().encode(JSON.stringify(TEXT3D_TEST_FONTFACE_T))],
      ]),
    });
    expect((mesh.metadata as { text3d?: boolean }).text3d).toBe(true);
    expect(mesh.subMeshes).toHaveLength(1);
    const indices = mesh.getIndices();
    expect(indices).not.toBeNull();
    expect(indices!.length).toBe(6);
    const material = mesh.material as StandardMaterial;
    expect(material.disableLighting).toBe(true);
    expect(material.backFaceCulling).toBe(false);
  });

  it("uses the bundled ASCII TypeFace when no Font facetype is present", () => {
    expect(bundledAsciiTypeFace.glyphs.T).toBeDefined();
    expect(bundledAsciiTypeFace.glyphs.e).toBeDefined();
    expect(bundledAsciiTypeFace.glyphs.x).toBeDefined();
    expect(bundledAsciiTypeFace.glyphs.t).toBeDefined();
    expect(TEXT3D_TEST_FONTFACE_T.glyphs.T?.o).toContain("m ");
    const resolved = resolveText3DFontData(
      {
        text: "Text",
        size: 1,
        depth: 0.1,
        color: [1, 1, 1],
        fontAssetGuid: "missing",
      },
      { fontFacetypeBytes: new Map() },
    );
    expect(resolved.bundled).toBe(true);
  });

  it("prefers a Font facetype chunk over the bundled TypeFace", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(TEXT3D_TEST_FONTFACE_T));
    const resolved = resolveText3DFontData(
      {
        text: "T",
        size: 1,
        depth: 0.1,
        color: [1, 1, 1],
        fontAssetGuid: "font-1",
      },
      { fontFacetypeBytes: new Map([["font-1", bytes]]) },
    );
    expect(resolved.bundled).toBe(false);
    expect(resolved.font.glyphs.T?.ha).toBe(600);
  });

  it("builds an editor mesh for Text3DComponent and fingerprints text edits", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const actor = createActor("label", "Label", {
      components: [createText3DComponent("text-comp")],
    });
    const sceneData = { ...createDefaultScene(), actors: [actor] };
    applySceneToBabylonScene(handle.scene, sceneData);
    const mesh = handle.scene.getMeshByName(editorMeshName("label"));
    expect(mesh).not.toBeNull();
    expect((mesh?.metadata as { text3d?: boolean } | null)?.text3d).toBe(true);
    const before = actorVisualFingerprint(actor);
    actor.components[0]!.properties.text = "Hi";
    expect(actorVisualFingerprint(actor)).not.toBe(before);
    actor.components[0]!.properties.depth = 9;
    expect(actorVisualFingerprint(actor)).toBe(
      actorVisualFingerprint({
        ...actor,
        components: [
          {
            ...actor.components[0]!,
            properties: { ...actor.components[0]!.properties, depth: 0.01 },
          },
        ],
      }),
    );
  });
});
