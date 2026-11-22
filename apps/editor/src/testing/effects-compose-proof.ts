/**
 * Test-build-only proof of the screen-space effects' composition and Screen-Space Shadows: one fixed frame at the
 * iPad's 944 x 630 through the Forward FrameGraph, PBR, over a rough box, a mirror floor, an alpha-clipped leaf, a
 * translucent pane and an unlit pillar lit in 3D, under a shadowed sun and a point light, with one combination of
 * ambient occlusion, Real-Time Reflections, volumetric lighting and Screen-Space Shadows (`EffectsComposeVariant`).
 * It returns the presented frame, the spatial chain's output as the compose wrote it, the geometry pass's reflectivity,
 * the Screen-Space Shadows target, the ambient occlusion and volumetric marches' targets, and the GL passes and texels
 * covered of the frame (`GlSignatureRecorder`), so a spec can compare two builds' frames and structure. The `marches`
 * variants plan Screen-Space Shadows beside ambient occlusion and volumetric lighting, whose half-resolution marches
 * draw in passes of their own by default and in one pass with `mergedMarches` (`worlddebug mergedmarches on`,
 * `merged-marches.ts`), so a spec can compare the two byte for byte. `marches-fog-idle` has no density and
 * no Fog Volume (the fog march idles), `marches-sun-unshadowed` a sun that casts no shadows (the screen shadows idle).
 */
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import "@babylonjs/core/Engines/Extensions/engine.readTexture";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import {
  normalizeCelShadingSettings,
  normalizeRenderEffectsSettings,
  normalizeRenderingQuality,
  normalizeShadowSettings,
} from "@haptic/core";
import { applyAuthoredLightProperties, compileMaterialPlan, setSceneRenderSettings, largeWorldEngineOptions } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument, materialPinDefaultPropertyKey, type MaterialBlendMode } from "@haptic/shader-graph";
import { GlSignatureRecorder, installGlSignature } from "@haptic/render/editor-proofs";
import { allowSceneScreenShadows } from "@haptic/render/render-settings";
import type { SpatialEffectsGraph } from "@haptic/render/editor-proofs";
import { setSceneWorldDebug } from "@haptic/render/editor-proofs";
import { setUnlitMaterial } from "@haptic/render/editor-proofs";

export type EffectsComposeVariant =
  | "ao" | "fog" | "reflections" | "ao-fog" | "all" | "screen-shadows" | "marches" | "marches-fog-idle" | "marches-sun-unshadowed";

/** A readback as base64 of its typed array: `u8` bytes, `f32` floats or `u16` half floats. */
export type EffectsReadback = { width: number; height: number; type: "u8" | "f32" | "u16"; data: string };

export type EffectsComposeCapture = {
  variant: EffectsComposeVariant;
  renderer: string;
  /** The presented frame, RGBA8 bottom row first, and as a PNG data URL (top row first). */
  frame: EffectsReadback;
  png: string;
  /** The spatial chain's output (the colour the effects composed), the geometry pass's reflectivity, the screen shadows. */
  composed: EffectsReadback | null;
  reflectivity: EffectsReadback | null;
  screenShadows: EffectsReadback | null;
  /** The ambient occlusion march's and the volumetric march's targets, as the pass that writes each leaves it. */
  occlusion: EffectsReadback | null;
  fog: EffectsReadback | null;
  /** The frame's GL passes and texels covered, and its graph tasks. */
  passes: number;
  texelsCovered: number;
  passList: string[];
  tasks: string[];
};

const WIDTH = 944;
const HEIGHT = 630;

function base64(bytes: Uint8Array): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
}

function readback(values: ArrayBufferView, width: number, height: number): EffectsReadback {
  const type = values instanceof Float32Array ? "f32" : values instanceof Uint16Array ? "u16" : "u8";
  return { width, height, type, data: base64(new Uint8Array(values.buffer, values.byteOffset, values.byteLength)) };
}

