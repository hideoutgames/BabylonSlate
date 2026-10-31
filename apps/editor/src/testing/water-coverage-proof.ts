/**
 * Test-build-only proof that blended water covers the whole frame on the real GPU: Global Water with an Ocean and a Lake
 * at its height out in the far field, where Global Water's grid cells are hundreds of metres wide, drawn through the
 * Forward FrameGraph in opaque unlit colours (Global green, the Ocean blue, the Lake cyan) over a magenta background, at
 * each Water Mesh Density. The cameras look down far enough that water fills the frame to its top edge, so any background
 * is a hole: a fragment no body keeps.
 */
import { Color4, DirectionalLight, Engine, FreeCamera, Scene, Vector3, type AbstractEngine } from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeRenderingQuality, normalizeShadowSettings, normalizeWaterBody } from "@haptic/core";
import { compileMaterialPlan, configureEditorRenderingGroups, createAppWebGpuEngine, createWaterMesh, setSceneRenderSettings, setSceneWaterTime, updateSceneWater } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument, materialPinDefaultPropertyKey } from "@haptic/shader-graph";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

const SEA = -6;
/** Camera positions and the point each looks at: the far neighbours sit in the frame's upper part. */
const CAMERAS: ReadonlyArray<{ position: readonly [number, number, number]; target: readonly [number, number, number] }> = [
  // Global Water's dense cells follow the camera's X/Z, so neighbours a few hundred metres away lie in its wide far
  // cells. Each camera looks down far enough that the frame's top edge still meets water.
  { position: [0, 34, 0], target: [0, SEA, 90] },
  { position: [0, 300, 200], target: [-40, SEA, 620] },
  { position: [300, 200, 100], target: [320, SEA, 420] },
  { position: [0, 600, 0], target: [100, SEA, 500] },
] target: readonly [number, number, number] }> = [
  // Each looks about 24 degrees down: the frame's top edge meets the water some 57 camera heights away.
  { position: [0, 34, 0], target: [0, SEA, 90] },
  { position: [-60, 34, -40], target: [-15, SEA, 32] },
  { position: [0, 80, -100], target: [0, SEA, 90] },
];

/** An opaque unlit Material of one colour. */
async function colour(scene: Scene, name: string, rgb: readonly number[]) {
  const doc = createDefaultMaterialDocument(name);
  doc.shadingModel = "unlit";
  doc.blendMode = "opaque";
  doc.edges = doc.edges.filter((edge) => edge.targetNodeId !== "output");
  const output = doc.nodes.find((node) => node.id === "output")!.properties;
  output[materialPinDefaultPropertyKey("baseColor")] = [0, 0, 0];
  output[materialPinDefaultPropertyKey("emissive")] = [...rgb];
  const lowered = lowerMaterialDocument(doc);
  if (!lowered.ok) throw new Error(`${name} did not lower`);
  const compiled = compileMaterialPlan(lowered.plan, { scene, name });
  if (!compiled.ok) throw new Error(`${name} did not compile`);
  await compiled.ready;
  return compiled;
}

export async function runWaterCoverageProof(backend: "webgl2" | "webgpu" = "webgl2", density: number = 1) {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  document.getElementById("root")!.append(canvas);
  const engine: AbstractEngine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  const order = readbackChannelOrder(engine.isWebGPU);
  const scene = new Scene(engine);
  try {
    configureEditorRenderingGroups(scene);
    scene.clearColor = new Color4(1, 0, 1, 1);
    const camera = new FreeCamera("camera", new Vector3(0, 34, 0), scene);
    camera.minZ = 0.5;
    camera.maxZ = 10000;
    scene.activeCamera = camera;
    setSceneRenderSettings(scene, {
      mode: "pbr",
      quality: normalizeRenderingQuality({ water: { meshDensity: density } }),
      shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 0 }),
    });
    new DirectionalLight("sun", new Vector3(0.2, -1, 0.3), scene);
    const green = await colour(scene, "global", [0.1, 0.8, 0.2]);
    const blue = await colour(scene, "ocean", [0.1, 0.2, 0.9]);
    const cyan = await colour(scene, "lake", [0.1, 0.8, 0.9]);
    const water = createDefaultWaterDefinition();
    const global = createWaterMesh(scene, "global", normalizeWaterBody({}, "global"), water, green.material);
    global.position.set(0, SEA, 0);
    // Far neighbours at Global Water's height, past its dense cells: an Ocean ahead and a Lake off to the side.
    const ocean = createWaterMesh(scene, "ocean", normalizeWaterBody({ width: 260, length: 160 }, "ocean"), water, blue.material);
    ocean.position.set(-40, SEA, 620);
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 180, length: 120, depth: 6 }, "lake"), water, cyan.material);
    lake.position.set(320, SEA, 420);
    // The waves hold still, so the frames compare.
    setSceneWaterTime(scene, 3);
    const graph = new ForwardSceneFrameGraph(scene);
    const draw = async () => {
      scene.incrementRenderId();
      updateSceneWater(scene);
      await graph.prepare(camera);
      engine.beginFrame();
      try { graph.render(camera, false); } finally { engine.endFrame(); }
      const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
      return toRgbaPixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), order);
    };
    const views: { camera: readonly number[]; pixels: number[] }[] = [];
    for (const { position, target } of CAMERAS) {
      camera.position.set(position[0], position[1], position[2]);
      camera.setTarget(new Vector3(target[0], target[1], target[2]));
      // The grids follow the camera and the blend settles over a few frames.
      for (let frame = 0; frame < 6; frame++) await draw();
      views.push({ camera: position, pixels: await draw() });
    }
    graph.dispose();
    green.dispose(); blue.dispose(); cyan.dispose();
    return { width: canvas.width, height: canvas.height, flipped: !engine.isWebGPU, views };
  } finally {
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
