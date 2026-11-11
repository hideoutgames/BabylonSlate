/**
 * Test-build-only oracle for Scene Layer draw batching: a HUD made like the Feature Test's (`buildSceneLayerHud`, every
 * second tinted background with an authored Material, and a line of text with an authored Text Material) drawn
 * by a Play compositor over a cleared backbuffer, with batching on and off, under the default layer camera, a panned
 * and zoomed one and a turned one. Each pair of images must match exactly; the batched draws are fewer.
 *
 * With `images` "nearest" the icons are sampled as a layer's images are (nearest, no mips), so the batcher puts them on
 * the Scene's shared page (`layer-image-atlas.ts`): each case also draws batched with the page off, whose draws the
 * page must undercut. Sprites that read past their images join them (`pastTheirImages`): what a cell answers there
 * must be what the image's own sampler answers.
 */
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Engine } from "@babylonjs/core/Engines/engine";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import type { Scene } from "@babylonjs/core/scene";
import type { LayerCameraState } from "@haptic/core";
import { createAppWebGpuEngine } from "@haptic/render";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { readEngineDrawCalls } from "../../../../packages/render/src/draw-calls";
import { compileMaterialPlan } from "../../../../packages/render/src/material-compiler";
import { sceneImagePages, setSceneDrawBatching, setSceneImagePages } from "../../../../packages/render/src/overlay-draw-batcher";
import { SceneLayerCompositor } from "../../../../packages/render/src/scene-layer-compositor";
import { buildSceneLayerHud } from "../../../../packages/render/src/scene-layer-hud-fixture";
import { createSpriteQuad, setSpriteQuadUvs } from "../../../../packages/render/src/sprite-quad";
import { setUnlitMaterial } from "../../../../packages/render/src/unlit-material";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

const WIDTH = 960;
const HEIGHT = 540;
const BACKGROUND = new Color4(0.05, 0.07, 0.11, 1);

const CAMERAS: Array<{ name: string; camera: LayerCameraState }> = [
  { name: "default", camera: { x: 0, y: 0, rotation: 0, zoom: 1 } },
  { name: "panned and zoomed", camera: { x: 1.37, y: -0.61, rotation: 0, zoom: 1.15 } },
  { name: "turned", camera: { x: -0.4, y: 0.25, rotation: 4, zoom: 0.9 } },
];

/** A 64 px icon of numeric content: quadrants of opaque colour, an alpha ramp and a transparent corner. */
function iconPixels(seed: number): Uint8Array {
  const pixels = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      const offset = (y * 64 + x) * 4;
      pixels[offset] = (x * 4 + seed * 40) & 255;
      pixels[offset + 1] = (y * 4) & 255;
      pixels[offset + 2] = ((x ^ y) * 8 + seed * 20) & 255;
      pixels[offset + 3] = x < 16 && y < 16 ? 0 : y > 48 ? x * 4 : 255;
    }
  }
  return pixels;
}

/** The images `pastTheirImages` adds to the page. */
const PAST_IMAGES = 3;

/**
 * Sprites whose UVs leave their image or run backwards, at sizes that put pixel centres on the lines between texels:
 * repeated, held at the edge, turned over, and mirrored (the last has no cell: only its sampler mirrors).
 */
