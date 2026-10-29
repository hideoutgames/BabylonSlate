/**
 * Test-build-only comparison of built-in water's two drawings on the real GPU, through the Forward FrameGraph, with
 * graph Materials on the lighting plan's block: `WaterMaterialPlugin` (a water mesh given no Material) and the graph
 * Material that replaces it (`builtInWaterMaterial`, the water starter). One still lake over a sand floor beside a red
 * pole, in a few scenarios that each exercise one part of the look: the sun from above over shallows, deep water, a
 * grazing view toward the horizon, a view toward the sun (its glints), linear fog, and an environment cube. Each scenario captures the scene without water, with the plugin and
 * with the graph Material; the spec reads how much of the frame each water covers and how far their pixels differ.
 */
import {
  Color3, Color4, DirectionalLight, Engine, FreeCamera, MeshBuilder, RawCubeTexture, Scene, StandardMaterial, Vector3, type AbstractEngine,
} from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeRenderingQuality, normalizeShadowSettings, normalizeWaterBody } from "@haptic/core";
import {
  builtInWaterMaterial, configureEditorRenderingGroups, createAppWebGpuEngine, createWaterMesh, setHapticLighting, setSceneRenderSettings, setSceneWaterTime,
  updateSceneWater,
} from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

const SCENARIOS = ["sun", "deep", "grazing", "glint", "fog", "environment"] as const;
type Scenario = (typeof SCENARIOS)[number];

/** A sky cube unlike the scene's clear colour, so what the water reflects of it shows: orange above, pale around, dark below. */
function skyCube(scene: Scene): RawCubeTexture {
  const size = 4, face = (r: number, g: number, b: number) => {
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) data.set([r, g, b, 255], i * 4);
    return data;
  };
  const side = face(250, 200, 130);
  // +x, -x, +y, -y, +z, -z.
  return new RawCubeTexture(scene, [side, side, face(240, 110, 40), face(40, 45, 50), side, side], size);
}

export async function runWaterTemplateProof(backend: "webgl2" | "webgpu" = "webgl2") {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 64;
  document.getElementById("root")!.append(canvas);
  const engine: AbstractEngine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  const order = readbackChannelOrder(engine.isWebGPU);
  // Graph Materials compile with the lighting plan's block, which built-in water's graph Material needs.
  setHapticLighting(engine, true);
  const scene = new Scene(engine);
  try {
    // One depth buffer across rendering groups, as the editor's scenes keep it: water's scene copy needs it.
    configureEditorRenderingGroups(scene);
    scene.clearColor = new Color4(0.55, 0.7, 0.9, 1);
    scene.fogColor = new Color3(0.7, 0.75, 0.8);
    const camera = new FreeCamera("camera", Vector3.Zero(), scene);
    camera.minZ = 0.1;
    camera.maxZ = 200;
    scene.activeCamera = camera;
    setSceneRenderSettings(scene, { mode: "pbr", quality: normalizeRenderingQuality({}), shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 0 }) });
    const sun = new DirectionalLight("sun", new Vector3(-0.3, -0.6, 0.75), scene);
    sun.intensity = 2;
    const floor = MeshBuilder.CreateGround("floor", { width: 60, height: 60 }, scene);
    floor.position.y = -0.8;
    const sand = new StandardMaterial("sand", scene);
    sand.diffuseColor = new Color3(0.76, 0.68, 0.5);
    floor.material = sand;
    const pole = MeshBuilder.CreateBox("pole", { width: 0.6, height: 4, depth: 0.6 }, scene);
    pole.position.set(1.5, 1.2, 6);
    const red = new StandardMaterial("red", scene);
    red.diffuseColor = new Color3(0.8, 0.1, 0.08);
    pole.material = red;
    const sky = skyCube(scene);
    const graph = new ForwardSceneFrameGraph(scene);
    const draw = async () => {
      // The water's scene copy and planar mirror are planned once the water asks for them: a few frames.
      for (let frame = 0; frame < 8; frame++) {
        scene.incrementRenderId();
        // A still surface, so both drawings shade the same water.
        setSceneWaterTime(scene, 0);
        updateSceneWater(scene);
        await graph.prepare(camera);
        engine.beginFrame();
        try { graph.render(camera, false); } finally { engine.endFrame(); }
      }
      const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
      return toRgbaPixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), order);
    };
    const body = normalizeWaterBody({ width: 30, length: 30, resolution: 32 });
    const view = (scenario: Scenario) => {
      if (scenario === "grazing") {
        camera.position.set(0, 1.2, -16);
        camera.setTarget(new Vector3(0, 0.6, 20));
      } else if (scenario === "glint") {
        // The sun stands beyond the far shore: its highlight lies on the water between.
        camera.position.set(0, 3, 14);
        camera.setTarget(new Vector3(0, 0, -6));
      } else {
        camera.position.set(0, 6, -14);
        camera.setTarget(new Vector3(0, 0, 4));
      }
      scene.fogMode = scenario === "fog" ? Scene.FOGMODE_LINEAR : Scene.FOGMODE_NONE;
      scene.fogStart = 4;
      scene.fogEnd = 40;
      scene.environmentTexture = scenario === "environment" ? sky : null;
      floor.position.y = scenario === "deep" ? -12 : -0.8;
    };
    const captures: { scenario: Scenario; water: "none" | "builtIn" | "graph"; material: string; pixels: number[] }[] = [];
    for (const scenario of SCENARIOS) {
      view(scenario);
      captures.push({ scenario, water: "none", material: "", pixels: await draw() });
      for (const water of ["builtIn", "graph"] as const) {
        const lake = createWaterMesh(scene, `${water} lake`, body, createDefaultWaterDefinition(), water === "graph" ? builtInWaterMaterial(scene) : null);
        captures.push({ scenario, water, material: lake.material?.getClassName() ?? "", pixels: await draw() });
        lake.dispose();
      }
    }
    graph.dispose();
    return { width: canvas.width, height: canvas.height, captures };
  } finally {
    setHapticLighting(engine, false);
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
