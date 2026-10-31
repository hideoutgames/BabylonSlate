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
import { normalizeRenderEffectsSettings, normalizeRenderingQuality, type AntiAliasingMode } from "@haptic/core";
import { createAppWebGpuEngine, setSceneRenderSettings } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { managedRenderReservations } from "@haptic/render/managed-render-resources";
import { allowSceneScreenShadows, sceneMultisampleCount } from "../../../../packages/render/src/render-settings";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

const WIDTH = 96;
const HEIGHT = 64;

/** One configuration's frames: two consecutive captures of a static camera and the scene pass's sample count. */
export type AntiAliasingCapture = { label: string; samples: number; first: number[]; second: number[] };

/**
 * A static camera over white unlit panels with long diagonal edges on black, drawn as a world view at each
 * Anti-Aliasing mode, directly (no post effects) and through a settings chain (a vignette): two consecutive frames each.
 */
export async function runAntiAliasingProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  engine.setSize(WIDTH, HEIGHT);
  const captures: AntiAliasingCapture[] = [];
  try {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);
    const camera = new FreeCamera("Anti-Aliasing Camera", new Vector3(0, 0, -6), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    // A world view's Scene: only it follows the tier's Anti-Aliasing.
    allowSceneScreenShadows(scene, () => false);
    const material = new PBRMaterial("Anti-Aliasing White", scene);
    material.unlit = true;
    material.albedoColor = new Color3(1, 1, 1);
    const panel = MeshBuilder.CreatePlane("Anti-Aliasing Panel", { width: 3, height: 3 }, scene);
    panel.rotation.z = 0.35;
    panel.position.x = -1.6;
    panel.material = material;
    const triangle = MeshBuilder.CreateDisc("Anti-Aliasing Triangle", { radius: 1.2, tessellation: 3 }, scene);
    triangle.position.set(1.8, 0.2, 0);
    triangle.material = material;
    const graph = new ForwardSceneFrameGraph(scene);
    const apply = async (antiAliasing: AntiAliasingMode, chain: boolean) => {
      const effects = normalizeRenderEffectsSettings(chain ? { vignette: { enabled: true, weight: 0.01 } } : undefined);
      setSceneRenderSettings(scene, { mode: "pbr", effects, quality: normalizeRenderingQuality({ postprocessing: { antiAliasing } }) });
      const deadline = performance.now() + 15_000;
      await graph.prepare(camera);
      while (!graph.readiness(camera).ready) {
        if (performance.now() > deadline) throw new Error("Anti-aliasing readiness timed out");
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
    };
    const frame = async () => {
      const deadline = performance.now() + 15_000;
      for (;;) {
        engine.beginFrame();
        let rendered: boolean;
        try {
          rendered = graph.render(camera, false).rendered !== false;
        } finally {
          engine.endFrame();
        }
        if (rendered) break;
        if (performance.now() > deadline) throw new Error("Anti-aliasing presentation timed out");
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
        await graph.prepare(camera);
      }
      const pixels = await engine.readPixels(0, 0, WIDTH, HEIGHT);
      return toRgbaPixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), readbackChannelOrder(engine.isWebGPU));
    };
    try {
      for (const [label, mode, chain] of [
        ["off", "off", false], ["msaa4", "msaa4", false], ["msaa2", "msaa2", false],
        ["chain off", "off", true], ["chain msaa4", "msaa4", true], ["off again", "off", false],
      ] as const) {
        await apply(mode, chain);
        await frame();
        const first = await frame();
        const second = await frame();
        captures.push({ label, samples: sceneMultisampleCount(scene), first, second });
      }
    } finally {
      graph.dispose();
      await graph.whenReleased();
      scene.dispose();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      engine.beginFrame();
      engine.endFrame();
    }
    return { width: WIDTH, captures, reservations: managedRenderReservations(engine) };
  } finally {
    engine.dispose();
    canvas.remove();
  }
}
