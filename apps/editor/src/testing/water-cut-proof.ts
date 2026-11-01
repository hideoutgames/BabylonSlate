/**
 * Test-build-only proof of the Water Cut block on the real GPU: Custom Material water drawn through the Forward
 * FrameGraph (opaque, translucent with its depth pre-pass, translucent with Water Waves on the GPU path, and lit by
 * HapticLightingBlock), each without and with a removal volume over part of it; and the water starter graph, which
 * reads every water node, drawn once with ambient occlusion and Real-Time Reflections, so it also draws the scene
 * effects' geometry pass; in dense fog, water that shows only what Water Scene Color refracts, unbent, over a floor
 * (at the Default tier's copy resolution and at half), and the floor without it; and a faint translucent Material three times brighter than white, whose coverage rises.
 */
import {
  Color3, Color4, DirectionalLight, Engine, FreeCamera, Matrix, MeshBuilder, Scene, StandardMaterial, Vector3, type AbstractEngine, type Effect, type NodeMaterial,
} from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeRenderEffectsSettings, normalizeRenderingQuality, normalizeShadowSettings, normalizeWaterBody } from "@haptic/core";
import {
  compileMaterialPlan, configureEditorRenderingGroups, createAppWebGpuEngine, createWaterMesh, createWaterRemovalMesh, setSceneRenderSettings, updateSceneWater,
} from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, createWaterMaterialDocument, lowerMaterialDocument, materialPinDefaultPropertyKey, type MaterialDocument } from "@haptic/shader-graph";
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

