import {
  Color3,
  Color4,
  Engine,
  FreeCamera,
  HemisphericLight,
  MeshBuilder,
  Quaternion,
  PBRMaterial,
  RawTexture,
  Scene,
  Texture,
  Vector3,
} from "@babylonjs/core";
import {
  createDefaultWaterDefinition, normalizeRenderEffectsSettings, normalizeRenderingQuality, normalizeWaterBody, type AntiAliasingMode,
} from "@haptic/core";
import {
  builtInWaterMaterial, compileMaterialPlan, configureEditorRenderingGroups, createAppWebGpuEngine, createWaterMesh,
  setSceneRenderSettings, setSceneWaterTime,
} from "@haptic/render";
import { createDefaultMaterialDocument, lowerMaterialDocument, materialPinDefaultPropertyKey } from "@haptic/shader-graph";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { managedRenderReservations } from "@haptic/render/managed-render-resources";
import { allowSceneScreenShadows, sceneMultisampleCount } from "../../../../packages/render/src/render-settings";
import { setUnlitMaterial } from "../../../../packages/render/src/unlit-material";
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
    // An alpha-tested quad: a 4 × 4 texture opaque in its centre 2 × 2, filtered, cut at 0.5, so every edge it shows
    // is an alpha-test edge inside the quad.
    const alpha = new Uint8Array(4 * 4 * 4).fill(255);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) alpha[(y * 4 + x) * 4 + 3] = x > 0 && x < 3 && y > 0 && y < 3 ? 255 : 0;
    const cutout = RawTexture.CreateRGBATexture(alpha, 4, 4, scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
    cutout.hasAlpha = true;
    const quad = MeshBuilder.CreatePlane("Anti-Aliasing Cutout", { size: 4 }, scene);
    quad.rotation.z = 0.35;
    setUnlitMaterial(quad, { textured: true, backFaceCulling: false, fog: false, role: "world" }, {
      texture: cutout, color: [1, 1, 1], alpha: 1, cutoff: 0.5, blend: false, textureAlpha: true, twoSided: false,
    });
    const show = (cutoutOnly: boolean) => {
      panel.setEnabled(!cutoutOnly);
      triangle.setEnabled(!cutoutOnly);
      quad.setEnabled(cutoutOnly);
    };
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
      for (const [label, mode, chain, cutoutOnly] of [
        ["off", "off", false, false], ["msaa4", "msaa4", false, false], ["msaa2", "msaa2", false, false],
        ["chain off", "off", true, false], ["chain msaa4", "msaa4", true, false],
        ["cutout off", "off", false, true], ["cutout msaa4", "msaa4", false, true], ["off again", "off", false, false], ["msaa4 last", "msaa4", false, false],
      ] as const) {
        show(cutoutOnly);
        await apply(mode, chain);
        await frame();
        const first = await frame();
        const second = await frame();
        captures.push({ label, samples: sceneMultisampleCount(scene), first, second });
      }
    } finally {
      graph.dispose();
      // WebGPU destroys disposed targets at the end of its next frame, which the release waits for from a microtask on.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      engine.beginFrame();
      engine.endFrame();
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

/** A rough graph Material of one colour, drawn with the light block. */
async function matte(scene: Scene, name: string, color: Color3, roughness = 1) {
  const doc = createDefaultMaterialDocument(name);
  doc.nodes.find((node) => node.id === "baseColor")!.properties.value = [color.r, color.g, color.b];
  doc.nodes.find((node) => node.id === "output")!.properties[materialPinDefaultPropertyKey("roughness")] = [roughness];
  const lowered = lowerMaterialDocument(doc);
  if (!lowered.ok) throw new Error(`${name} did not lower`);
  const compiled = compileMaterialPlan(lowered.plan, { scene, name });
  if (!compiled.ok) throw new Error(`${name} did not compile`);
  await compiled.ready;
  return compiled.material;
}

/**
 * Silhouettes over effects that read depth: a lit pier and boxes over a smooth floor and still water, with Ambient
 * Occlusion and Real-Time Reflections on, drawn by a world view at MSAA Off and 4x. MSAA changes only edge pixels when
 * every reader's depth matches the resolved colour; a halo shows as changed pixels beside the silhouettes.
 */
export async function runAntiAliasingHaloProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  engine.setSize(WIDTH, HEIGHT);
  const captures: { label: string; samples: number; pixels: number[] }[] = [];
  try {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.55, 0.7, 0.9, 1);
    configureEditorRenderingGroups(scene);
    allowSceneScreenShadows(scene, () => false);
    const camera = new FreeCamera("Halo Camera", new Vector3(0, 3, -7), scene);
    camera.rotationQuaternion = Quaternion.FromEulerAngles(0.42, 0, 0);
    camera.minZ = 0.1;
    camera.maxZ = 100;
    scene.activeCamera = camera;
    new HemisphericLight("Halo Sky", new Vector3(0.3, 1, -0.2), scene);
    const floor = MeshBuilder.CreateBox("Halo Floor", { width: 10, height: 0.2, depth: 10 }, scene);
    floor.material = await matte(scene, "Halo Floor", new Color3(0.9, 0.12, 0.08), 0.2);
    floor.position.y = -1.2;
    const grey = await matte(scene, "Halo Grey", new Color3(0.8, 0.8, 0.8));
    const pier = MeshBuilder.CreateBox("Halo Pier", { width: 1, height: 3, depth: 1 }, scene);
    pier.material = grey;
    pier.position.set(1.5, 0, 1);
    const crate = MeshBuilder.CreateBox("Halo Crate", { size: 0.8 }, scene);
    crate.material = grey;
    crate.rotation.y = 0.5;
    crate.position.set(-1.8, -0.7, -1);
    createWaterMesh(scene, "Halo Lake", normalizeWaterBody({ width: 4, length: 4, resolution: 16 }),
      { ...createDefaultWaterDefinition(), waveHeight: 0, swellHeight: 0, detailWaves: 0, refraction: 0.35 }, builtInWaterMaterial(scene));
    setSceneWaterTime(scene, 0);
    const effects = normalizeRenderEffectsSettings({ ambientOcclusion: { enabled: true }, reflections: { enabled: true } });
    const graph = new ForwardSceneFrameGraph(scene);
    const read = async () => {
      const pixels = await engine.readPixels(0, 0, WIDTH, HEIGHT);
      return toRgbaPixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), readbackChannelOrder(engine.isWebGPU));
    };
    try {
      for (const antiAliasing of ["off", "msaa4"] as const) {
        setSceneRenderSettings(scene, { mode: "pbr", effects, quality: normalizeRenderingQuality({ postprocessing: { antiAliasing } }) });
        const deadline = performance.now() + 30_000;
        await graph.prepare(camera);
        for (let drawn = 0; drawn < 3;) {
          if (performance.now() > deadline) throw new Error("Halo presentation timed out");
          engine.beginFrame();
          try {
            if (graph.render(camera, false).rendered !== false) drawn++;
          } finally {
            engine.endFrame();
          }
          if (drawn < 3) await new Promise<void>((resolve) => setTimeout(resolve, 16));
        }
        captures.push({ label: antiAliasing, samples: sceneMultisampleCount(scene), pixels: await read() });
      }
      return { width: WIDTH, captures, tasks: graph.taskNames() };
    } finally {
      graph.dispose();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      engine.beginFrame();
      engine.endFrame();
      await graph.whenReleased();
      scene.dispose();
    }
  } finally {
    engine.dispose();
    canvas.remove();
  }
}
