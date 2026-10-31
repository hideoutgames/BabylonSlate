/**
 * Test-build-only oracle for the light block's shadow filter: a top-down view of a floor under a near-vertical sun whose
 * one coarse cascade has texels several pixels wide, and a slab above it turned 30° so its shadow's edge crosses the
 * texels diagonally. Drawn through the Forward FrameGraph at each filter quality, each capture divided by the same view
 * with the sun unshadowed: per pixel row across the edge, the lit share.
 */
import {
  Color4, DirectionalLight, Engine, FreeCamera, MeshBuilder, Scene, Vector3, type AbstractEngine, type CascadedShadowGenerator,
} from "@babylonjs/core";
import { normalizeRenderingQuality, normalizeShadowSettings, type ShadowSettings } from "@haptic/core";
import { applyAuthoredLightProperties, compileMaterialPlan, createAppWebGpuEngine, setSceneRenderSettings } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument, materialPinDefaultPropertyKey } from "@haptic/shader-graph";
import { setSceneBindsPreviousEffects } from "../../../../packages/render/src/variant-swaps";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

const WIDTH = 160;
/** An 8-bit sRGB channel in linear light. */
const linear = (value: number) => {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const HEIGHT = 120;

export async function runShadowFilterProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.getElementById("root")!.append(canvas);
  const engine: AbstractEngine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true, useLargeWorldRendering: true });
  engine.setSize(WIDTH, HEIGHT);
  const order = readbackChannelOrder(engine.isWebGPU);
  const scene = new Scene(engine);
  try {
    scene.clearColor = new Color4(0, 0, 0, 1);
    // Straight down at the floor from below the slab: the shadow's edge runs across the image, its texels a few pixels wide.
    const camera = new FreeCamera("camera", new Vector3(0, 5.5, 0), scene);
    camera.setTarget(new Vector3(0, 0, 0.001));
    camera.minZ = 0.5;
    camera.maxZ = 30;
    scene.activeCamera = camera;
    setSceneBindsPreviousEffects(scene);
    const shadows = (filterQuality: ShadowSettings["filterQuality"]) => setSceneRenderSettings(scene, {
      quality: normalizeRenderingQuality({}),
      // One cascade over a long distance at the smallest map: texels of about 0.3 m, wider than the view's pixels.
      shadows: normalizeShadowSettings({ cascades: 1, mapSize: 256, distance: 60, filter: "pcf", filterQuality, screenShadows: "off" }),
    });
    shadows("high");
    const doc = createDefaultMaterialDocument("matte");
    doc.nodes.find((node) => node.id === "baseColor")!.properties.value = [0.8, 0.8, 0.8];
    const output = doc.nodes.find((node) => node.id === "output")!.properties;
    output[materialPinDefaultPropertyKey("metallic")] = [0];
    output[materialPinDefaultPropertyKey("roughness")] = [1];
    output[materialPinDefaultPropertyKey("environmentInfluence")] = [0];
    const lowered = lowerMaterialDocument(doc);
    if (!lowered.ok) throw new Error("matte did not lower");
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: "matte" });
    if (!compiled.ok) throw new Error("matte did not compile");
    await compiled.ready;
    const floor = MeshBuilder.CreateGround("floor", { width: 40, height: 40 }, scene);
    floor.material = compiled.material;
    // A slab above the camera, out of its view, turned so its edge crosses the shadow texels diagonally.
    // Its right edge runs through the view's centre; the slab reaches well past the view's other sides.
    const slab = MeshBuilder.CreateBox("slab", { width: 30, height: 0.2, depth: 30 }, scene);
    slab.rotation.y = Math.PI / 6;
    slab.position.set(-15 * Math.cos(Math.PI / 6), 6, 15 * Math.sin(Math.PI / 6));
    slab.material = compiled.material;
    const sun = new DirectionalLight("sun", new Vector3(0.02, -1, 0.01).normalize(), scene);
    const sunShadows = (castShadows: boolean) =>
      applyAuthoredLightProperties(sun, { color: [1, 1, 1], intensity: 3, castShadows, range: 40, outerAngle: 70, innerAngle: 40 });
    sunShadows(true);

    const graph = new ForwardSceneFrameGraph(scene);
    const draw = async () => {
      const deadline = performance.now() + 20_000;
      for (;;) {
        await graph.prepare(camera);
        engine.beginFrame();
        let rendered: boolean;
        try { rendered = graph.render(camera, false).rendered !== false; } finally { engine.endFrame(); }
        if (rendered) {
          const pixels = await engine.readPixels(0, 0, WIDTH, HEIGHT);
          return toRgbaPixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), order);
        }
        if (performance.now() > deadline) throw new Error("The view did not present");
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
    };
    const settle = async () => {
      let last = await draw();
      for (let frame = 0; frame < 12; frame++) last = await draw();
      const generator = sun.getShadowGenerator() as CascadedShadowGenerator | null;
      for (let frame = 0; frame < 60 && generator && generator.getDarkness() !== 0; frame++) last = await draw();
      return last;
    };
    sunShadows(false);
    const open = await settle();
    sunShadows(true);
    const generator = () => sun.getShadowGenerator() as CascadedShadowGenerator;
    const captures: { quality: ShadowSettings["filterQuality"]; lit: number[]; pixelsPerTexel: number }[] = [];
    for (const quality of ["low", "medium", "high"] as const) {
      shadows(quality);
      const drawn = await settle();
      // In linear light: the readback is sRGB, whose first steps above black are wide.
      const lit = Array.from({ length: WIDTH * HEIGHT }, (_, pixel) => {
        let full = 0, seen = 0;
        for (let channel = 0; channel < 3; channel++) {
          full += linear(open[pixel * 4 + channel]!);
          seen += linear(drawn[pixel * 4 + channel]!);
        }
        return full > 0.3 ? seen / full : -1;
      });
      // The cascade's world width over its tile, against the view's world width over its pixels.
      const shadow = generator();
      const width = shadow.getCascadeMaxExtents(0)!.x - shadow.getCascadeMinExtents(0)!.x;
      const texel = width / shadow.mapSize;
      const viewWidth = 2 * camera.position.y * Math.tan(camera.fov / 2) * (WIDTH / HEIGHT);
      captures.push({ quality, lit, pixelsPerTexel: texel / (viewWidth / WIDTH) });
    }
    graph.dispose();
    await graph.whenReleased();
    return { width: WIDTH, height: HEIGHT, captures };
  } finally {
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
