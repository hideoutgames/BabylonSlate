/**
 * Test-build-only proof of built-in water's graph Material (`builtInWaterMaterial`, the water starter) on the real GPU,
 * through the Forward FrameGraph, with graph Materials on the light block. One still lake over a sand
 * floor beside a red pole, in a few scenarios that each exercise one part of the look: the sun from above over
 * shallows, deep water, a grazing view toward the horizon, a view toward the sun (its glints), linear fog, and an
 * environment cube. Each scenario captures the scene without water and with it, and where each pixel's view ray meets
 * the lake's rest plane: its distance and how far inside the lake's edge it lies (both -1 where it misses the lake).
 */
import {
  Color3, Color4, DirectionalLight, Engine, FreeCamera, Matrix, MeshBuilder, RawCubeTexture, Scene, StandardMaterial, Vector3,
  type AbstractEngine,
} from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeRenderingQuality, normalizeShadowSettings, normalizeWaterBody } from "@haptic/core";
import {
  builtInWaterMaterial, configureEditorRenderingGroups, createAppWebGpuEngine, createWaterMesh, setSceneRenderSettings,
  setSceneWaterTime, updateSceneWater,
} from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

const SCENARIOS = ["sun", "deep", "grazing", "glint", "fog", "environment"] as const;
type Scenario = (typeof SCENARIOS)[number];
/** The lake's edge, centred on the origin at rest height zero. */
const LAKE = 30;
const FOG = { start: 4, end: 40, color: [0.7, 0.75, 0.8] };

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
  const scene = new Scene(engine);
  try {
    // One depth buffer across rendering groups, as the editor's scenes keep it: water's scene copy needs it.
    configureEditorRenderingGroups(scene);
    scene.clearColor = new Color4(0.55, 0.7, 0.9, 1);
    scene.fogColor = new Color3(FOG.color[0], FOG.color[1], FOG.color[2]);
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
        // A still surface, so every scenario shades the same water.
        setSceneWaterTime(scene, 0);
        updateSceneWater(scene);
        await graph.prepare(camera);
        engine.beginFrame();
        try { graph.render(camera, false); } finally { engine.endFrame(); }
      }
      const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
      return toRgbaPixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), order);
    };
    /**
     * Per pixel, in readPixels' rows (WebGL2's bottom-up, WebGPU's top-down): the distance along the view ray to the
     * lake's rest plane where it meets the lake in front of the pole, and how far inside the lake's edge, else -1.
     */
    const lakeHits = () => {
      const distances: number[] = [];
      const insets: number[] = [];
      for (let row = 0; row < canvas.height; row++) {
        const y = engine.isWebGPU ? row + 0.5 : canvas.height - row - 0.5;
        for (let column = 0; column < canvas.width; column++) {
          const ray = scene.createPickingRay(column + 0.5, y, Matrix.Identity(), camera);
          const distance = ray.direction.y < 0 ? -ray.origin.y / ray.direction.y : -1;
          const hit = ray.origin.add(ray.direction.scale(distance));
          const onLake = distance > 0 && Math.abs(hit.x) < LAKE / 2 && Math.abs(hit.z) < LAKE / 2;
          const pole = scene.pickWithRay(ray, (mesh) => mesh.name === "pole");
          const visible = onLake && !(pole?.hit && pole.distance < distance);
          distances.push(visible ? distance : -1);
          insets.push(visible ? LAKE / 2 - Math.max(Math.abs(hit.x), Math.abs(hit.z)) : -1);
        }
      }
      return { distances, insets };
    };
    const body = normalizeWaterBody({ width: LAKE, length: LAKE, resolution: 32 });
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
      scene.fogStart = FOG.start;
      scene.fogEnd = FOG.end;
      scene.environmentTexture = scenario === "environment" ? sky : null;
      floor.position.y = scenario === "deep" ? -12 : -0.8;
    };
    const captures: { scenario: Scenario; water: "none" | "graph"; material: string; pixels: number[] }[] = [];
    const distances: Partial<Record<Scenario, number[]>> = {};
    const insets: Partial<Record<Scenario, number[]>> = {};
    for (const scenario of SCENARIOS) {
      view(scenario);
      captures.push({ scenario, water: "none", material: "", pixels: await draw() });
      ({ distances: distances[scenario], insets: insets[scenario] } = lakeHits());
      const lake = createWaterMesh(scene, "lake", body, createDefaultWaterDefinition(), builtInWaterMaterial(scene));
      captures.push({ scenario, water: "graph", material: lake.material?.getClassName() ?? "", pixels: await draw() });
      lake.dispose();
    }
    graph.dispose();
    return {
      width: canvas.width, height: canvas.height, captures, distances: distances as Record<Scenario, number[]>,
      insets: insets as Record<Scenario, number[]>, fog: FOG,
      exactSrgb: engine.useExactSrgbConversions,
    };
  } finally {
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
