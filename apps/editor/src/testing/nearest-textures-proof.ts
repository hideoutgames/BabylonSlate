/**
 * Test-build-only oracle for Nearest Texture Filtering: a frozen unlit graph Material samples a 4 x 4 checker Texture
 * magnified over three strips that fill a world view. Drawn with the switch off, on, off again, then with a second
 * Material whose Texture loads while the switch is on. Linear filtering blends the checker's cells into greys;
 * nearest leaves only its two colours.
 */
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { normalizeRenderingQuality, normalizeShadowSettings } from "@haptic/core";
import {
  acquireMaterialTexture, createAppWebGpuEngine, MaterialLibrary, materialTextureSampling, resourceCacheForEngine,
  setNearestTextures, setSceneRenderSettings,
} from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, materialPinDefaultPropertyKey } from "@haptic/shader-graph";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

const WIDTH = 160;
const HEIGHT = 120;

/** A 4 x 4 checker PNG of `dark` and `light` grey levels. */
async function checkerPng(dark: number, light: number): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 4;
  const context = canvas.getContext("2d")!;
  const image = context.createImageData(4, 4);
  for (let index = 0; index < 16; index++) {
    const value = ((index % 4) + Math.floor(index / 4)) % 2 ? light : dark;
    image.data.set([value, value, value, 255], index * 4);
  }
  context.putImageData(image, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("no PNG")), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

export async function runNearestTexturesProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.getElementById("root")!.append(canvas);
  const engine: AbstractEngine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true, useLargeWorldRendering: true });
  engine.setSize(WIDTH, HEIGHT);
  const scene = new Scene(engine);
  const graph = new ForwardSceneFrameGraph(scene, {});
  try {
    scene.clearColor = new Color4(0, 0, 0, 1);
    const camera = new FreeCamera("camera", new Vector3(0, 0, -2), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    setSceneRenderSettings(scene, { quality: normalizeRenderingQuality({}), shadows: normalizeShadowSettings({ enabled: false }) });
    const textures = new Map([["checker", await checkerPng(30, 220)], ["late", await checkerPng(30, 220)]]);
    const cache = resourceCacheForEngine(engine);
    const library = new MaterialLibrary({
      acquireTexture: (guid, _scene, filter) => acquireMaterialTexture(cache, guid, engine, textures.get(guid)!, materialTextureSampling(filter)),
    });
    const material = async (guid: string) => {
      const doc = createDefaultMaterialDocument(guid);
      doc.nodes.push({ id: "sample", type: "texture.sample", properties: { textureGuid: guid, colorSpace: "srgb" }, position: { x: 0, y: 0 } });
      doc.edges = doc.edges.filter((edge) => !(edge.targetNodeId === "output" && edge.targetPinId === "baseColor"));
      doc.edges.push({ id: "base", sourceNodeId: "sample", sourcePinId: "rgb", targetNodeId: "output", targetPinId: "baseColor" });
      doc.nodes.find((node) => node.id === "output")!.properties[materialPinDefaultPropertyKey("metallic")] = [0];
      // Unlit: the view shows the texels, no shading gradient over them.
      const acquired = library.acquire(scene, guid, doc, { unlit: true });
      if (acquired.ok === false) throw new Error(`the ${guid} Material did not compile: ${JSON.stringify(acquired.diagnostics)}`);
      await acquired.ready;
      // As the editor freezes the Materials it is not editing: a frozen Material keeps its bindings between draws.
      acquired.material.freeze();
      return acquired.material;
    };
    // Three strips share the Material: a frozen Material binds only the first of a run of draws, and on WebGPU each
    // draw keeps its own bindings.
    const checker = await material("checker");
    const strips = [-1, 0, 1].map((column) => {
      const strip = MeshBuilder.CreatePlane(`strip-${column}`, { width: 0.8, height: 2.2 }, scene);
      strip.position.x = column * 0.8;
      strip.material = checker;
      return strip;
    });
    const order = readbackChannelOrder(engine.isWebGPU);
    /** Draws until the view presents a few frames, then counts the pixels between the checker's two levels. */
    const capture = async () => {
      for (let frame = 0, presented = 0; presented < 6; frame++) {
        if (frame > 600) throw new Error("The view did not present");
        await graph.prepare(camera);
        engine.beginFrame();
        let rendered: boolean;
        try { rendered = graph.render(camera, false).rendered !== false; } finally { engine.endFrame(); }
        if (rendered) presented++;
        if (presented < 6) await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
      const read = await engine.readPixels(0, 0, WIDTH, HEIGHT);
      const pixels = toRgbaPixels(new Uint8Array(read.buffer, read.byteOffset, read.byteLength), order);
      let low = 255, high = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        low = Math.min(low, pixels[offset]!);
        high = Math.max(high, pixels[offset]!);
      }
      let between = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const level = (pixels[offset]! - low) / Math.max(1, high - low);
        if (level > 0.2 && level < 0.8) between++;
      }
      return { low, high, between };
    };
    const off = await capture();
    setNearestTextures(engine, true);
    const on = await capture();
    setNearestTextures(engine, false);
    const restored = await capture();
    setNearestTextures(engine, true);
    const late = await material("late");
    for (const strip of strips) strip.material = late;
    const loadedWhileOn = await capture();
    return { off, on, restored, loadedWhileOn };
  } finally {
    setNearestTextures(engine, false);
    graph.dispose();
    await graph.whenReleased();
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
