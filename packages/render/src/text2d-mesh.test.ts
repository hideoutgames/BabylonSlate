import { Mesh, StandardMaterial } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createActor, createText2DComponent } from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import {
  actorVisualFingerprint,
  createMeshForComponent,
  editorMeshName,
} from "./scene-loader";
import { createText2DMesh } from "./text2d-mesh";
import type { GlyphMetricsProvider } from "./text2d-layout";
import {
  applyAssignMesh,
  createPlayMesh,
  createSnapshotSceneBinding,
} from "./snapshot-apply";

function fixedMetrics(): GlyphMetricsProvider {
  return {
    measureGlyph(_ch, style) {
      const world = style.size / 100;
      return {
        width: world * 0.5,
        height: world,
        bearingX: 0,
        bearingY: 0,
        advance: world * 0.5,
        source: "bitmap",
      };
    },
    measureImage(_guid, sizePx) {
      const height = sizePx / 100;
      return { width: height, height };
    },
  };
}

describe("createText2DMesh", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  it("samples a glyph atlas on bitmap letter quads instead of a solid fill", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const mesh = createText2DMesh(
      handle.scene,
      "letters",
      { text: "Hi", size: 32, color: [0, 1, 0] },
      undefined,
      { metrics: fixedMetrics() },
    );
    const children = mesh.getChildMeshes();
    expect(children.length).toBeGreaterThanOrEqual(2);
    for (const child of children) {
      const material = child.material as StandardMaterial;
      expect(
        material.opacityTexture ?? material.emissiveTexture ?? material.diffuseTexture,
      ).toBeTruthy();
      const uvs = child.getVerticesData("uv");
      expect(uvs?.length).toBe(8);
      expect(uvs?.[0]).not.toBe(uvs?.[2]);
    }
  });

  it("parents glyph quads under an AABB pick plane", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const mesh = createText2DMesh(
      handle.scene,
      "label",
      { text: "Hi", size: 32, hitTest: "block" },
      undefined,
      { metrics: fixedMetrics() },
    );
    expect(mesh).toBeInstanceOf(Mesh);
    expect((mesh.metadata as { text2d?: boolean }).text2d).toBe(true);
    expect(mesh.isPickable).toBe(true);
    const children = mesh.getChildMeshes();
    expect(children.length).toBeGreaterThanOrEqual(2);
    expect(children.every((child) => child.isPickable === false)).toBe(true);
    expect(
      children.every((child) => (child.metadata as { text2dGlyph?: boolean }).text2dGlyph),
    ).toBe(true);
    expect((mesh.material as StandardMaterial).disableLighting).toBe(true);
  });

  it("records the compiled CSS stack used to rasterize bitmap glyphs", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const mesh = createText2DMesh(
      handle.scene,
      "stacked",
      { text: "Hi", size: 32, fontAssetGuid: "font-1" },
      {
        fontCssStackByGuid: new Map([["font-1", '"Display", sans-serif']]),
      },
      { metrics: fixedMetrics() },
    );
    expect((mesh.metadata as { text2dFontStack?: string }).text2dFontStack).toBe(
      '"Display", sans-serif',
    );
  });

  it("uses an MSDF material branch when the pair exists and falls back per glyph", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const json = new TextEncoder().encode(
      JSON.stringify({
        info: { size: 32 },
        common: { scaleW: 64, scaleH: 64 },
        chars: [{ id: 65, x: 0, y: 0, width: 16, height: 16, xoffset: 0, yoffset: 0, xadvance: 16 }],
      }),
    );
    const mesh = createText2DMesh(
      handle.scene,
      "msdf",
      { text: "AB", renderer: "msdf", size: 32, fontAssetGuid: "font-1" },
      {
        fontMsdfJson: new Map([["font-1", json]]),
        fontMsdfPng: new Map([["font-1", new Uint8Array([1, 2, 3])]]),
      },
    );
    expect((mesh.metadata as { text2dRenderer?: string }).text2dRenderer).toBe("msdf");
    const sources = mesh
      .getChildMeshes()
      .map((child) => (child.metadata as { text2dSource?: string }).text2dSource);
    expect(sources).toContain("msdf");
    expect(sources).toContain("bitmap");
  });

  it("freezes letter effects while Play is paused", () => {
    const handle = createTestEngine();
    handles.push(handle);
    let paused = false;
    const mesh = createText2DMesh(
      handle.scene,
      "fx",
      { text: "[wave=2]Hi", size: 32 },
      undefined,
      { rich: true, metrics: fixedMetrics(), isPaused: () => paused },
    );
    const child = mesh.getChildMeshes()[0]!;
    const restY = child.position.y;
    const tick = (mesh.metadata as { tickText2DEffects?: (time: number) => void })
      .tickText2DEffects;
    tick?.(1);
    const liveY = child.position.y;
    expect(liveY).not.toBeCloseTo(restY);
    paused = true;
    tick?.(4);
    expect(child.position.y).toBeCloseTo(liveY);
  });
});

describe("2D text editor and Play wiring", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  it("builds editor visuals for 2DTextComponent", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const component = createText2DComponent("text-1");
    const actor = createActor("hud", "Label", { components: [component] });
    const mesh = createMeshForComponent(
      handle.scene,
      editorMeshName(actor.id),
      actor,
      component,
      { pixelsPerUnit: 100 },
    );
    expect((mesh.metadata as { text2d?: boolean }).text2d).toBe(true);
    expect(actorVisualFingerprint(actor)).toContain("2dtext");
  });

  it("builds Play overlay meshes for 2dtext and stamps HitTest on the pick plane only", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const binding = createSnapshotSceneBinding();
    binding.pixelsPerUnit = 100;
    applyAssignMesh(handle.scene, binding, {
      type: "assignMesh",
      slotId: 4,
      meshAssetGuid: null,
      meshKind: "2dtext",
      actorGuid: "banner",
      hitTest: "block",
      hasButton: true,
      text2d: {
        text: "Hi",
        fontAssetGuid: null,
        size: 32,
        color: [1, 1, 1],
        renderer: "bitmap",
        outline: 0,
        outlineColor: [0, 0, 0],
        alignment: "left",
        bold: false,
        italic: false,
        underline: false,
        wrapWidth: 0,
      },
    });
    const mesh = binding.meshes.get(4);
    expect(mesh?.isPickable).toBe(true);
    expect((mesh?.metadata as { overlayActorGuid?: string }).overlayActorGuid).toBe(
      "banner",
    );
    expect(mesh?.getChildMeshes().every((child) => child.isPickable === false)).toBe(
      true,
    );
    const play = createPlayMesh(handle.scene, 5, "2drichtext", null, binding);
    expect((play.metadata as { text2d?: boolean }).text2d).toBe(true);
    const withFont = createPlayMesh(handle.scene, 6, "2dtext", "font-1", binding);
    expect((withFont.metadata as { text2d?: boolean }).text2d).toBe(true);
  });
});
