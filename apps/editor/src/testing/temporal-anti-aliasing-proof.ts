import {
  Color3,
  Color4,
  Engine,
  FreeCamera,
  MeshBuilder,
  PBRMaterial,
  Scene,
  Vector3,
} from "@babylonjs/core";
import { normalizeRenderEffectsSettings } from "@babylonslate/core";
import { createAppWebGpuEngine, setSceneRenderSettings } from "@babylonslate/render";
import { ForwardSceneFrameGraph } from "@babylonslate/render/framegraph-forward-scene";
import { managedRenderReservations } from "@babylonslate/render/managed-render-resources";

const WIDTH = 96;
const HEIGHT = 64;

/** Jittered accumulation, history reprojection and retirement on both paths. */
export async function runTemporalAntiAliasingProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  engine.setSize(WIDTH, HEIGHT);
  const captures = [];
  try {
    for (const path of ["frameGraph", "classic"] as const) {
      const scene = new Scene(engine);
      scene.clearColor = new Color4(0, 0, 0, 1);
      const camera = new FreeCamera("Temporal Camera", new Vector3(0, 0, -6), scene);
      camera.setTarget(Vector3.Zero());
      scene.activeCamera = camera;
      if (path === "classic") scene.activeCameras = [camera];
      const material = new PBRMaterial("Temporal White", scene);
      material.unlit = true;
      material.albedoColor = new Color3(1, 1, 1);
      // A rotated panel gives long diagonal edges; the box is moved later.
      const panel = MeshBuilder.CreatePlane("Temporal Panel", { width: 3, height: 3 }, scene);
      panel.rotation.z = 0.35;
      panel.position.x = -1.6;
      panel.material = material;
      const box = MeshBuilder.CreatePlane("Temporal Box", { size: 1.2 }, scene);
      box.position.set(2, 0.6, 0);
      box.material = material;
      const effects = normalizeRenderEffectsSettings(undefined);
      const graph = new ForwardSceneFrameGraph(scene);
      const prepare = async () => {
        setSceneRenderSettings(scene, { mode: "pbr", effects });
        const deadline = performance.now() + 15_000;
        const prepared = await graph.prepare(camera);
        if (prepared.path !== path) throw new Error(`Expected ${path}: ${JSON.stringify(prepared)}`);
        while (!graph.readiness(camera).ready) {
          if (performance.now() > deadline) throw new Error("Temporal readiness timed out");
          await new Promise<void>((resolve) => setTimeout(resolve, 16));
        }
      };
      const frames = async (count: number, each?: () => void) => {
        const deadline = performance.now() + 15_000;
        for (let presented = 0; presented < count;) {
          each?.();
          engine.beginFrame();
          let rendered = false;
          try {
            rendered = graph.render(camera, false).rendered !== false;
          } finally {
            engine.endFrame();
          }
          if (rendered) presented++;
          else {
            if (performance.now() > deadline) throw new Error("Temporal presentation timed out");
            await new Promise<void>((resolve) => setTimeout(resolve, 16));
            await graph.prepare(camera);
          }
        }
      };
      const read = async () => {
        const pixels = await engine.readPixels(0, 0, WIDTH, HEIGHT);
        const result = Array.from(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
        if (backend === "webgpu" &&
          (navigator as Navigator & { gpu: { getPreferredCanvasFormat(): string } }).gpu.getPreferredCanvasFormat() === "bgra8unorm")
          for (let i = 0; i < result.length; i += 4) [result[i], result[i + 2]] = [result[i + 2]!, result[i]!];
        return result;
      };
      try {
        await prepare();
        await frames(2);
        const off = await read();
        effects.temporalAntiAliasing = { enabled: true, samples: 8, blend: 0.1 };
        await prepare();
        // Three jitter cycles converge the static history.
        await frames(24);
        const on = await read();
        await frames(1);
        const next = await read();
        const projection = camera.getProjectionMatrix().m.slice();
        const projectionRestored = () => projection.every((value, i) => value === camera.getProjectionMatrix().m[i]);
        // A teleported box must not leave a trail where it was.
        box.position.set(-0.2, -1.4, 0);
        await frames(12);
        const moved = await read();
        const restored = projectionRestored();
        const toggle = async (enabled: boolean) => {
          effects.temporalAntiAliasing = { ...effects.temporalAntiAliasing, enabled };
          await prepare();
          await frames(2);
        };
        await toggle(false);
        const movedReference = await read();
        await toggle(true);
        await frames(8);
        // Pan the camera every frame; the reprojected history follows it.
        await frames(16, () => { camera.position.x += 0.02; });
        const panned = await read();
        await toggle(false);
        const pannedReference = await read();
        captures.push({ path, off, on, next, moved, movedReference, panned, pannedReference, projectionRestored: restored });
      } finally {
        graph.dispose();
        await graph.whenReleased();
        scene.dispose();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        engine.beginFrame();
        engine.endFrame();
      }
    }
    return { width: WIDTH, captures, reservations: managedRenderReservations(engine) };
  } finally {
    engine.dispose();
    canvas.remove();
  }
}
