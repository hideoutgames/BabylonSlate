/**
 * Test-build-only oracle for the light block's shadow-filter jitter: a box's sun shadow on a floor from a deliberately
 * coarse map, so the fixed PCF pattern draws a texel staircase along its diagonal edges. Captures the fixed pattern, the
 * jitter's define at amplitude 0, sixteen frames at amplitude 1 (phases 1 to 16) and, on request, real temporal
 * anti-aliasing resolving the jitter, with a ray-cast mask of what blocks the floor's view of the sun.
 */
import {
  Color4,
  DirectionalLight,
  Engine,
  FreeCamera,
  MeshBuilder,
  Scene,
  Vector3,
  type AbstractEngine,
  type AbstractMesh,
  type CascadedShadowGenerator,
} from "@babylonjs/core";
import { normalizeRenderEffectsSettings, normalizeRenderingQuality, normalizeShadowSettings } from "@haptic/core";
import { applyAuthoredLightProperties, compileMaterialPlan, createAppWebGpuEngine, setSceneRenderSettings } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument, materialPinDefaultPropertyKey } from "@haptic/shader-graph";
import { setSceneBindsPreviousEffects } from "../../../../packages/render/src/variant-swaps";
import { forceViewTerms } from "../../../../packages/render/src/haptic-view-inputs";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";
import { floorShadowMask } from "./haptic-contact-shadow-proof";

type Capture = { name: string; pixels: number[]; jittered: boolean };

export async function runHapticShadowJitterProof(backend: "webgl2" | "webgpu", temporal: boolean) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 96;
  document.getElementById("root")!.append(canvas);
  const engine: AbstractEngine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true, useLargeWorldRendering: true });
  engine.setSize(canvas.width, canvas.height);
  const order = readbackChannelOrder(engine.isWebGPU);
  const read = async () => {
    const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
    return toRgbaPixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), order);
  };
  const scene = new Scene(engine);
  try {
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    const camera = new FreeCamera("camera", new Vector3(0, 4, -4.5), scene);
    camera.setTarget(new Vector3(0, 0, 0.5));
    camera.minZ = 0.1;
    camera.maxZ = 40;
    scene.activeCamera = camera;
    setSceneBindsPreviousEffects(scene);
    const effects = normalizeRenderEffectsSettings(undefined);
    // One cascade from a 256-texel map over 24 m: about 11 texels per metre, several pixels each at the box.
    const settings = () => setSceneRenderSettings(scene, {
      mode: "pbr", effects, quality: normalizeRenderingQuality({}),
      shadows: normalizeShadowSettings({ cascades: 1, mapSize: 256, distance: 24, filterQuality: "medium", depthBias: 0.0008 }),
    });
    settings();

    const doc = createDefaultMaterialDocument("rough dielectric");
    doc.nodes.find((node) => node.id === "baseColor")!.properties.value = [0.8, 0.8, 0.8];
    const output = doc.nodes.find((node) => node.id === "output")!.properties;
    output[materialPinDefaultPropertyKey("metallic")] = [0];
    output[materialPinDefaultPropertyKey("roughness")] = [0.6];
    output[materialPinDefaultPropertyKey("environmentInfluence")] = [0];
    const lowered = lowerMaterialDocument(doc);
    if (!lowered.ok) throw new Error("The surface did not lower");
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: "rough dielectric" });
    if (!compiled.ok) throw new Error("The surface did not compile");
    await compiled.ready;

    const floor = MeshBuilder.CreateGround("floor", { width: 10, height: 8 }, scene);
    const box = MeshBuilder.CreateBox("box", { size: 1.4 }, scene);
    box.position.set(0, 0.7, 0.6);
    box.rotation.y = 0.45;
    const meshes: AbstractMesh[] = [floor, box];
    for (const mesh of meshes) mesh.material = compiled.material;
    const sun = new DirectionalLight("sun", new Vector3(0.35, -0.8, -0.5), scene);
    applyAuthoredLightProperties(sun, { color: [1, 0.95, 0.85], intensity: 3, castShadows: true, range: 40, outerAngle: 70, innerAngle: 40 });

    const graph = new ForwardSceneFrameGraph(scene);
    const draw = async () => {
      const deadline = performance.now() + 15_000;
      for (;;) {
        await graph.prepare(camera);
        engine.beginFrame();
        let rendered: boolean;
        try { rendered = graph.render(camera, false).rendered !== false; } finally { engine.endFrame(); }
        if (rendered) return read();
        if (performance.now() > deadline) throw new Error("The view did not present");
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
    };
    /** Whether the floor's program carries the jitter's define. */
    const jittered = () => /^#define HAPTIC_SHADOW_JITTER$/m.test(floor.subMeshes[0]!.effect?.defines ?? "");
    await draw();
    const generator = sun.getShadowGenerator() as CascadedShadowGenerator | null;
    for (let frame = 0; frame < 60 && generator?.getDarkness() !== 0; frame++) await draw();
    // Settles a program change (a forced jitter is no settings change: the Material re-prepares its defines itself).
    const settle = async () => {
      compiled.material.markDirty(true);
      for (let frame = 0; frame < 8; frame++) await draw();
    };

    const captures: Capture[] = [];
    captures.push({ name: "fixed", pixels: await draw(), jittered: jittered() });
    forceViewTerms(scene, { jitterAmplitude: 0, jitterPhase: 3 });
    settings();
    await settle();
    captures.push({ name: "amplitude 0", pixels: await draw(), jittered: jittered() });
    for (let phase = 1; phase <= 16; phase++) {
      forceViewTerms(scene, { jitterAmplitude: 1, jitterPhase: phase });
      captures.push({ name: `phase ${phase}`, pixels: await draw(), jittered: jittered() });
    }
    forceViewTerms(scene, null);
    settings();
    await settle();
    captures.push({ name: "fixed again", pixels: await draw(), jittered: jittered() });
    sun.shadowEnabled = false;
    captures.push({ name: "unshadowed", pixels: await draw(), jittered: false });
    sun.shadowEnabled = true;
    if (temporal) {
      effects.temporalAntiAliasing = { enabled: true, samples: 8, blend: 0.1 };
      settings();
      await settle();
      for (let frame = 0; frame < 32; frame++) await draw();
      captures.push({ name: "temporal", pixels: await draw(), jittered: jittered() });
      effects.temporalAntiAliasing = { ...effects.temporalAntiAliasing, enabled: false };
      settings();
      await settle();
      captures.push({ name: "temporal off", pixels: await draw(), jittered: jittered() });
    }
    const blocked = floorShadowMask(scene, camera, canvas, engine.isWebGPU, meshes, () => sun.direction.normalizeToNew().scaleInPlace(-100));
    graph.dispose();
    return { width: canvas.width, height: canvas.height, captures, blocked };
  } finally {
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
