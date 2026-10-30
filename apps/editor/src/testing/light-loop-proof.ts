/**
 * Test-build-only measurement of the light block's per-pixel light loops on the real GPU, through the Forward
 * FrameGraph: the Feature Test's lights grid (48 unshadowed point lights 3 m apart, 4.5 m range) under the camera's
 * view, drawn with `HAPTIC_LIGHT_LOOP_PROOF` (`setHapticLightLoopProof`), so each floor pixel shows how many point and
 * spot lights its loops visited, how many of those were in range, and how many its light cluster lists
 * (`light-clusters.ts`). Sample pixels are picked on the CPU to count the
 * admitted lights that reach them independently of the shader. Light culling is judged by the gap between the two.
 * `runLightCullingParity` draws the same view lit, with and without the clusters (`setHapticLightCulling`), and times both.
 */
import { Color4, Engine, FreeCamera, MeshBuilder, PointLight, Scene, Vector3, type AbstractEngine, type Mesh } from "@babylonjs/core";
import { normalizeRenderingQuality, normalizeShadowSettings, type RenderMode } from "@haptic/core";
import { applyAuthoredLightProperties, compileMaterialPlan, createAppWebGpuEngine, setSceneRenderSettings } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { setHapticLightLoopProof } from "../../../../packages/render/src/haptic-lighting-block";
import { setHapticLightCulling } from "../../../../packages/render/src/haptic-lights";
import { isForwardLightExcluded } from "../../../../packages/render/src/light-policy";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

const COLUMNS = 8;
const ROWS = 6;
const SPACING = 3;
const HEIGHT = 1.2;
const RANGE = 4.5;
/** The device's point light maximum: the grid's 48 lights rank down to this many. */
const ADMITTED = 32;
/** Every SAMPLE_STEP-th pixel in each direction is picked on the CPU. */
const SAMPLE_STEP = 8;

/** Frames drawn for each timing. */
const TIMED_FRAMES = 30;

export async function runLightLoopProof(backend: "webgl2" | "webgpu" = "webgl2") {
  return lightsGrid(backend, true, async ({ scene, draw, settings, lights, floor, camera, engine, canvas }) => {
    const pbr = await draw();
    // The frame's admission (the nearest 32).
    const admitted = lights.filter((light) => light.isEnabled() && !isForwardLightExcluded(light));
    // The admitted lights reaching each sample pixel's floor point, counted on the CPU, at the pixel's centre.
    const samples: { pixel: number; reached: number }[] = [];
    for (let y = SAMPLE_STEP / 2; y < canvas.height; y += SAMPLE_STEP) {
      for (let x = SAMPLE_STEP / 2; x < canvas.width; x += SAMPLE_STEP) {
        const pick = scene.pick(x + 0.5, y + 0.5, (mesh) => mesh === floor, false, camera);
        if (!pick?.hit || !pick.pickedPoint) continue;
        const point = pick.pickedPoint;
        const row = engine.isWebGPU ? y : canvas.height - 1 - y;
        samples.push({
          pixel: row * canvas.width + x,
          reached: admitted.filter((light) => Vector3.DistanceSquared(light.position, point) < RANGE * RANGE).length,
        });
      }
    }
    settings("cel");
    const cel = await draw();
    return { width: canvas.width, height: canvas.height, lights: lights.length, admitted: admitted.length, pbr, cel, samples };
  });
}

/** The grid lit, PBR and CEL, with the clusters and without, and the mean frame time of each. */
export async function runLightCullingParity(backend: "webgl2" | "webgpu" = "webgl2") {
  return lightsGrid(backend, false, async ({ scene, draw, frame, settings }) => {
    const timed = async () => {
      await frame();
      const start = performance.now();
      for (let index = 0; index < TIMED_FRAMES; index++) await frame();
      return (performance.now() - start) / TIMED_FRAMES;
    };
    const result = { culled: { pbr: [] as number[], cel: [] as number[], ms: 0 }, unculled: { pbr: [] as number[], cel: [] as number[], ms: 0 } };
    for (const culled of [true, false]) {
      setHapticLightCulling(scene, culled);
      const target = culled ? result.culled : result.unculled;
      settings("pbr");
      target.pbr = (await draw()).rgba;
      target.ms = await timed();
      settings("cel");
      target.cel = (await draw()).rgba;
    }
    return result;
  });
}

