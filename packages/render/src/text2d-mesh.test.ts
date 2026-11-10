import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SNAPSHOT_FLAG_VISIBLE } from "@haptic/bridge";
import {
  createActor,
  createRichText2DComponent,
  createText2DComponent,
} from "@haptic/core";
import { createTestEngine } from "./test-support/test-engine";
import { unlitBinding } from "./unlit-material-blocks";
import {
  actorVisualFingerprint,
  createMeshForComponent,
  editorMeshName,
} from "./scene-loader";
import { createText2DMesh, text2DMeshLayout, text2DRedraw, updateText2DAppear } from "./text2d-mesh";
import type { GlyphMetricsProvider } from "./text2d-layout";
import {
  applyAssignMesh,
  applySnapshotToScene,
  createPlayMesh,
  createSnapshotSceneBinding,
} from "./snapshot-apply";
import { isUnlitMaterial } from "./unlit-material";

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
    expect(children.length).toBeGreaterThanOrEqual(1);
    expect(
      (mesh.metadata as { text2dWrapWidth?: number }).text2dWrapWidth,
    ).toBeGreaterThan(0);
    for (const child of children) {
      expect(unlitBinding(child).texture).toBeTruthy();
      // Two letters share one batch: one atlas rectangle (4 vertices) per letter.
      const uvs = child.getVerticesData("uv");
      expect(uvs?.length).toBe(16);
      expect(uvs?.[0]).not.toBe(uvs?.[2]);
      expect(uvs?.[8]).not.toBe(uvs?.[10]);
    }
  });

  it("sizes the pick plane to wrapWidth/wrapHeight and lets glyphs overflow", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const mesh = createText2DMesh(
      handle.scene,
      "wrap",
      {
        text: "AAAA",
        size: 32,
        wrapWidth: 32,
        wrapHeight: 16,
      },
      { pixelsPerUnit: 100 },
      { metrics: fixedMetrics() },
    );
    mesh.refreshBoundingInfo(false, false);
    const size = mesh.getBoundingInfo().boundingBox.extendSize;
    expect(size.x * 2).toBeCloseTo(0.32);
    expect(size.y * 2).toBeCloseTo(0.16);
    expect((mesh.metadata as { text2dWrapWidth?: number }).text2dWrapWidth).toBe(32);
    expect((mesh.metadata as { text2dWrapHeight?: number }).text2dWrapHeight).toBe(16);
    // The drawn glyphs wrap onto two lines taller than the 0.16 pick plane.
    const glyphs = mesh.getChildMeshes().map((child) => child.getBoundingInfo().boundingBox);
    const top = Math.max(...glyphs.map((box) => box.maximum.y));
    const bottom = Math.min(...glyphs.map((box) => box.minimum.y));
    expect(top - bottom).toBeGreaterThan(0.16);
  });

  it("samples a glyph atlas for rich text color spans instead of a solid fill", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const mesh = createText2DMesh(
      handle.scene,
      "rich",
      { text: "[color=green]Hi", size: 32 },
      undefined,
      { rich: true, metrics: fixedMetrics() },
    );
    const children = mesh.getChildMeshes();
    // Both letters are static and share the atlas material, so they are one batch.
    expect(children.length).toBe(1);
    expect(children[0]!.getTotalVertices()).toBe(8);
    expect((mesh.metadata as { text2dRich?: boolean }).text2dRich).toBe(true);
    for (const child of children) {
      expect(unlitBinding(child).texture).toBeTruthy();
      // Cut out (Standard's alpha test).
      expect(child.material!.needAlphaTestingForMesh(child)).toBe(true);
      const uvs = child.getVerticesData("uv");
      expect(uvs?.[0]).not.toBe(uvs?.[2]);
    }
  });

  it("sizes letter quads to the 5x7 cell when canvas paint is a solid glyph box", () => {
    const previous = (globalThis as { document?: unknown }).document;
    (globalThis as { document: unknown }).document = {
      createElement: () => ({
        width: 1,
        height: 1,
        getContext() {
          return {
            font: "",
            textBaseline: "top",
            textAlign: "left",
            fillStyle: "",
            strokeStyle: "",
            lineJoin: "",
            miterLimit: 0,
            lineWidth: 0,
            measureText: () => ({
              width: 40,
              actualBoundingBoxAscent: 32,
              actualBoundingBoxDescent: 8,
            }),
            clearRect() {},
            fillText() {},
            strokeText() {},
            getImageData: (_x: number, _y: number, w: number, h: number) => {
              const data = new Uint8ClampedArray(w * h * 4);
              const inset = 2;
              for (let y = inset; y < h - inset; y++) {
                for (let x = inset; x < w - inset; x++) {
                  const i = (y * w + x) * 4;
                  data[i] = 255;
                  data[i + 1] = 255;
                  data[i + 2] = 255;
                  data[i + 3] = 255;
                }
              }
              return { data };
            },
          };
        },
      }),
    };
    try {
      const handle = createTestEngine();
      handles.push(handle);
      const mesh = createText2DMesh(
        handle.scene,
        "solid-box",
        { text: "A", size: 32 },
        { pixelsPerUnit: 100 },
      );
      const child = mesh.getChildMeshes()[0]!;
      child.refreshBoundingInfo(false, false);
      const size = child.getBoundingInfo().boundingBox.extendSize;
      expect((size.x * 2) / (size.y * 2)).toBeCloseTo((5 * 5 + 2) / (7 * 5 + 2), 2);
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(globalThis, "document");
      } else {
        (globalThis as { document: unknown }).document = previous;
      }
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
    expect(children.length).toBeGreaterThanOrEqual(1);
    expect(children.every((child) => child.isPickable === false)).toBe(true);
    expect(
      children.every((child) => (child.metadata as { text2dGlyph?: boolean }).text2dGlyph),
    ).toBe(true);
    expect(isUnlitMaterial(mesh.material)).toBe(true);
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
    const assets = {
      fontMsdfJson: new Map([["font-1", json]]),
      fontMsdfPng: new Map([["font-1", new Uint8Array([1, 2, 3])]]),
    };
    const mesh = createText2DMesh(
      handle.scene,
      "msdf",
      { text: "AAB", renderer: "msdf", size: 32, fontAssetGuid: "font-1" },
      assets,
    );
    expect((mesh.metadata as { text2dRenderer?: string }).text2dRenderer).toBe("msdf");
    const sourceOf = (child: { metadata: unknown }) =>
      (child.metadata as { text2dSource?: string }).text2dSource;
    const sources = mesh.getChildMeshes().map(sourceOf);
    expect(sources).toContain("msdf");
    expect(sources).toContain("bitmap");
    // Same-style MSDF glyphs share one binding and one batch mesh; another color gets its own.
    const msdfGlyphs = mesh.getChildMeshes().filter((child) => sourceOf(child) === "msdf");
    expect(msdfGlyphs).toHaveLength(1);
    expect(msdfGlyphs[0]!.getTotalVertices()).toBe(2 * 4);
    const rich = createText2DMesh(
      handle.scene,
      "msdf-rich",
      { text: "[color=FF0000]A[/color]A", renderer: "msdf", size: 32, fontAssetGuid: "font-1", color: [0, 1, 0] },
      assets,
      { rich: true },
    );
    // Without its atlas (no resource cache) each style draws its solid colour.
    const [red, green] = rich.getChildMeshes().map((child) => unlitBinding(child));
    expect(red).not.toBe(green);
    expect(red!.color).toEqual([1, 0, 0]);
    expect(green!.color).toEqual([0, 1, 0]);
  });

  it.each([
    { mode: "Off", appearModes: [], progress: 1 },
    { mode: "combined reveal", appearModes: ["fade", "scale", "slide"], progress: 0.5 },
  ])("keeps static glyph world matrices cached during $mode effect frames", ({ appearModes, progress }) => {
    const handle = createTestEngine();
    handles.push(handle);
    const mesh = createText2DMesh(
      handle.scene,
      "mixed-effects",
      {
        text: "AB[wave=2]C[/wave]",
        size: 32,
        appearModes,
        appearInterval: 0,
        appearDuration: 1,
        appearProgress: progress,
      },
      undefined,
      { rich: true, metrics: fixedMetrics() },
    );
    // The wave letter C is last in either structure: A and B are one static
    // batch when no reveal mode is set, and a plane each otherwise.
    const children = mesh.getChildMeshes();
    const tick = (mesh.metadata as { tickText2DEffects: (time: number) => void }).tickText2DEffects;
    tick(0.25);
    const matrixVersions = children.map((child) => child.computeWorldMatrix().updateFlag);
    const effect = children.length - 1;
    const effectY = children[effect]!.position.y;

    tick(0.5);
    updateText2DAppear(mesh, progress);
    handle.scene.incrementRenderId();
    expect(children.slice(0, effect).map((child) => child.computeWorldMatrix().updateFlag))
      .toEqual(matrixVersions.slice(0, effect));
    expect(children[effect]!.position.y).not.toBeCloseTo(effectY);
    expect(children[effect]!.computeWorldMatrix().updateFlag).not.toBe(matrixVersions[effect]);
  });

  it("keeps completed glyph world matrices cached as later characters reveal", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const mesh = createText2DMesh(
      handle.scene,
      "staggered-reveal",
      {
        text: "ABC",
        appearModes: ["fade", "scale", "slide"],
        appearTransition: "linear",
        appearInterval: 0.1,
        appearDuration: 0.2,
      },
      undefined,
      { rich: true, metrics: fixedMetrics() },
    );
    const [first, second] = mesh.getChildMeshes();
    updateText2DAppear(mesh, 0.5);
    const firstVersion = first!.computeWorldMatrix().updateFlag;
    const secondVersion = second!.computeWorldMatrix().updateFlag;
    expect(second!.scaling.x).toBeCloseTo(0.5);

    updateText2DAppear(mesh, 0.75);
    handle.scene.incrementRenderId();
    expect(first!.computeWorldMatrix().updateFlag).toBe(firstVersion);
    expect(second!.scaling.x).toBe(1);
    expect(second!.computeWorldMatrix().updateFlag).not.toBe(secondVersion);
  });

  it("preserves paused letter effects while the reveal pose changes", () => {
    const handle = createTestEngine();
    handles.push(handle);
    let paused = false;
    const mesh = createText2DMesh(
      handle.scene,
      "fx",
      {
        text: "[shake=1][wave=2]Hi",
        size: 32,
        appearModes: ["scale", "slide"],
        appearTransition: "cubicOut",
        appearInterval: 0,
        appearDuration: 1,
      },
      undefined,
      { rich: true, metrics: fixedMetrics(), isPaused: () => paused },
    );
    const child = mesh.getChildMeshes()[0]!;
    const restY = child.position.y;
    const tick = (mesh.metadata as { tickText2DEffects?: (time: number) => void })
      .tickText2DEffects;
    tick?.(1);
    const liveX = child.position.x;
    const liveY = child.position.y;
    expect(liveY).not.toBeCloseTo(restY);
    paused = true;
    updateText2DAppear(mesh, 0.5);
    // Cubic Out is 0.875 here; slide adds the remaining 0.125 of a 0.32-unit glyph.
    expect(child.scaling.x).toBeCloseTo(0.875);
    expect(child.position.x).toBeCloseTo(liveX);
    expect(child.position.y).toBeCloseTo(liveY - 0.04);
    tick?.(4);
    expect(child.position.x).toBeCloseTo(liveX);
    expect(child.position.y).toBeCloseTo(liveY - 0.04);
    updateText2DAppear(mesh, 1);
    expect(child.position.y).toBeCloseTo(liveY);
  });
});