function pastTheirImages(scene: Scene): void {
  const image = (seed: number, wrap: number) => {
    const texture = RawTexture.CreateRGBATexture(iconPixels(seed), 64, 64, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
    texture.hasAlpha = true;
    texture.wrapU = texture.wrapV = wrap;
    return texture;
  };
  const repeated = image(11, Texture.WRAP_ADDRESSMODE);
  const sprites: Array<[string, RawTexture, { u0: number; v0: number; u1: number; v1: number }, number]> = [
    ["repeated", repeated, { u0: 0, v0: 0, u1: 2.5, v1: 1.5 }, 1.37],
    ["held", image(12, Texture.CLAMP_ADDRESSMODE), { u0: -0.5, v0: -0.25, u1: 1.5, v1: 1.25 }, 1.37],
    ["turned over", image(13, Texture.WRAP_ADDRESSMODE), { u0: 1, v0: 1, u1: 0, v1: 0 }, 0.75],
    ["mirrored", image(14, Texture.MIRROR_ADDRESSMODE), { u0: 0, v0: 0, u1: 2, v1: 2 }, 1.37],
    ["whole", repeated, { u0: 0, v0: 0, u1: 1, v1: 1 }, 0.75],
  ];
  sprites.forEach(([name, texture, uvs, scale], index) => {
    const mesh = createSpriteQuad(scene, `past:${name}`, { pivot: { x: 0.5, y: 0.5 }, width: 64, height: 64 }, 100);
    setUnlitMaterial(mesh, { textured: true, backFaceCulling: true, fog: true, role: "world" },
      { texture, color: [1, 1, 1], alpha: 1, cutoff: 0.4, blend: false, textureAlpha: true, twoSided: false });
    setSpriteQuadUvs(mesh, uvs);
    mesh.position.set(-5 + index * 2.5, 1.5, -0.3);
    mesh.scaling.setAll(scale);
  });
}

export async function runSceneLayerBatchingProof(backend: "webgl2" | "webgpu", images: "filtered" | "nearest" = "filtered") {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.getElementById("root")!.append(canvas);
  const engine: AbstractEngine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true, useLargeWorldRendering: true });
  engine.setSize(WIDTH, HEIGHT);
  const order = readbackChannelOrder(engine.isWebGPU);
  const compositor = new SceneLayerCompositor({ engine });
  try {
    const layer = compositor.create({ type: "sceneLayerCreate", layerId: "hud", assetGuid: "hud", zOrder: 0, ownerSceneGuid: null, postProcessStack: [] });
    const textures = new Map<string, RawTexture>();
    // An authored Scene Layer Material for every second tinted background: its draws batch too.
    const document = createDefaultMaterialDocument();
    document.shadingModel = "unlit";
    document.blendMode = "translucent";
    const lowered = lowerMaterialDocument(document);
    if (!lowered.ok) throw new Error("The proof's authored Material did not lower");
    const authored = compileMaterialPlan(lowered.plan, { scene: layer.scene, name: "authoredPanel", overlay: true });
    if (!authored.ok) throw new Error("The proof's authored Material did not compile");
    await authored.ready;
    // And an authored Text Material for a line of text, whose glyphs are a mesh each.
    const textPlan = lowerMaterialDocument(createDefaultMaterialDocument("Text", "text"));
    if (!textPlan.ok) throw new Error("The proof's Text Material did not lower");
    const text = compileMaterialPlan(textPlan.plan, { scene: layer.scene, name: "authoredText", overlay: true });
    if (!text.ok) throw new Error("The proof's Text Material did not compile");
    await text.ready;
    buildSceneLayerHud(layer.scene, {
      authoredPanelMaterial: authored.material,
      textMaterial: text.material,
      texture: (guid) => {
        let texture = textures.get(guid);
        if (!texture) {
          if (images === "nearest") {
            texture = RawTexture.CreateRGBATexture(iconPixels(textures.size), 64, 64, layer.scene, false, false, Texture.NEAREST_SAMPLINGMODE);
            // As the resource cache loads a layer's image.
            texture.hasAlpha = true;
          } else texture = RawTexture.CreateRGBATexture(iconPixels(textures.size), 64, 64, layer.scene);
          textures.set(guid, texture);
        }
        return texture;
      },
    });
    if (images === "nearest") pastTheirImages(layer.scene);
    const drawCalls = () => readEngineDrawCalls(engine as unknown as Parameters<typeof readEngineDrawCalls>[0]);
    /** Draws the layer over the background until a frame draws it ready, then a few more; the last frame's image and draws. */
    const draw = async () => {
      const deadline = performance.now() + 30_000;
      let ready = 0;
      for (;;) {
        await compositor.prepare("hud", () => {});
        engine.beginFrame();
        engine.clear(BACKGROUND, true, true, true);
        const before = drawCalls();
        let presented = false;
        try {
          compositor.render(new Set(), (_id, render) => { presented = render(); });
        } finally {
          engine.endFrame();
        }
        const draws = drawCalls() - before;
        if (presented && ++ready >= 4) {
          const pixels = await engine.readPixels(0, 0, WIDTH, HEIGHT);
          return { pixels: toRgbaPixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), order), draws };
        }
        if (performance.now() > deadline) throw new Error("The layer did not present");
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
    };
    const cases = [];
    for (const { name, camera } of CAMERAS) {
      compositor.setCamera("hud", camera);
      setSceneDrawBatching(layer.scene, true);
      const batched = await draw();
      const pages = sceneImagePages(layer.scene);
      // The same batches from their members' own textures: what the page saves.
      setSceneImagePages(layer.scene, false);
      const ownTextures = (await draw()).draws;
      setSceneDrawBatching(layer.scene, false);
      const unbatched = await draw();
      cases.push({ name, batched, unbatched, pages, ownTextures });
    }
    return { width: WIDTH, height: HEIGHT, cases, pageImages: images === "nearest" ? textures.size + PAST_IMAGES : 0 };
  } finally {
    await compositor.dispose();
    engine.dispose();
    canvas.remove();
  }
}