type Grid = {
  scene: Scene; engine: AbstractEngine; canvas: HTMLCanvasElement; camera: FreeCamera; floor: Mesh; lights: PointLight[];
  settings: (mode: RenderMode) => void;
  /** One frame through the graph, finished by a one-pixel read. */
  frame: () => Promise<void>;
  /** One frame, read back: its RGBA bytes and the counts the proof writes. */
  draw: () => Promise<{ rgba: number[]; visited: number[]; reached: number[]; clustered: number[] }>;
};

async function lightsGrid<T>(backend: "webgl2" | "webgpu", proof: boolean, run: (grid: Grid) => Promise<T>): Promise<T> {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 100;
  document.getElementById("root")!.append(canvas);
  const engine: AbstractEngine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  const order = readbackChannelOrder(engine.isWebGPU);
  const scene = new Scene(engine);
  try {
    scene.clearColor = new Color4(0, 0, 0, 1);
    // The Feature Test's lights scene camera.
    const camera = new FreeCamera("camera", new Vector3(0, 16, -18), scene);
    camera.setTarget(new Vector3(0, 0, 6));
    camera.minZ = 0.1;
    camera.maxZ = 100;
    scene.activeCamera = camera;
    if (proof) setHapticLightLoopProof(scene);
    const settings = (mode: RenderMode) => setSceneRenderSettings(scene, {
      mode,
      quality: normalizeRenderingQuality({ lighting: { localLightMode: "manual", maxLocalLights: ADMITTED } }),
      shadows: normalizeShadowSettings({ enabled: false }),
    });
    settings("pbr");
    const lowered = lowerMaterialDocument(createDefaultMaterialDocument("floor"));
    if (!lowered.ok) throw new Error("The floor Material did not lower");
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: "floor" });
    if (!compiled.ok) throw new Error("The floor Material did not compile");
    await compiled.ready;
    const centerZ = ((ROWS - 1) * SPACING) / 2;
    const floor = MeshBuilder.CreateGround("floor", { width: COLUMNS * SPACING + 8, height: ROWS * SPACING + 8 }, scene);
    floor.position.z = centerZ;
    floor.material = compiled.material;
    const lights: PointLight[] = [];
    for (let index = 0; index < COLUMNS * ROWS; index++) {
      const column = index % COLUMNS;
      const row = Math.floor(index / COLUMNS);
      const light = new PointLight(`grid-${index}`, new Vector3((column - (COLUMNS - 1) / 2) * SPACING, HEIGHT, row * SPACING), scene);
      applyAuthoredLightProperties(light, { color: [1, 1, 1], intensity: 2.5, castShadows: false, range: RANGE });
      lights.push(light);
    }

    const graph = new ForwardSceneFrameGraph(scene);
    const render = async () => {
      await graph.prepare(camera);
      engine.beginFrame();
      try { graph.render(camera, false); } finally { engine.endFrame(); }
    };
    const frame = async () => {
      await render();
      await engine.readPixels(0, 0, 1, 1);
    };
    const draw = async () => {
      await render();
      const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
      const rgba = toRgbaPixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), order);
      // Per pixel, in readPixels' rows (WebGL2's bottom-up, WebGPU's top-down): the counts, 4/255 apart.
      const visited: number[] = [];
      const reached: number[] = [];
      const clustered: number[] = [];
      for (let index = 0; index < rgba.length; index += 4) {
        visited.push(Math.round(rgba[index]! / 4));
        reached.push(Math.round(rgba[index + 1]! / 4));
        clustered.push(Math.round(rgba[index + 2]! / 4));
      }
      return { rgba: Array.from(rgba), visited, reached, clustered };
    };
    try {
      return await run({ scene, engine, canvas, camera, floor, lights, settings, frame, draw });
    } finally {
      graph.dispose();
    }
  } finally {
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
