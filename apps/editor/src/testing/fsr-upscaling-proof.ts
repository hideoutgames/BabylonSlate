import {
  Color3, Color4, Engine, FreeCamera, MeshBuilder, PBRMaterial, Scene, Vector3,
} from "@babylonjs/core";
import { normalizeRenderEffectsSettings } from "@babylonslate/core";
import { createAppWebGpuEngine, setSceneRenderSettings } from "@babylonslate/render";
import { ForwardSceneFrameGraph } from "@babylonslate/render/framegraph-forward-scene";

const WIDTH = 128;
const HEIGHT = 64;

/** FSR 1 through the production FrameGraph chain, against a full-size frame. */
export async function runFsrUpscalingProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  engine.setSize(WIDTH, HEIGHT);
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 1);
  const camera = new FreeCamera("FSR Camera", new Vector3(0, 0, -5), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  // A rotated unlit card gives diagonal edges for the upscaler to reconstruct.
  const material = new PBRMaterial("FSR Card", scene);
  material.unlit = true;
  material.albedoColor = new Color3(0.9, 0.9, 0.9);
  const card = MeshBuilder.CreatePlane("FSR Card", { width: 3, height: 2 }, scene);
  card.rotation.z = Math.PI / 7;
  card.material = material;
  const effects = normalizeRenderEffectsSettings({ fxaa: true });
  const graph = new ForwardSceneFrameGraph(scene);
  const draw = async () => {
    setSceneRenderSettings(scene, { mode: "pbr", effects });
    const deadline = performance.now() + 15_000;
    const prepared = await graph.prepare(camera);
    if (prepared.path !== "frameGraph") throw new Error(`Expected frameGraph: ${JSON.stringify(prepared)}`);
    while (!graph.readiness(camera).ready) {
      if (performance.now() > deadline) throw new Error("FSR readiness timed out");
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
    }
    for (let presented = 0; presented < 2;) {
      engine.beginFrame();
      let rendered = false;
      try {
        rendered = graph.render(camera, false).rendered !== false;
      } finally {
        engine.endFrame();
      }
      if (rendered) presented++;
      else {
        if (performance.now() > deadline) throw new Error("FSR presentation timed out");
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
        await graph.prepare(camera);
      }
    }
    const pixels = await engine.readPixels(0, 0, WIDTH, HEIGHT);
    return Array.from(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
  };
  try {
    const reference = await draw();
    effects.upscaling = { enabled: true, renderScale: 0.5, sharpness: 0.2 };
    const upscaled = await draw();
    let error = 0, differing = 0, covered = 0, referenceCovered = 0;
    for (let i = 0; i < reference.length; i += 4) {
      const a = reference[i]!, b = upscaled[i]!;
      error += Math.abs(a - b);
      if (Math.abs(a - b) > 8) differing++;
      if (b > 128) covered++;
      if (a > 128) referenceCovered++;
    }
    const pixelCount = WIDTH * HEIGHT;
    return {
      effectiveBackend: engine.isWebGPU ? "webgpu" : (engine as Engine).webGLVersion === 2 ? "webgl2" : "webgl1",
      meanError: error / pixelCount,
      differingFraction: differing / pixelCount,
      coverageRatio: covered / Math.max(1, referenceCovered),
    };
  } finally {
    graph.dispose();
    await graph.whenReleased();
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