/**
 * The texels each quad of a glyph batch samples, read from its atlas texture as the GPU holds it: the quad's atlas
 * rectangle and the pixel around it, which bilinear filtering blends in at the quad's edges.
 */
function sampledTexels(batch: Mesh): number[][] {
  const texture = unlitBinding(batch).texture;
  const pixels = (texture?.getInternalTexture() as { _bufferView?: ArrayLike<number> } | null | undefined)?._bufferView;
  const uvs = batch.getVerticesData("uv");
  if (!texture || !pixels || !uvs) return [];
  const { width, height } = texture.getSize();
  const quads: number[][] = [];
  for (let quad = 0; quad < uvs.length; quad += 8) {
    const left = Math.round(uvs[quad]! * width) - 1, right = Math.round(uvs[quad + 2]! * width) + 1;
    const top = Math.round((1 - uvs[quad + 5]!) * height) - 1, bottom = Math.round((1 - uvs[quad + 1]!) * height) + 1;
    const texels: number[] = [right - left, bottom - top];
    for (let y = top; y < bottom; y++) {
      for (let x = left * 4; x < right * 4; x++) texels.push(pixels[y * width * 4 + x]!);
    }
    quads.push(texels);
  }
  return quads;
}

/** What a text draws and reports: its pick plane, each batch's quads and the texels they sample, its layout and its sizes. */
function drawnText(root: Mesh) {
  const vertices = (mesh: Mesh, kind: string) => Array.from(mesh.getVerticesData(kind) ?? []);
  const bounds = (mesh: Mesh) => {
    // As a frame does before it draws; a frozen world matrix stays as it is.
    mesh.computeWorldMatrix(true);
    const box = mesh.getBoundingInfo().boundingBox;
    return [box.minimumWorld.asArray(), box.maximumWorld.asArray()];
  };
  const metadata = root.metadata as Record<string, unknown>;
  return {
    plane: vertices(root, "position"),
    planeBounds: bounds(root),
    layoutWidth: metadata.text2dLayoutWidth,
    wrapWidth: metadata.text2dWrapWidth,
    wrapHeight: metadata.text2dWrapHeight,
    layout: text2DMeshLayout(root)?.items.map((item) => [item.ch, item.x, item.y, item.width, item.height]),
    batches: (root.getChildMeshes() as Mesh[]).map((mesh) => ({
      name: mesh.name,
      id: mesh.id,
      positions: vertices(mesh, "position"),
      normals: vertices(mesh, "normal"),
      indices: Array.from(mesh.getIndices() ?? []),
      bounds: bounds(mesh),
      texels: sampledTexels(mesh),
    })),
  };
}