function png(pixels: Uint8Array): string {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d")!;
  const image = context.createImageData(WIDTH, HEIGHT);
  for (let row = 0; row < HEIGHT; row++)
    image.data.set(pixels.subarray((HEIGHT - 1 - row) * WIDTH * 4, (HEIGHT - row) * WIDTH * 4), row * WIDTH * 4);
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

export async function runEffectsComposeProof(variant: EffectsComposeVariant, largeWorld = false, mergedMarches = false): Promise<EffectsComposeCapture> {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.getElementById("root")!.append(canvas);
  const engine = new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true, ...largeWorldEngineOptions(largeWorld) });
  engine.setHardwareScalingLevel(1);
  engine.setSize(WIDTH, HEIGHT);
  const scene = new Scene(engine);
  try {
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    const camera = new FreeCamera("camera", new Vector3(0, 2.4, -5), scene);
    camera.setTarget(new Vector3(0, 0.4, 1.5));
    camera.minZ = 0.1;
    camera.maxZ = 60;
    scene.activeCamera = camera;
    allowSceneScreenShadows(scene, () => true);
    if (mergedMarches) setSceneWorldDebug(scene, "mergedmarches", true);
    const marches = variant.startsWith("marches");
    const ao = variant === "ao" || variant === "ao-fog" || variant === "all" || marches;
    const reflections = variant === "reflections" || variant === "all" || variant === "marches";
    const fog = variant === "fog" || variant === "ao-fog" || variant === "all" || marches;
    const effects = normalizeRenderEffectsSettings({
      ambientOcclusion: { enabled: ao, resolutionScale: 0.5, radius: 0.6, strength: 2 },
      reflections: { enabled: reflections, maxSteps: 64, thickness: 0.3 },
      volumetricLighting: {
        enabled: fog, resolutionScale: 0.5, steps: 16, density: variant === "marches-fog-idle" ? 0 : 0.04, maxDistance: 20, intensity: 1,
      },
    });
    setSceneRenderSettings(scene, {
      mode: "pbr",
      effects,
      cel: normalizeCelShadingSettings({ outlinesEnabled: false }),
      quality: normalizeRenderingQuality({
        resolution: { scale: 1, dynamic: false },
        postprocessing: { resolutionScale: 1, antiAliasing: "off", ambientOcclusion: true, reflections: true, volumetricLighting: true },
      }),
      // Screen-Space Shadows over a coarse sun map, which leaves the contacts to them.
      shadows: variant === "screen-shadows" || marches
        ? normalizeShadowSettings({ cascades: 1, mapSize: 256, distance: 60, screenShadows: "high" })
        : normalizeShadowSettings({ cascades: 2, mapSize: 512, distance: 30, screenShadows: "off" }),
    });

    const material = async (name: string, color: number[], metallic: number, roughness: number, blendMode: MaterialBlendMode = "opaque", opacity = 1) => {
      const doc = createDefaultMaterialDocument(name);
      doc.blendMode = blendMode;
      doc.nodes.find((node) => node.id === "baseColor")!.properties.value = color;
      const output = doc.nodes.find((node) => node.id === "output")!.properties;
      output[materialPinDefaultPropertyKey("metallic")] = [metallic];
      output[materialPinDefaultPropertyKey("roughness")] = [roughness];
      if (blendMode !== "opaque") output[materialPinDefaultPropertyKey("opacity")] = [opacity];
      const lowered = lowerMaterialDocument(doc);
      if (!lowered.ok) throw new Error(`${name} did not lower`);
      const compiled = compileMaterialPlan(lowered.plan, { scene, name });
      if (!compiled.ok) throw new Error(`${name} did not compile`);
      await compiled.ready;
      return compiled.material;
    };
    const rough = await material("rough", [0.8, 0.8, 0.8], 0, 0.7);
    const mirror = await material("mirror", [0.9, 0.9, 0.9], 1, 0.05);
    const clipped = await material("clipped", [0.3, 0.7, 0.3], 0, 0.4, "masked", 0.8);
    const glass = await material("glass", [0.6, 0.8, 1], 0, 0.1, "translucent", 0.3);

    const floor = MeshBuilder.CreateGround("floor", { width: 12, height: 30 }, scene);
    floor.position.z = 10;
    floor.material = mirror;
    const box = MeshBuilder.CreateBox("box", { size: 0.8 }, scene);
    box.position.set(-1.4, 0.4, 0.8);
    box.rotation.y = 0.4;
    box.material = rough;
    const block = MeshBuilder.CreateBox("block", { width: 1.2, height: 0.5, depth: 0.6 }, scene);
    block.position.set(0.9, 0.25, -0.6);
    block.rotation.y = -0.3;
    block.material = rough;
    const leaf = MeshBuilder.CreateBox("leaf", { width: 1, height: 1.2, depth: 0.1 }, scene);
    leaf.position.set(1.4, 0.6, 1.2);
    leaf.material = clipped;
    const pane = MeshBuilder.CreatePlane("pane", { width: 1, height: 0.7 }, scene);
    pane.position.set(-0.2, 0.5, -0.4);
    pane.material = glass;
    const pillar = MeshBuilder.CreateCylinder("pillar", { diameter: 0.5, height: 1.6, tessellation: 16 }, scene);
    pillar.position.set(0.2, 0.8, 2.4);
    setUnlitMaterial(pillar, { textured: false, backFaceCulling: true, fog: true, role: "world", lighting: "3d" }, {
      texture: null, color: [0.9, 0.4, 0.2], alpha: 1, cutoff: 0, blend: false, textureAlpha: false, twoSided: false,
    });

    const sun = new DirectionalLight("sun", new Vector3(0.45, -0.5, 0.6).normalize(), scene);
    applyAuthoredLightProperties(sun, {
      color: [1, 0.95, 0.85], intensity: 3, castShadows: variant !== "marches-sun-unshadowed", range: 40, outerAngle: 70, innerAngle: 40,
    });
    const lamp = new PointLight("lamp", new Vector3(1, 2, 0), scene);
    applyAuthoredLightProperties(lamp, { color: [0.6, 0.7, 1], intensity: 8, castShadows: false, range: 10, outerAngle: 70, innerAngle: 40 });

    const graph = new ForwardSceneFrameGraph(scene);
    const internals = graph as unknown as { graph?: FrameGraph; effectsGraph?: { spatial?: SpatialEffectsGraph } };
    const deadline = performance.now() + 60_000;
    await graph.prepare(camera);
    while (!graph.readiness(camera).ready) {
      if (performance.now() > deadline) throw new Error(`${variant}: readiness timed out`);
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
      await graph.prepare(camera);
    }
    const spatial = internals.effectsGraph?.spatial;
    const frameGraph = internals.graph;
    if (!spatial || !frameGraph) throw new Error(`${variant}: the view has no spatial effects`);
    const read = (handle: number): EffectsReadback => {
      const texture = frameGraph.textureManager.getTextureFromHandle(handle)!;
      return readback(engine._readTexturePixelsSync(texture, texture.width, texture.height) as ArrayBufferView, texture.width, texture.height);
    };
    let composed: EffectsReadback | null = null, reflectivity: EffectsReadback | null = null, screenShadows: EffectsReadback | null = null;
    const marchTargets: Record<"occlusion" | "fog", EffectsReadback | null> = { occlusion: null, fog: null };
    // Read as each pass leaves its target: later passes may reuse it within the frame.
    const observers: (() => void)[] = [];
    const last = spatial.tasks[spatial.tasks.length - 1];
    if (last) {
      const observer = last.onAfterTaskExecute.add(() => { composed = read(spatial.output); });
      observers.push(() => last.onAfterTaskExecute.remove(observer));
    }
    if (reflections) {
      const observer = spatial.geometry.onAfterTaskExecute.add(() => { reflectivity = read(spatial.geometry.geometryReflectivityTexture); });
      observers.push(() => spatial.geometry.onAfterTaskExecute.remove(observer));
    }
    const shadows = spatial.screenShadows;
    if (shadows) {
      const observer = shadows.task.onAfterTaskExecute.add(() => { screenShadows = read(shadows.output); });
      observers.push(() => shadows.task.onAfterTaskExecute.remove(observer));
    }
    // The marches' targets as their pass leaves them: the merged pass before the objects, or each march's own after.
    for (const [key, name] of [["occlusion", "Scene Ambient Occlusion"], ["fog", "Scene Volumetric Lighting"]] as const) {
      const target = spatial.stageTargets.find((entry) => entry.name === name);
      if (!target) continue;
      const observer = target.writer.onAfterTaskExecute.add(() => { marchTargets[key] = read(target.output); });
      observers.push(() => target.writer.onAfterTaskExecute.remove(observer));
    }
    const recorder = new GlSignatureRecorder();
    let record: ReturnType<GlSignatureRecorder["endFrame"]> = null;
    try {
      // Shadow maps and the screen shadows settle over the first frames; the last one is the capture, and its GL calls
      // are the frame's structure.
      for (let presented = 0; presented < 6;) {
        const capture = presented === 5;
        const uninstall = capture ? installGlSignature(engine._gl as WebGL2RenderingContext, recorder) : null;
        if (capture) { recorder.start(); recorder.beginFrame(); }
        engine.beginFrame();
        let rendered: boolean;
        try { rendered = graph.render(camera, false).rendered !== false; } finally {
          engine.endFrame();
          if (capture) record = recorder.endFrame();
          uninstall?.();
        }
        if (rendered) presented++;
        else {
          if (performance.now() > deadline) throw new Error(`${variant}: presentation timed out`);
          await new Promise<void>((resolve) => setTimeout(resolve, 16));
          await graph.prepare(camera);
        }
      }
    } finally { for (const remove of observers) remove(); }
    const pixels = await engine.readPixels(0, 0, WIDTH, HEIGHT);
    const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    const frameRecord = record as ReturnType<GlSignatureRecorder["endFrame"]>;
    const result: EffectsComposeCapture = {
      variant,
      renderer: engine.getGlInfo().renderer,
      frame: readback(bytes, WIDTH, HEIGHT),
      png: png(bytes),
      composed,
      reflectivity,
      screenShadows,
      occlusion: marchTargets.occlusion,
      fog: marchTargets.fog,
      passes: frameRecord?.passes ?? 0,
      texelsCovered: frameRecord?.texelsCovered ?? 0,
      passList: recorder.stats()?.structures[0]?.passes ?? [],
      tasks: graph.taskNames(),
    };
    graph.dispose();
    await graph.whenReleased();
    return result;
  } finally {
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
