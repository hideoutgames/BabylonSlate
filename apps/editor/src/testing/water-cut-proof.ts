/**
 * Test-build-only proof of the Water Cut block on the real GPU: Custom Material water drawn through the Forward
 * FrameGraph (opaque, translucent with its depth pre-pass, translucent with Water Waves on the GPU path, and lit by
 * HapticLightingBlock), each without and with a removal volume over part of it.
 */
import { Color4, DirectionalLight, Engine, FreeCamera, Matrix, Scene, Vector3, type AbstractEngine, type Effect, type NodeMaterial } from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeRenderingQuality, normalizeShadowSettings, normalizeWaterBody } from "@haptic/core";
import {
  compileMaterialPlan, createAppWebGpuEngine, createWaterMesh, createWaterRemovalMesh, setHapticLighting, setSceneRenderSettings, updateSceneWater,
} from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument, materialPinDefaultPropertyKey, type MaterialDocument } from "@haptic/shader-graph";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

const MATERIALS = ["opaque", "translucent", "waves", "lit"] as const;

/** Green water: unlit opaque, translucent, or translucent with Water Waves displacing it; or lit and translucent. */
function waterDocument(kind: (typeof MATERIALS)[number]): MaterialDocument {
  const doc = createDefaultMaterialDocument(kind), lit = kind === "lit";
  if (!lit) doc.shadingModel = "unlit";
  doc.blendMode = kind === "opaque" ? "opaque" : "translucent";
  doc.edges = doc.edges.filter((edge) => edge.targetNodeId !== "output");
  const output = doc.nodes.find((node) => node.id === "output")!.properties;
  output[materialPinDefaultPropertyKey("baseColor")] = lit ? [0.05, 0.8, 0.05] : [0, 0, 0];
  output[materialPinDefaultPropertyKey("emissive")] = lit ? [0, 0, 0] : [0.1, 0.8, 0.2];
  output[materialPinDefaultPropertyKey("opacity")] = [0.9];
  if (kind === "waves") {
    doc.nodes.push({ id: "waves", type: "input.waterWaves", position: { x: 0, y: 0 }, properties: {} });
    doc.edges.push({ id: "offset", sourceNodeId: "waves", sourcePinId: "offset", targetNodeId: "output", targetPinId: "worldPositionOffset" });
  }
  return doc;
}

export async function runWaterCutProof(backend: "webgl2" | "webgpu" = "webgl2") {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 64;
  document.getElementById("root")!.append(canvas);
  const engine: AbstractEngine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  const order = readbackChannelOrder(engine.isWebGPU);
  const scene = new Scene(engine);
  try {
    scene.clearColor = new Color4(1, 0, 1, 1);
    const camera = new FreeCamera("camera", new Vector3(0, 8, -6), scene);
    camera.setTarget(Vector3.Zero());
    camera.minZ = 0.1;
    camera.maxZ = 50;
    scene.activeCamera = camera;
    setSceneRenderSettings(scene, { mode: "pbr", quality: normalizeRenderingQuality({}), shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 0 }) });
    const sun = new DirectionalLight("sun", new Vector3(0.2, -1, 0.3), scene);
    sun.intensity = 1.5;
    const graph = new ForwardSceneFrameGraph(scene);
    const draw = async () => {
      // Each draw is a new render: water picks its removal volumes once per render.
      scene.incrementRenderId();
      updateSceneWater(scene);
      await graph.prepare(camera);
      engine.beginFrame();
      try { graph.render(camera, false); } finally { engine.endFrame(); }
      const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
      return toRgbaPixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), order);
    };
    const centre = new Vector3(1.5, 0, 0);
    const captures: { material: string; cut: boolean; pixels: number[] }[] = [];
    for (const kind of MATERIALS) {
      // The switch picks the lighting block when a Material compiles.
      setHapticLighting(engine, kind === "lit");
      const lowered = lowerMaterialDocument(waterDocument(kind));
      if (!lowered.ok) throw new Error(`${kind} did not lower`);
      const compiled = compileMaterialPlan(lowered.plan, { scene, name: kind });
      if (!compiled.ok) throw new Error(`${kind} did not compile`);
      await compiled.ready;
      const material: NodeMaterial = compiled.material;
      const water = createWaterMesh(scene, `${kind} water`, normalizeWaterBody({ width: 8, length: 8, resolution: 32 }), createDefaultWaterDefinition(), material);
      captures.push({ material: kind, cut: false, pixels: await draw() });
      const removal = createWaterRemovalMesh(scene, "hole", { shape: "box", width: 3, height: 4, length: 3 }, { editor: false });
      removal.position.copyFrom(centre);
      captures.push({ material: kind, cut: true, pixels: await draw() });
      removal.dispose();
      water.dispose();
      compiled.dispose();
    }
    // The removal volume's centre across the screen, by the view the draws used (columns read the same on either
    // backend's row order).
    const holeX = Vector3.Project(centre, Matrix.IdentityReadOnly, scene.getTransformMatrix(), camera.viewport.toGlobal(canvas.width, canvas.height)).x;
    const effects = (engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects;
    // Water's depth pre-pass draws its own program, which discards removed water and returns before the look.
    const prePassEffects = Object.values(effects).filter((effect) => /#define DEPTHPREPASS/.test(effect.defines) && /#define SLATE_WATER_SURFACE/.test(effect.defines)).length;
    graph.dispose();
    return { width: canvas.width, height: canvas.height, holeX, captures, prePassEffects };
  } finally {
    setHapticLighting(engine, false);
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