/** The atlas page a text's first batch samples. */
const atlasPage = (root: Mesh) => unlitBinding(root.getChildMeshes()[0]!).texture!;

/** The Scene's glyph atlas pages. */
const atlasPages = (host: { textures: Array<{ name: string }> }) => host.textures.filter((texture) => texture.name.startsWith("text2d-glyph-atlas:"));

/** `count` characters no other test text draws, each a glyph of its own, from `first` on. */
const distinctGlyphs = (count: number, first = 0) => Array.from({ length: count }, (_, index) => String.fromCodePoint(0x4e00 + first + index)).join("");

describe("text2DRedraw", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> = [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  function scene() {
    const handle = createTestEngine();
    handles.push(handle);
    return handle.scene;
  }

  it.each([
    { title: "other characters", from: { text: "SCORE 10" }, to: { text: "SCORE 25" } },
    { title: "more characters", from: { text: "HP 9" }, to: { text: "HP 9999" } },
    { title: "fewer characters", from: { text: "LEVEL 12" }, to: { text: "L 1" } },
    { title: "characters it has not drawn", from: { text: "TIME 12:34" }, to: { text: "LAP 5/6" } },
    { title: "another line", from: { text: "ONE" }, to: { text: "ONE\nNONE" } },
    { title: "another colour", from: { text: "HI", color: [1, 0, 0] }, to: { text: "HI", color: [0, 1, 0] } },
    { title: "another wrap box", from: { text: "AB AB", wrapWidth: 400, wrapHeight: 200 }, to: { text: "AB AB", wrapWidth: 40, wrapHeight: 90 } },
    { title: "leading spaces", from: { text: "GO" }, to: { text: "  GO" } },
    { title: "many more characters than it drew", from: { text: "A" }, to: { text: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" } },
  ])("draws $title as a new text would, with the meshes and atlas it has", ({ from, to }) => {
    const host = scene();
    const text = createText2DMesh(host, "label", { size: 32, ...from });
    const parts = [text, ...text.getChildMeshes()];
    const atlases = parts.slice(1).map((mesh) => unlitBinding(mesh).texture);
    const materials = parts.map((mesh) => mesh.material);
    // What a Scene readiness probe watches: nothing may join, leave or change material.
    let sceneChanges = 0;
    for (const observable of [host.onNewMeshAddedObservable, host.onMeshRemovedObservable, host.onNewTextureAddedObservable,
      host.onTextureRemovedObservable, host.onNewMaterialAddedObservable, host.onMaterialRemovedObservable]) {
      (observable as { add(callback: () => void): unknown }).add(() => { sceneChanges += 1; });
    }
    for (const mesh of parts) mesh.onMaterialChangedObservable.add(() => { sceneChanges += 1; });

    const redraw = text2DRedraw(text, { size: 32, ...to });
    expect(redraw).not.toBeNull();
    redraw!.apply();

    expect([text, ...text.getChildMeshes()]).toEqual(parts);
    expect(text.getChildMeshes().map((mesh) => unlitBinding(mesh).texture)).toEqual(atlases);
    expect(parts.map((mesh) => mesh.material)).toEqual(materials);
    expect(sceneChanges).toBe(0);
    const fresh = createText2DMesh(scene(), "label", { size: 32, ...to });
    const drawn = drawnText(text);
    expect(drawn).toEqual(drawnText(fresh));
    // The comparison is not between two empty texts.
    const glyphs = to.text.replace(/\s/g, "").length;
    expect(drawn.batches).toHaveLength(1);
    expect(drawn.batches[0]!.positions).toHaveLength(glyphs * 12);
    expect(drawn.batches[0]!.texels).toHaveLength(glyphs);
    expect(drawn.batches[0]!.texels.every((texels) => texels.slice(2).some((value) => value > 0))).toBe(true);
  });

  it("reports the bytes of the glyphs it holds", () => {
    const bytes = (root: Mesh) => (root.metadata as { text2dBitmapBytes?: number }).text2dBitmapBytes;
    // At size 32 a glyph of the bundled face is 27 x 37 texels, held on the CPU and the GPU.
    const text = createText2DMesh(scene(), "label", { text: "L 1", size: 32 });
    expect(bytes(text)).toBe(2 * 27 * 37 * 8);
    text2DRedraw(text, { text: "LEVEL 12", size: 32 })!.apply();
    expect(bytes(text)).toBe(5 * 27 * 37 * 8);
  });

  it("samples another atlas page when its new glyphs find no room on the one it drew from", () => {
    const host = scene();
    const text = createText2DMesh(host, "label", { text: "AB", size: 32 });
    // A page holds 234 glyphs of this size: with these 232 the first is full, and every glyph on it is held.
    createText2DMesh(host, "filler", { text: distinctGlyphs(232), size: 32 });
    const batch = text.getChildMeshes()[0] as Mesh;
    const first = atlasPage(text);
    expect(atlasPages(host)).toHaveLength(1);

    text2DRedraw(text, { text: "CD", size: 32 })!.apply();

    expect(text.getChildMeshes()).toEqual([batch]);
    expect(atlasPages(host)).toHaveLength(2);
    expect(atlasPage(text)).not.toBe(first);
    expect(drawnText(text).batches[0]!.texels).toEqual(drawnText(createText2DMesh(scene(), "label", { text: "CD", size: 32 })).batches[0]!.texels);
  });

  it("redraws MSDF glyphs from the Font's atlas, and leaves a text whose batches change to a rebuild", () => {
    const glyph = (id: number, x: number) => ({ id, x, y: 0, width: 16, height: 16, xoffset: 0, yoffset: 0, xadvance: 16 });
    const assets = {
      fontMsdfJson: new Map([["font-1", new TextEncoder().encode(JSON.stringify({
        info: { size: 32 }, common: { scaleW: 64, scaleH: 64 }, chars: [glyph(65, 0), glyph(66, 16)],
      }))]]),
      fontMsdfPng: new Map([["font-1", new Uint8Array([1, 2, 3])]]),
    };
    const msdf = (text: string, color: [number, number, number] = [1, 1, 1]) => ({ text, color, renderer: "msdf", size: 32, fontAssetGuid: "font-1" });
    const text = createText2DMesh(scene(), "label", msdf("AB"), assets);
    const batches = text.getChildMeshes();

    text2DRedraw(text, msdf("BBA"), assets)!.apply();

    expect(text.getChildMeshes()).toEqual(batches);
    // A is the atlas's first 16 texels of 64 and B the next, both in its top row.
    const a = [0, 0.75, 0.25, 0.75, 0.25, 1, 0, 1], b = [0.25, 0.75, 0.5, 0.75, 0.5, 1, 0.25, 1];
    expect(Array.from((batches[0] as Mesh).getVerticesData("uv") ?? [])).toEqual([...b, ...b, ...a]);
    expect(drawnText(text)).toEqual(drawnText(createText2DMesh(scene(), "label", msdf("BBA"), assets)));
    // C is not in the Font's atlas: it would draw from a bitmap atlas, in a batch the text does not have.
    expect(text2DRedraw(text, msdf("ABC"), assets)).toBeNull();
    // Another colour is another MSDF binding.
    expect(text2DRedraw(text, msdf("AB", [1, 0, 0]), assets)).toBeNull();
  });

  it("keeps the pick plane and glyphs at the text's place in the world when its world matrix is frozen", () => {
    const text = createText2DMesh(scene(), "label", { text: "A", size: 32 }, undefined, { metrics: fixedMetrics() });
    text.position.set(3, 2, 0);
    // Play freezes a slot's root at the pose of its last snapshot, and a frame has culled the text there since.
    text.freezeWorldMatrix();
    text.getBoundingInfo();
    text2DRedraw(text, { text: "AAAA", size: 32 }, undefined, { metrics: fixedMetrics() })!.apply();
    // Four glyphs of 0.16 by 0.32 world units, centred on the text.
    const plane = text.getBoundingInfo().boundingBox;
    expect(plane.minimumWorld.asArray()).toEqual([expect.closeTo(2.68, 5), expect.closeTo(1.84, 5), 0]);
    expect(plane.maximumWorld.asArray()).toEqual([expect.closeTo(3.32, 5), expect.closeTo(2.16, 5), 0]);
    // Left-aligned glyphs start at the text's origin.
    const glyphs = text.getChildMeshes()[0]!.getBoundingInfo().boundingBox;
    expect(glyphs.minimumWorld.asArray()).toEqual([expect.closeTo(3, 5), expect.closeTo(1.84, 5), 0]);
    expect(glyphs.maximumWorld.asArray()).toEqual([expect.closeTo(3.64, 5), expect.closeTo(2.16, 5), 0]);
  });

  it("re-poses the glyphs it draws now when an overlay box counter-scales them", () => {
    const text = createText2DMesh(scene(), "label", { text: "AB", size: 32 }, undefined, { metrics: fixedMetrics() });
    text2DRedraw(text, { text: "ABAB", size: 32 }, undefined, { metrics: fixedMetrics() })!.apply();
    const batch = text.getChildMeshes()[0] as Mesh;
    (batch.metadata as { text2dCounterScale(x: number, y: number): void }).text2dCounterScale(0.5, 1);
    const positions = Array.from(batch.getVerticesData("position") ?? []);
    expect(positions).toHaveLength(48);
    // The last of four 0.16-wide glyphs is centred at 0.56 and drawn at half its width.
    expect(positions.slice(36, 39)).toEqual([expect.closeTo(0.52, 5), expect.closeTo(-0.16, 5), 0]);
    expect(positions.slice(39, 42)).toEqual([expect.closeTo(0.6, 5), expect.closeTo(-0.16, 5), 0]);
  });

  it.each([
    { title: "Rich Text", from: { text: "HI" }, to: { text: "HO" }, options: { rich: true } },
    { title: "a text gaining a Text Material", from: { text: "HI" }, to: { text: "HO", materialGuid: "material-1" } },
    { title: "a text drawn with a Text Material", from: { text: "HI", materialGuid: "material-1" }, to: { text: "HO", materialGuid: "material-1" } },
    { title: "a text gaining an underline", from: { text: "HI" }, to: { text: "HO", underline: true } },
    { title: "an underlined text", from: { text: "HI", underline: true }, to: { text: "HO", underline: true } },
    { title: "a text in another font", from: { text: "HI" }, to: { text: "HO", fontAssetGuid: "font-1" } },
    { title: "a text that had no glyphs", from: { text: "" }, to: { text: "HO" } },
    { title: "a text left without glyphs", from: { text: "HI" }, to: { text: "" } },
  ])("leaves $title to a rebuild, untouched", ({ from, to, options }) => {
    const text = createText2DMesh(scene(), "label", { size: 32, ...from }, undefined, options);
    const before = drawnText(text);
    expect(text2DRedraw(text, { size: 32, ...to }, undefined, options)).toBeNull();
    expect(drawnText(text)).toEqual(before);
  });

  it("turns a text down before rasterizing its glyphs, so its rebuild rasterizes them once", () => {
    // A canvas that measures every glyph alike and counts the glyphs it is asked to paint and read back.
    let rasterized = 0;
    const previous = (globalThis as { document?: unknown }).document;
    (globalThis as { document: unknown }).document = {
      createElement: () => ({
        width: 1,
        height: 1,
        getContext: () => ({
          font: "", textBaseline: "top", textAlign: "left", fillStyle: "", strokeStyle: "", lineJoin: "", miterLimit: 0, lineWidth: 0,
          measureText: () => ({ width: 20, actualBoundingBoxAscent: 16, actualBoundingBoxDescent: 4 }),
          clearRect() {},
          fillText() {},
          strokeText() {},
          getImageData: (_x: number, _y: number, width: number, height: number) => {
            rasterized += 1;
            return { data: new Uint8ClampedArray(width * height * 4).fill(255) };
          },
        }),
      }),
    };
    try {
      const text = createText2DMesh(scene(), "label", { text: "AB", size: 16 });
      rasterized = 0;
      // An underline is a plane of its own, which the text does not have.
      expect(text2DRedraw(text, { text: "CDEFGH", size: 16, underline: true })).toBeNull();
      expect(rasterized).toBe(0);
      // Two glyphs it has not drawn are rasterized for a redraw.
      const redraw = text2DRedraw(text, { text: "DC", size: 16 });
      expect(redraw).not.toBeNull();
      expect(rasterized).toBe(2);
      redraw!.discard();
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, "document");
      else (globalThis as { document: unknown }).document = previous;
    }
  });

  it("refuses a text the bitmap limits refuse, as a build does", () => {
    const host = scene();
    const text = createText2DMesh(host, "label", { text: "HI", size: 32 });
    const limits = { bitmapLimits: { maxWorkingBytes: 64 } };
    expect(() => createText2DMesh(host, "other", { text: "HO", size: 32 }, undefined, limits)).toThrow(/working-set budget/);
    expect(() => text2DRedraw(text, { text: "HO", size: 32 }, undefined, limits)).toThrow(/working-set budget/);
  });
});

describe("2D Texts in one Scene", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  function scene() {
    const handle = createTestEngine();
    handles.push(handle);
    return handle.scene;
  }
  const label = (host: ReturnType<typeof scene>, text: string, size = 32) => createText2DMesh(host, "label", { text, size });
  /** The texels each glyph of a text samples, as a text alone in its Scene draws them. */
  const alone = (text: string, size = 32) => drawnText(label(scene(), text, size)).batches.map((batch) => batch.texels);
  const texels = (root: Mesh) => drawnText(root).batches.map((batch) => batch.texels);

  it("sample one atlas texture, each its own glyphs", () => {
    const host = scene();
    const score = label(host, "SCORE 10");
    const lives = label(host, "LIVES 3");
    expect(atlasPages(host)).toHaveLength(1);
    expect(atlasPage(lives)).toBe(atlasPage(score));
    // Texts that bind the same values can share a draw.
    expect(unlitBinding(lives.getChildMeshes()[0]!)).toEqual(unlitBinding(score.getChildMeshes()[0]!));
    expect(texels(score)).toEqual(alone("SCORE 10"));
    expect(texels(lives)).toEqual(alone("LIVES 3"));
  });

  it("keep a glyph one of them still draws when the other is disposed or redrawn", () => {
    const host = scene();
    const first = label(host, "AB");
    const second = label(host, "BC");
    const third = label(host, "CA");
    first.dispose();
    text2DRedraw(third, { text: "XY", size: 32 })!.apply();
    // Glyphs that fill what is left of the page: nothing the second text draws may give its room up.
    label(host, distinctGlyphs(230));
    expect(texels(second)).toEqual(alone("BC"));
    expect(texels(third)).toEqual(alone("XY"));
  });

  it.each([
    { title: "a redraw replaced", settle: (redraw: { apply(): void; discard(): void }) => redraw.apply(), drawn: "CD" },
    { title: "an abandoned redraw asked for", settle: (redraw: { apply(): void; discard(): void }) => redraw.discard(), drawn: "AB" },
  ])("let go of the glyphs $title", ({ settle, drawn }) => {
    const host = scene();
    const text = label(host, "AB");
    settle(text2DRedraw(text, { text: "CD", size: 32 })!);
    // A page holds 234 glyphs: these 232 fit beside the two the text draws only in the room of the two it does not.
    label(host, distinctGlyphs(232));
    expect(atlasPages(host)).toHaveLength(1);
    expect(texels(text)).toEqual(alone(drawn));
  });

  it("take the room of glyphs no text draws any more before opening another page", () => {
    const host = scene();
    // 234 glyphs of this size fill a page.
    const filler = label(host, distinctGlyphs(234));
    filler.dispose();
    const next = label(host, distinctGlyphs(234, 1000));
    expect(atlasPages(host)).toHaveLength(1);
    expect(texels(next)).toEqual(alone(distinctGlyphs(234, 1000)));
  });

  it("open another page while every glyph on the first is drawn, and draw a text from each page it has glyphs on", () => {
    const host = scene();
    const held = label(host, distinctGlyphs(200));
    // 34 of these fit the first page; the other 66 need a second.
    const spanning = label(host, distinctGlyphs(100, 1000));
    expect(atlasPages(host)).toHaveLength(2);
    expect(spanning.getChildMeshes().map((batch) => unlitBinding(batch).texture)).toEqual(atlasPages(host));
    expect((spanning.getChildMeshes() as Mesh[]).map((batch) => batch.getTotalVertices() / 4)).toEqual([34, 66]);
    expect(texels(held)).toEqual(alone(distinctGlyphs(200)));
    expect(texels(spanning).flat()).toEqual(alone(distinctGlyphs(100, 1000)).flat());
  });

  it("give a glyph larger than a page a page of its own size", () => {
    const sized = () => { const host = scene(); host.getEngine().getCaps().maxTextureSize = 2048; return host; };
    // At size 700 a glyph of the bundled face is 502 x 702 texels.
    const large = label(sized(), "A", 700);
    expect(atlasPage(large).getSize()).toEqual({ width: 512, height: 1024 });
    expect(texels(large)).toEqual(drawnText(label(sized(), "A", 700)).batches.map((batch) => batch.texels));
    expect(texels(large)[0]![0]!.slice(0, 2)).toEqual([504, 704]);
  });

  it("draw a glyph anew once a font face has loaded, while a text built before keeps the glyph it drew", () => {
    // A canvas whose glyphs are one stroke, at the column `stroke` names: another column stands for another font.
    let stroke = 3;
    const fontsLoaded: Array<() => void> = [];
    const previous = (globalThis as { document?: unknown }).document;
    (globalThis as { document: unknown }).document = {
      fonts: { addEventListener: (_type: string, listener: () => void) => { fontsLoaded.push(listener); } },
      createElement: () => ({
        width: 1,
        height: 1,
        getContext: () => ({
          font: "", textBaseline: "top", textAlign: "left", fillStyle: "", strokeStyle: "", lineJoin: "", miterLimit: 0, lineWidth: 0,
          measureText: () => ({ width: 16, actualBoundingBoxAscent: 16, actualBoundingBoxDescent: 4 }),
          clearRect() {},
          fillText() {},
          strokeText() {},
          getImageData: (_x: number, _y: number, width: number, height: number) => {
            const data = new Uint8ClampedArray(width * height * 4);
            for (let y = 6; y < 18; y++) data[(y * width + stroke) * 4 + 3] = 255;
            return { data };
          },
        }),
      }),
    };
    try {
      const host = scene();
      /** The columns of a text's first glyph that hold ink, within its cell. */
      const inked = (root: Mesh) => {
        const [width, , ...texels] = drawnText(root).batches[0]!.texels[0]!;
        const columns = new Set<number>();
        for (let index = 3; index < texels.length; index += 4) if (texels[index]! > 0) columns.add((index >> 2) % width! - 1);
        return [...columns];
      };
      const before = label(host, "A");
      expect(inked(before)).toEqual([3]);
      stroke = 9;
      for (const listener of fontsLoaded) listener();
      const after = label(host, "A");
      expect(inked(after)).toEqual([9]);
      expect(inked(before)).toEqual([3]);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, "document");
      else (globalThis as { document: unknown }).document = previous;
    }
  });

  it("upload a page once a frame, and only when a text added glyphs to it", () => {
    const host = scene();
    const first = label(host, "AB");
    const upload = vi.spyOn(atlasPage(first) as unknown as { update(data: ArrayBufferView): void }, "update");
    const frame = () => { host.onBeforeRenderObservable.notifyObservers(host); return upload.mock.calls.length; };
    expect(frame()).toBe(1);
    label(host, "CD");
    label(host, "EF");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(frame()).toBe(2);
    expect(frame()).toBe(2);
    // Every glyph of this text is on the page already.
    label(host, "FACE");
    expect(frame()).toBe(2);
  });

  it("upload a page before the frame's other before-render work, which may draw the Scene", () => {
    const host = scene();
    const uploads: { count: () => number } = { count: () => 0 };
    let uploadedBefore = -1;
    // Registered before the Scene has a text, as a render target capture's draw is.
    host.onBeforeRenderObservable.add(() => { uploadedBefore = uploads.count(); });
    const upload = vi.spyOn(atlasPage(label(host, "AB")) as unknown as { update(data: ArrayBufferView): void }, "update");
    uploads.count = () => upload.mock.calls.length;
    host.onBeforeRenderObservable.notifyObservers(host);
    expect(uploadedBefore).toBe(1);
  });
});

