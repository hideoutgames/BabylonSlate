/** Test-build-only readback of the water scene copy a ForwardSceneFrameGraph view produces. */
import { Color3, Color4, Engine, FreeCamera, HemisphericLight, MeshBuilder, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import { createDefaultWaterDefinition, DEFAULT_RENDER_EFFECTS, normalizeWaterBody } from "@babylonslate/core";
import { createAppWebGpuEngine, createWaterMesh, setSceneRenderSettings, waterSceneCopyForPass } from "@babylonslate/render";
import { ForwardSceneFrameGraph } from "@babylonslate/render/framegraph-forward-scene";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

/** Half-float bits (as WebGPU may return them) to numbers. */
function fromHalf(bits: number): number {
  const exponent = (bits >> 10) & 0x1f, fraction = bits & 0x3ff, sign = bits & 0x8000 ? -1 : 1;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? Number.NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

export async function runWaterSceneCopyProof(backend: "webgl2" | "webgpu", pipeline: "legacyDisplay" | "sceneLinear" = "legacyDisplay") {
  const canvas = document.createElement("canvas");
  canvas.width = 96; canvas.height = 64;
  document.getElementById("root")!.append(canvas);
  // Match the app: exact sRGB conversions and large-world rendering.
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, {
    preserveDrawingBuffer: true, stencil: true, useLargeWorldRendering: true, useExactSrgbConversions: true,
  });
  const scene = new Scene(engine);
  try {
    // Play and the editor share one depth buffer across rendering groups.
    for (let group = 0; group < 4; group += 1) scene.setRenderingAutoClearDepthStencil(group, false);
    // Scene Linear adds a display stage: the copy then shares the chain's half-float scene targets.
    if (pipeline === "sceneLinear")
      setSceneRenderSettings(scene, { mode: "pbr", effects: { ...DEFAULT_RENDER_EFFECTS, colorPipeline: { version: 1, mode: "sceneLinear" } } });
    scene.clearColor = new Color4(0.3, 0.55, 0.85, 1);
    new HemisphericLight("light", Vector3.Up(), scene);
    const camera = new FreeCamera("camera", new Vector3(0, 0, -10), scene);
    camera.setTarget(Vector3.Zero());
    camera.minZ = 1; camera.maxZ = 100;
    scene.activeCamera = camera;
    // An unlit opaque wall over the left half of the view, ten units in front of the camera.
    const wall = MeshBuilder.CreatePlane("wall", { width: 20, height: 20 }, scene);
    wall.position.x = -10;
    const paint = new StandardMaterial("wall", scene);
    paint.disableLighting = true;
    paint.emissiveColor = new Color3(0.8, 0.4, 0.2);
    wall.material = paint;
    // Built-in water low in the view: drawn after the copy, so it never appears in it.
    const water = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 4, length: 2, resolution: 8 }), createDefaultWaterDefinition());
    water.position.set(0, -3, 0);
    const graph = new ForwardSceneFrameGraph(scene);
    const prepared = await graph.prepare(camera);
    // Output pixels on the middle row (either backend's row origin) of the wall and sky halves, as RGB.
    const order = readbackChannelOrder(engine.isWebGPU);
    const outputAt = (bytes: Uint8Array) => {
      const pixels = toRgbaPixels(bytes, order);
      const at = (x: number) => {
        const index = (Math.floor(canvas.height / 2) * canvas.width + x) * 4;
        return Array.from(pixels.slice(index, index + 3));
      };
      return { wall: at(Math.floor(canvas.width * 0.25)), sky: at(Math.floor(canvas.width * 0.75)) };
    };
    const frame = async () => {
      // Water's first frames create its fields; render until a frame draws on the graph path.
      for (let attempt = 0; attempt < 120; attempt += 1) {
        engine.beginFrame();
        let result: ReturnType<ForwardSceneFrameGraph["render"]>;
        try { result = graph.render(camera); } finally { engine.endFrame(); }
        if (result.path === "frameGraph" && result.rendered !== false) {
          // Read this frame's output before a later frame replaces WebGPU's canvas texture.
          const raw = await engine.readPixels(0, 0, canvas.width, canvas.height);
          return { result, output: outputAt(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)) };
        }
        if (result.path === "classic" && graph.readiness(camera).preparationRequired) await graph.prepare(camera);
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      throw new Error("The water scene copy view never drew a graph frame.");
    };
    const visible = await frame();
    const diagnostics = graph.waterSceneCopyDiagnostics();
    if (!diagnostics) throw new Error(`No water scene copy was planned: ${graph.taskNames().join(", ")}`);
    const entry = waterSceneCopyForPass(scene, diagnostics.renderPassId);
    const texture = entry?.texture.getInternalTexture();
    if (!entry || !texture) throw new Error("The transparent pass has no registered scene copy.");
    const raw = await engine._readTexturePixels(texture, texture.width, texture.height, -1, 0, null, true, false);
    const values = raw instanceof Uint16Array ? Array.from(raw, fromHalf) : Array.from(raw as Float32Array);
    // The wall/sky boundary is vertical: the middle row reads the same on either backend's texture origin.
    const texel = (x: number) => {
      const index = (Math.floor(texture.height / 2) * texture.width + x) * 4;
      return values.slice(index, index + 4);
    };
    const copy = {
      width: texture.width, height: texture.height, invSize: [...entry.invSize], scale: entry.scale,
      wall: texel(Math.floor(texture.width * 0.25)), sky: texel(Math.floor(texture.width * 0.75)),
    };
    const visibleWork = graph.waterSceneCopyDiagnostics()!;
    // Without visible water the direct path draws the same frame and no copy runs.
    water.setEnabled(false);
    const hidden = await frame();
    const hiddenWork = graph.waterSceneCopyDiagnostics()!;
    return {
      backend, pipeline, prepared, visibleResult: visible.result, hiddenResult: hidden.result, tasks: graph.taskNames(), copy,
      outputVisible: visible.output, outputHidden: hidden.output, visibleWork, hiddenWork,
    };
  } finally {
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
