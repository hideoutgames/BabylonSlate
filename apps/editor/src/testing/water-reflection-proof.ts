/**
 * Test-build-only proof of planar reflections on Custom Material water: a red pole standing in a lake, mirrored by a
 * graph Material's Water Reflection node at Planar quality and not at Sky quality, on the real GPU through the Forward
 * FrameGraph.
 */
import { Color3, Color4, Engine, FreeCamera, MeshBuilder, Scene, StandardMaterial, Vector3, type AbstractEngine, type Material } from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeRenderingQuality, normalizeShadowSettings, normalizeWaterBody, type WaterReflectionMode } from "@haptic/core";
import { compileMaterialPlan, createAppWebGpuEngine, createWaterMesh, setSceneRenderSettings, updateSceneWater } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument, materialPinDefaultPropertyKey } from "@haptic/shader-graph";
import { retainWaterPlanarReflections } from "../../../../packages/render/src/water-planar-reflection";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

/** Unlit water that shows only what Water Reflection mirrors. */
async function reflectionMaterial(scene: Scene): Promise<{ material: Material; dispose: () => void }> {
  const doc = createDefaultMaterialDocument("Mirror");
  doc.shadingModel = "unlit";
  doc.edges = doc.edges.filter((edge) => edge.targetNodeId !== "output");
  doc.nodes.find((node) => node.id === "output")!.properties[materialPinDefaultPropertyKey("baseColor")] = [0, 0, 0];
  doc.nodes.push({ id: "reflection", type: "input.waterReflection", position: { x: 0, y: 0 }, properties: {} });
  doc.edges.push({ id: "mirror", sourceNodeId: "reflection", sourcePinId: "color", targetNodeId: "output", targetPinId: "emissive" });
  const lowered = lowerMaterialDocument(doc);
  if (!lowered.ok) throw new Error("The mirror Material did not lower");
  const compiled = compileMaterialPlan(lowered.plan, { scene, name: "mirror" });
  if (!compiled.ok) throw new Error("The mirror Material did not compile");
  await compiled.ready;
  return { material: compiled.material, dispose: compiled.dispose };
}

export async function runWaterReflectionProof(backend: "webgl2" | "webgpu" = "webgl2") {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 64;
  document.getElementById("root")!.append(canvas);
  const engine: AbstractEngine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  const order = readbackChannelOrder(engine.isWebGPU);
  const scene = new Scene(engine);
  const release = retainWaterPlanarReflections(scene);
  try {
    scene.clearColor = new Color4(0.05, 0.05, 0.08, 1);
    const camera = new FreeCamera("camera", new Vector3(0, 3, -10), scene);
    camera.setTarget(new Vector3(0, 0, 4));
    camera.minZ = 0.1;
    camera.maxZ = 60;
    scene.activeCamera = camera;
    const settings = (reflections: WaterReflectionMode) => setSceneRenderSettings(scene, {
      mode: "pbr", quality: normalizeRenderingQuality({ water: { reflections } }), shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 0 }),
    });
    const pole = MeshBuilder.CreateBox("pole", { width: 1, height: 4, depth: 1 }, scene);
    pole.position.set(0, 2, 6);
    const red = new StandardMaterial("red", scene);
    red.disableLighting = true;
    red.emissiveColor = new Color3(1, 0, 0);
    pole.material = red;
    const graph = new ForwardSceneFrameGraph(scene);
    const draw = async () => {
      // The mirror is requested by the water's first draws and drawn from the next renders.
      for (let frame = 0; frame < 8; frame++) {
        scene.incrementRenderId();
        updateSceneWater(scene);
        await graph.prepare(camera);
        engine.beginFrame();
        try { graph.render(camera, false); } finally { engine.endFrame(); }
      }
      const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
      return toRgbaPixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), order);
    };
    const water = { ...createDefaultWaterDefinition(), objectReflections: true };
    const body = normalizeWaterBody({ width: 30, length: 30, resolution: 16 });
    const mirror = await reflectionMaterial(scene);
    const captures: { reflections: WaterReflectionMode; pixels: number[] }[] = [];
    const lake = createWaterMesh(scene, "graph lake", body, water, mirror.material);
    for (const reflections of ["planar", "sky"] as const) {
      settings(reflections);
      captures.push({ reflections, pixels: await draw() });
    }
    lake.dispose();
    graph.dispose();
    mirror.dispose();
    return { width: canvas.width, height: canvas.height, captures };
  } finally {
    release();
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