describe("a Play 2D text a command rewrites", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  function play() {
    const handle = createTestEngine();
    handles.push(handle);
    const binding = createSnapshotSceneBinding();
    binding.pixelsPerUnit = 100;
    return { scene: handle.scene, binding };
  }

  /** A 2D Text's properties as the runtime sends them. */
  const says = (text: string, size = 32) => ({
    text,
    fontAssetGuid: null,
    size,
    color: [1, 1, 1] as [number, number, number],
    renderer: "bitmap" as const,
    outline: 0,
    outlineColor: [0, 0, 0] as [number, number, number],
    alignment: "left" as const,
    verticalAlignment: "center" as const,
    bold: false,
    italic: false,
    underline: false,
    wrapWidth: 0,
    wrapHeight: 0,
  });
  type Label = { meshKind?: string; actorGuid?: string; hitTest?: "block" | "ignore" };
  /** A Scene Layer actor that is one 2D Text. */
  const label = (text2d: ReturnType<typeof says>, { meshKind = "2dtext", actorGuid = "score", hitTest = "block" }: Label = {}) => ({
    type: "assignMesh" as const, slotId: 4, meshAssetGuid: null, meshKind, actorGuid, hitTest, text2d,
  });
  const reads = (root: Mesh) => text2DMeshLayout(root)?.items.map((item) => item.ch).join("");
  const stamps = (root: Mesh) => ({
    pickable: root.isPickable,
    actor: (root.metadata as { overlayActorGuid?: string }).overlayActorGuid,
    rich: (root.metadata as { text2dRich?: boolean }).text2dRich,
    glyphsPickable: root.getChildMeshes().some((glyph) => glyph.isPickable),
  });
  /** The geometry buffer a text's glyphs draw from: replaced whenever the text is redrawn. */
  const glyphBuffer = (root: Mesh) => (root.getChildMeshes()[0] as Mesh).getVertexBuffer("position");

  it("redraws the text with the visual the slot shows when only what it says changes", () => {
    const { scene, binding } = play();
    applyAssignMesh(scene, binding, label(says("SCORE 10")));
    const root = binding.meshes.get(4)!;
    const glyphs = root.getChildMeshes();

    applyAssignMesh(scene, binding, label(says("SCORE 25")));

    expect(binding.meshes.get(4)).toBe(root);
    expect(root.getChildMeshes()).toEqual(glyphs);
    expect(reads(root)).toBe("SCORE 25");
    const built = play();
    applyAssignMesh(built.scene, built.binding, label(says("SCORE 25")));
    expect(drawnText(root)).toEqual(drawnText(built.binding.meshes.get(4)!));
    expect(stamps(root)).toEqual({ pickable: true, actor: "score", rich: false, glyphsPickable: false });
    expect(binding.text2dProps.get(4)?.text).toBe("SCORE 25");
  });

  it("redraws a spawned label whose Begin Play writes a longer text, with glyphs it had not drawn", () => {
    const { scene, binding } = play();
    applyAssignMesh(scene, binding, label(says("Card A")));
    const root = binding.meshes.get(4)!;
    const glyphs = root.getChildMeshes();
    applyAssignMesh(scene, binding, label(says("Card A (slot 0)")));
    expect(binding.meshes.get(4)).toBe(root);
    expect(root.getChildMeshes()).toEqual(glyphs);
    expect(reads(root)).toBe("Card A (slot 0)");
    const built = play();
    applyAssignMesh(built.scene, built.binding, label(says("Card A (slot 0)")));
    expect(drawnText(root)).toEqual(drawnText(built.binding.meshes.get(4)!));
  });

  it("keeps the redrawn text for a repeated command, and redraws it for the next", () => {
    const { scene, binding } = play();
    applyAssignMesh(scene, binding, label(says("LAP 1")));
    const root = binding.meshes.get(4)!;
    applyAssignMesh(scene, binding, label(says("LAP 2")));
    const drawn = glyphBuffer(root);
    // A script writes the same text every tick.
    applyAssignMesh(scene, binding, label(says("LAP 2")));
    expect(glyphBuffer(root)).toBe(drawn);
    applyAssignMesh(scene, binding, label(says("LAP 3")));
    expect(binding.meshes.get(4)).toBe(root);
    expect(reads(root)).toBe("LAP 3");
  });

  it("keeps a hidden text hidden through a redraw", () => {
    const { scene, binding } = play();
    applyAssignMesh(scene, binding, label(says("HI")));
    const snapshot = (flags: number) => ({
      frameId: 1, tickIndex: 1, actorCount: 1,
      actors: [{ slotId: 4, flags, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } }],
    });
    applySnapshotToScene(scene, binding, snapshot(0));
    applyAssignMesh(scene, binding, label(says("HO")));
    const glyphs = binding.meshes.get(4)!.getChildMeshes();
    expect(glyphs.length).toBeGreaterThan(0);
    expect(glyphs.filter((glyph) => glyph.isVisible)).toEqual([]);
    applySnapshotToScene(scene, binding, snapshot(SNAPSHOT_FLAG_VISIBLE));
    expect(glyphs.filter((glyph) => glyph.isVisible)).toEqual(glyphs);
  });

  it.each([
    { title: "its size", next: label(says("HO", 48)), stamped: { pickable: true, actor: "score", rich: false, glyphsPickable: false } },
    { title: "its hit test", next: label(says("HO"), { hitTest: "ignore" }), stamped: { pickable: false, actor: "score", rich: false, glyphsPickable: false } },
    { title: "its actor", next: label(says("HO"), { actorGuid: "lives" }), stamped: { pickable: true, actor: "lives", rich: false, glyphsPickable: false } },
    { title: "its kind to Rich Text", next: label(says("HO"), { meshKind: "2drichtext" }), stamped: { pickable: true, actor: "score", rich: true, glyphsPickable: false } },
  ])("builds what the command asks when it also changes $title", ({ next, stamped }) => {
    const { scene, binding } = play();
    applyAssignMesh(scene, binding, label(says("HI")));
    applyAssignMesh(scene, binding, next);
    const root = binding.meshes.get(4)!;
    expect(reads(root)).toBe("HO");
    expect(stamps(root)).toEqual(stamped);
    const built = play();
    applyAssignMesh(built.scene, built.binding, next);
    expect(drawnText(root)).toEqual(drawnText(built.binding.meshes.get(4)!));
  });

  it("redraws one text of an actor that draws several, and leaves the others as they are", () => {
    const part = (componentId: string, y: number, text: string) => ({
      componentId, meshKind: "2dtext", meshAssetGuid: null, parentId: null,
      position: [0, y, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number],
      scale: [1, 1, 1] as [number, number, number], text2d: says(text),
    });
    const hud = (score: string) => ({
      type: "assignMesh" as const, slotId: 7, meshAssetGuid: null, meshKind: "2dtext", actorGuid: "hud", text2d: says("BEST"),
      parts: [part("title", 1, "BEST"), part("score", -1, score)],
    });
    const { scene, binding } = play();
    applyAssignMesh(scene, binding, hud("10"));
    const root = binding.meshes.get(7)!;
    const title = scene.getMeshByName("actor-7|title") as Mesh;
    const score = scene.getMeshByName("actor-7|score") as Mesh;
    const titleDrawn = glyphBuffer(title);

    applyAssignMesh(scene, binding, hud("25"));

    expect(binding.meshes.get(7)).toBe(root);
    expect(scene.getMeshByName("actor-7|title")).toBe(title);
    expect(scene.getMeshByName("actor-7|score")).toBe(score);
    expect(glyphBuffer(title)).toBe(titleDrawn);
    expect([reads(title), reads(score)]).toEqual(["BEST", "25"]);
    const built = play();
    applyAssignMesh(built.scene, built.binding, hud("25"));
    expect(drawnText(score)).toEqual(drawnText(built.scene.getMeshByName("actor-7|score") as Mesh));
  });

  it("holds no glyph for a redraw it gave up when another text of the actor had to be rebuilt", () => {
    const part = (componentId: string, y: number, text: string, underline = false) => ({
      componentId, meshKind: "2dtext", meshAssetGuid: null, parentId: null,
      position: [0, y, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number],
      scale: [1, 1, 1] as [number, number, number], text2d: { ...says(text), underline },
    });
    // The underlined score cannot redraw, so the title's planned redraw is given up and the actor rebuilt.
    const hud = (title: string, score: string) => ({
      type: "assignMesh" as const, slotId: 7, meshAssetGuid: null, meshKind: "2dtext", actorGuid: "hud", text2d: says(title),
      parts: [part("title", 1, title), part("score", -1, score, true)],
    });
    const { scene, binding } = play();
    applyAssignMesh(scene, binding, hud("AB", "1"));
    const built = binding.meshes.get(7);
    applyAssignMesh(scene, binding, hud("CD", "2"));
    expect(binding.meshes.get(7)).not.toBe(built);
    binding.meshes.get(7)!.dispose();
    // Nothing is drawn any more: 234 new glyphs fill one page, which they could not beside a glyph still held.
    createText2DMesh(scene, "filler", { text: Array.from({ length: 234 }, (_, index) => String.fromCodePoint(0x4e00 + index)).join(""), size: 32 });
    expect(scene.textures.filter((texture) => texture.name.startsWith("text2d-glyph-atlas:"))).toHaveLength(1);
  });

  it("applies the rest of a refused assignment when a later command changes only its text", () => {
    const { scene, binding } = play();
    const caps = scene.getEngine().getCaps();
    const maxTextureSize = caps.maxTextureSize;
    applyAssignMesh(scene, binding, label(says("HI")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // No atlas fits: the slot keeps showing "HI", still a pick target.
    caps.maxTextureSize = 8;
    applyAssignMesh(scene, binding, label(says("HIJK"), { hitTest: "ignore" }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(reads(binding.meshes.get(4)!)).toBe("HI");
    caps.maxTextureSize = maxTextureSize;

    applyAssignMesh(scene, binding, label(says("HO"), { hitTest: "ignore" }));

    const root = binding.meshes.get(4)!;
    expect(reads(root)).toBe("HO");
    expect(stamps(root)).toEqual({ pickable: false, actor: "score", rich: false, glyphsPickable: false });
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

  it("builds editor visuals for 2DRichTextComponent with atlas-sampled glyphs", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const component = createRichText2DComponent("rich-1");
    component.properties.text = "[color=green]Hi";
    component.properties.appearStart = "hidden";
    const actor = createActor("hud", "Banner", { components: [component] });
    const mesh = createMeshForComponent(
      handle.scene,
      editorMeshName(actor.id),
      actor,
      component,
      { pixelsPerUnit: 100 },
    );
    expect((mesh.metadata as { text2dRich?: boolean }).text2dRich).toBe(true);
    expect(mesh.getChildMeshes().length).toBeGreaterThanOrEqual(1);
    expect(mesh.getChildMeshes().every((glyph) => glyph.visibility === 1)).toBe(true);
    expect(unlitBinding(mesh.getChildMeshes()[0]!).texture).toBeTruthy();
    expect(actorVisualFingerprint(actor)).toContain("2DRichTextComponent");
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
        verticalAlignment: "center",
        bold: false,
        italic: false,
        underline: false,
        wrapWidth: 0,
        wrapHeight: 0,
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