/** Unlit water that shows only what lies below it, unbent: Water Scene Color with Refraction 0 into Emissive. */
function windowDocument(): MaterialDocument {
  const doc = createDefaultMaterialDocument("Window");
  doc.shadingModel = "unlit";
  doc.blendMode = "translucent";
  doc.edges = doc.edges.filter((edge) => edge.targetNodeId !== "output");
  const output = doc.nodes.find((node) => node.id === "output")!.properties;
  output[materialPinDefaultPropertyKey("baseColor")] = [0, 0, 0];
  // Just under 1, so it blends and reads the scene copy (a constant 1 compiles opaque).
  output[materialPinDefaultPropertyKey("opacity")] = [0.99];
  doc.nodes.push(
    { id: "scene", type: "input.waterSceneColor", position: { x: 0, y: 0 }, properties: {} },
    { id: "flat", type: "const.float", position: { x: -200, y: 0 }, properties: { value: [0] } },
  );
  doc.edges.push(
    { id: "unbent", sourceNodeId: "flat", sourcePinId: "out", targetNodeId: "scene", targetPinId: "refraction" },
    { id: "below", sourceNodeId: "scene", sourcePinId: "color", targetNodeId: "output", targetPinId: "emissive" },
  );
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
    // One depth buffer across rendering groups, as the editor's scenes keep it: the water's scene copy needs it.
    configureEditorRenderingGroups(scene);
    scene.clearColor = new Color4(1, 0, 1, 1);
    // Fog far beyond the water, so every program compiles its fog (Water Reflection's haze reads it) and no pixel changes.
    scene.fogMode = Scene.FOGMODE_LINEAR;
    scene.fogStart = 400;
    scene.fogEnd = 800;
    const camera = new FreeCamera("camera", new Vector3(0, 8, -6), scene);
    camera.setTarget(Vector3.Zero());
    camera.minZ = 0.1;
    camera.maxZ = 50;
    scene.activeCamera = camera;
    const shadows = normalizeShadowSettings({ cascades: 1, maxLocalLights: 0 });
    setSceneRenderSettings(scene, { mode: "pbr", quality: normalizeRenderingQuality({}), shadows });
    const sun = new DirectionalLight("sun", new Vector3(0.2, -1, 0.3), scene);
    sun.intensity = 1.5;
    const graph = new ForwardSceneFrameGraph(scene);
    const draw = async (frames = 1) => {
      for (let frame = 0; frame < frames; frame++) {
        // Each draw is a new render: water picks its removal volumes once per render.
        scene.incrementRenderId();
        updateSceneWater(scene);
        await graph.prepare(camera);
        engine.beginFrame();
        try { graph.render(camera, false); } finally { engine.endFrame(); }
      }
      const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
      return toRgbaPixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), order);
    };
    const centre = new Vector3(1.5, 0, 0);
    const captures: { material: string; cut: boolean; pixels: number[] }[] = [];
    for (const kind of MATERIALS) {
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
    // The water starter, lit by HapticLightingBlock: every water node compiles and draws on this backend, and in the
    // scene effects' geometry pass, which it leaves its normal and reflectivity out of. Medium, the default tier, skips
    // Real-Time Reflections.
    setSceneRenderSettings(scene, {
      mode: "pbr", shadows, effects: normalizeRenderEffectsSettings({ ambientOcclusion: { enabled: true }, reflections: { enabled: true } }),
      quality: normalizeRenderingQuality({ postprocessing: { profile: "high", preset: "high" } }),
    });
    const starterPlan = lowerMaterialDocument(createWaterMaterialDocument("Starter"));
    if (!starterPlan.ok) throw new Error("The water starter did not lower");
    const starter = compileMaterialPlan(starterPlan.plan, { scene, name: "starter" });
    if (!starter.ok) throw new Error("The water starter did not compile");
    await starter.ready;
    const starterWater = createWaterMesh(scene, "starter water", normalizeWaterBody({ width: 8, length: 8, resolution: 32 }), createDefaultWaterDefinition(), starter.material);
    // It samples the view's scene copy, which the view plans once the water asks for it: a few frames.
    const starterPixels = await draw(6);
    const compiled = (engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects;
    const geometryEffects = Object.values(compiled).filter((effect) => /#define SLATE_WATER_EFFECTS_GEOMETRY/.test(effect.defines)).length;
    // It refracted through the view's scene copy.
    const starterCopied = Object.values(compiled).some((effect) => /#define SLATE_WATER_NODE_COPY/.test(effect.defines));
    starterWater.dispose();
    starter.dispose();
    // Dense fog over a floor below the water, all of it seen through the water: the copy holds the floor fogged once,
    // and the window water must draw it so, with the Material's own fog undone on it.
    setSceneRenderSettings(scene, { mode: "pbr", quality: normalizeRenderingQuality({}), shadows });
    Object.assign(scene, { fogStart: 0, fogEnd: 30, fogColor: new Color3(0.9, 0.9, 0.9) });
    const floor = MeshBuilder.CreateGround("floor", { width: 6, height: 6 }, scene);
    floor.position.y = -1;
    const floorMaterial = new StandardMaterial("floor", scene);
    floorMaterial.disableLighting = true;
    floorMaterial.emissiveColor = new Color3(0.1, 0.6, 0.2);
    floor.material = floorMaterial;
    const fogDirect = await draw(2);
    const windowPlan = lowerMaterialDocument(windowDocument());
    if (!windowPlan.ok) throw new Error("The window water did not lower");
    const glass = compileMaterialPlan(windowPlan.plan, { scene, name: "window" });
    if (!glass.ok) throw new Error("The window water did not compile");
    await glass.ready;
    const windowWater = createWaterMesh(scene, "window water", normalizeWaterBody({ width: 8, length: 8, resolution: 8 }), createDefaultWaterDefinition(), glass.material);
    const fogThrough = await draw(6);
    // The same at half the copy's resolution, where each copy texel averages four of the view's (the Default tier's copy
    // takes one filtered tap per texel).
    setSceneRenderSettings(scene, { mode: "pbr", quality: normalizeRenderingQuality({ water: { refractionScale: 0.5 } }), shadows });
    const fogThroughHalf = await draw(6);
    setSceneRenderSettings(scene, { mode: "pbr", quality: normalizeRenderingQuality({}), shadows });
    windowWater.dispose();
    glass.dispose();
    floor.dispose();
    floorMaterial.dispose();
    // A glint: 20% coverage of light three times brighter than white, which an 8-bit target would clip to a dim white.
    Object.assign(scene, { fogStart: 400, fogEnd: 800 });
    const glintDoc = waterDocument("translucent");
    const glintOutput = glintDoc.nodes.find((node) => node.id === "output")!.properties;
    // A display-space colour: about 3 in linear.
    glintOutput[materialPinDefaultPropertyKey("emissive")] = [1.65, 1.65, 1.65];
    glintOutput[materialPinDefaultPropertyKey("opacity")] = [0.2];
    const glintPlan = lowerMaterialDocument(glintDoc);
    if (!glintPlan.ok) throw new Error("The glint did not lower");
    const glint = compileMaterialPlan(glintPlan.plan, { scene, name: "glint" });
    if (!glint.ok) throw new Error("The glint did not compile");
    await glint.ready;
    const glintWater = createWaterMesh(scene, "glint water", normalizeWaterBody({ width: 8, length: 8, resolution: 8 }), createDefaultWaterDefinition(), glint.material);
    const glintPixels = await draw(2);
    glintWater.dispose();
    glint.dispose();
    // The removal volume's centre across the screen, by the view the draws used (columns read the same on either
    // backend's row order).
    const holeX = Vector3.Project(centre, Matrix.IdentityReadOnly, scene.getTransformMatrix(), camera.viewport.toGlobal(canvas.width, canvas.height)).x;
    const effects = (engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects;
    // Water's depth pre-pass draws its own program, which discards removed water and returns before the look.
    const prePassEffects = Object.values(effects).filter((effect) => /#define DEPTHPREPASS/.test(effect.defines) && /#define SLATE_WATER_SURFACE/.test(effect.defines)).length;
    graph.dispose();
    return {
      width: canvas.width, height: canvas.height, holeX, captures, prePassEffects, geometryEffects, starterPixels, starterCopied,
      fogDirect, fogThrough, fogThroughHalf, glintPixels,
    };
  } finally {
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
