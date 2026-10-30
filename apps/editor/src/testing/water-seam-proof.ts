/**
 * Test-build-only proof of blended water seams on the real GPU: Global Water and an Ocean at the same height (FT_World's
 * sea and Ocean), drawn through the Forward FrameGraph in opaque unlit colours (Global green, the Ocean blue) over a
 * magenta background, from cameras near and far. Wherever neither body keeps its water the background shows; each view
 * is drawn twice, so a seam that changes between frames shows too.
 */
import { Color4, DirectionalLight, Engine, FreeCamera, Matrix, Scene, Vector3, type AbstractEngine } from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeRenderingQuality, normalizeShadowSettings, normalizeWaterBody } from "@haptic/core";
import { compileMaterialPlan, configureEditorRenderingGroups, createAppWebGpuEngine, createWaterMesh, setSceneRenderSettings, setSceneWaterTime, updateSceneWater } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument, materialPinDefaultPropertyKey } from "@haptic/shader-graph";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

/** From FT_World's own camera out to where the Global grid's cells are wider than the Ocean, looking at its west edge. */
const CAMERAS: ReadonlyArray<readonly [number, number, number]> = [[-4, 52, -82], [0, 100, -160], [0, 150, -250], [0, 300, -600], [0, 600, -700]];

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

export async function runWaterSeamProof(backend: "webgl2" | "webgpu" = "webgl2") {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 108;
  document.getElementById("root")!.append(canvas);
  const engine: AbstractEngine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  const order = readbackChannelOrder(engine.isWebGPU);
  const scene = new Scene(engine);
  try {
    configureEditorRenderingGroups(scene);
    scene.clearColor = new Color4(1, 0, 1, 1);
    const camera = new FreeCamera("camera", new Vector3(0, 50, -80), scene);
    camera.minZ = 0.5;
    camera.maxZ = 10000;
    scene.activeCamera = camera;
    setSceneRenderSettings(scene, { mode: "pbr", quality: normalizeRenderingQuality({}), shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 0 }) });
    new DirectionalLight("sun", new Vector3(0.2, -1, 0.3), scene);
    const green = await colour(scene, "global", [0.1, 0.8, 0.2]), blue = await colour(scene, "ocean", [0.1, 0.2, 0.9]);
    const water = createDefaultWaterDefinition();
    const global = createWaterMesh(scene, "global", normalizeWaterBody({}, "global"), water, green.material);
    global.position.set(0, -6, 0);
    const ocean = createWaterMesh(scene, "ocean", normalizeWaterBody({ width: 40, length: 80 }, "ocean"), water, blue.material);
    ocean.position.set(36, -6, 0);
    // The waves hold still, so anything that differs between a view's two draws is the seam itself.
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
    const views: { camera: readonly number[]; corners: number[][]; first: number[]; second: number[] }[] = [];
    for (const position of CAMERAS) {
      camera.position.set(position[0], position[1], position[2]);
      camera.setTarget(new Vector3(16, -6, 0));
      // The grids follow the camera and the blend settles over a few frames.
      for (let frame = 0; frame < 4; frame++) await draw();
      const first = await draw(), second = await draw();
      // The Ocean's corners in the read-back rows (WebGL reads bottom row first).
      const corners = [[16, -40], [56, -40], [16, 40], [56, 40]].map(([x, z]) => {
        const p = Vector3.Project(new Vector3(x!, -6, z!), Matrix.IdentityReadOnly, scene.getTransformMatrix(), camera.viewport.toGlobal(canvas.width, canvas.height));
        return [Math.round(p.x), engine.isWebGPU ? Math.round(p.y) : canvas.height - 1 - Math.round(p.y)];
      });
      views.push({ camera: position, corners, first, second });
    }
    graph.dispose();
    green.dispose(); blue.dispose();
    return { width: canvas.width, height: canvas.height, views };
  } finally {
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
