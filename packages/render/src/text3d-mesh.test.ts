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
      alignment: "left",
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
      alignment: "left",
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
      alignment: "left",
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
        alignment: "left",
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
        alignment: "left",
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
    actor.components[0]!.properties.alignment = "right";
    expect(actorVisualFingerprint(actor)).not.toBe(
      actorVisualFingerprint({
        ...actor,
        components: [
          {
            ...actor.components[0]!,
            properties: { ...actor.components[0]!.properties, alignment: "left" },
          },
        ],
      }),
    );
  });

  it("keeps the bottom line at the origin and extra lines above", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const assets = {
      fontFacetypeBytes: new Map([
        ["font-t", new TextEncoder().encode(JSON.stringify(TEXT3D_TEST_FONTFACE_T))],
      ]),
    };
    const single = createText3DMesh(
      handle.scene,
      "one-line",
      { text: "T", size: 1, fontAssetGuid: "font-t", alignment: "left" },
      assets,
    );
    const stacked = createText3DMesh(
      handle.scene,
      "two-line",
      { text: "T\nT", size: 1, fontAssetGuid: "font-t", alignment: "left" },
      assets,
    );
    const crlf = createText3DMesh(
      handle.scene,
      "crlf",
      { text: "T\r\nT", size: 1, fontAssetGuid: "font-t", alignment: "left" },
      assets,
    );
    single.refreshBoundingInfo();
    stacked.refreshBoundingInfo();
    crlf.refreshBoundingInfo();
    const singleBox = single.getBoundingInfo().boundingBox;
    const stackedBox = stacked.getBoundingInfo().boundingBox;
    const crlfBox = crlf.getBoundingInfo().boundingBox;
    expect(stackedBox.minimum.y).toBeCloseTo(singleBox.minimum.y, 4);
    expect(stackedBox.maximum.y).toBeGreaterThan(singleBox.maximum.y + 0.2);
    expect(crlfBox.maximum.y).toBeCloseTo(stackedBox.maximum.y, 4);
    expect(crlfBox.maximum.x - crlfBox.minimum.x).toBeCloseTo(
      stackedBox.maximum.x - stackedBox.minimum.x,
      4,
    );
  });

  it("anchors the block left, center, or right on X with a bottom pivot", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const assets = {
      fontFacetypeBytes: new Map([
        ["font-t", new TextEncoder().encode(JSON.stringify(TEXT3D_TEST_FONTFACE_T))],
      ]),
    };
    const left = createText3DMesh(
      handle.scene,
      "align-left",
      { text: "T", size: 1, fontAssetGuid: "font-t", alignment: "left" },
      assets,
    );
    const center = createText3DMesh(
      handle.scene,
      "align-center",
      { text: "T", size: 1, fontAssetGuid: "font-t", alignment: "center" },
      assets,
    );
    const right = createText3DMesh(
      handle.scene,
      "align-right",
      { text: "T", size: 1, fontAssetGuid: "font-t", alignment: "right" },
      assets,
    );
    left.refreshBoundingInfo();
    center.refreshBoundingInfo();
    right.refreshBoundingInfo();
    const leftBox = left.getBoundingInfo().boundingBox;
    const centerBox = center.getBoundingInfo().boundingBox;
    const rightBox = right.getBoundingInfo().boundingBox;
    expect(leftBox.minimum.x).toBeCloseTo(0, 4);
    expect((centerBox.minimum.x + centerBox.maximum.x) / 2).toBeCloseTo(0, 4);
    expect(rightBox.maximum.x).toBeCloseTo(0, 4);
    expect(leftBox.minimum.y).toBeCloseTo(centerBox.minimum.y, 4);
    expect(rightBox.minimum.y).toBeCloseTo(centerBox.minimum.y, 4);
  });
});
