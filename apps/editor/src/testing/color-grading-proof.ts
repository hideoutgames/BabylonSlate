import {
  Color3,
  Color4,
  Engine,
  FreeCamera,
  HemisphericLight,
  MeshBuilder,
  PBRMaterial,
  Scene,
  Vector3,
  type AbstractEngine,
  type Camera,
} from "@babylonjs/core";
import { normalizeRenderEffectsSettings } from "@babylonslate/core";
import { compileMaterialPlan, createAppWebGpuEngine, setSceneRenderSettings } from "@babylonslate/render";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@babylonslate/shader-graph";
import { ForwardSceneFrameGraph } from "@babylonslate/render/framegraph-forward-scene";
import { sceneRenderingSettings, setSceneEffectsAssets } from "@babylonslate/render/render-settings";

const WIDTH = 64;
const HEIGHT = 32;

/** A 16-slice strip (256x16): blue picks the slice, red across, green down. */
async function lutPng(map: (r: number, g: number, b: number) => [number, number, number]): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 16;
  const context = canvas.getContext("2d")!;
  const image = context.createImageData(256, 16);
  for (let b = 0; b < 16; b++)
    for (let g = 0; g < 16; g++)
      for (let r = 0; r < 16; r++) {
        const index = (g * 256 + b * 16 + r) * 4;
        const [x, y, z] = map(r / 15, g / 15, b / 15);
        image.data.set([Math.round(x * 255), Math.round(y * 255), Math.round(z * 255), 255], index);
      }
  context.putImageData(image, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("LUT encode failed"))), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

async function createProofEngine(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  engine.setSize(WIDTH, HEIGHT);
  return { canvas, engine };
}

/** Prepare the graph, present two rendered frames and read back RGBA rows. */
async function presentPixels(
  engine: AbstractEngine,
  graph: ForwardSceneFrameGraph,
  camera: Camera,
  backend: "webgl2" | "webgpu",
  deadline: number,
): Promise<number[]> {
  await graph.prepare(camera);
  while (!graph.readiness(camera).ready) {
    if (performance.now() > deadline) throw new Error("Grading readiness timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
  }
  for (let presented = 0; presented < 2;) {
    engine.beginFrame();
    let rendered: boolean;
    try {
      rendered = graph.render(camera, false).rendered !== false;
    } finally {
      engine.endFrame();
    }
    if (rendered) presented++;
    else {
      if (performance.now() > deadline) throw new Error("Grading presentation timed out");
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
      await graph.prepare(camera);
    }
  }
  const pixels = await engine.readPixels(0, 0, WIDTH, HEIGHT);
  const result = Array.from(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
  if (backend === "webgpu" &&
    (navigator as Navigator & { gpu: { getPreferredCanvasFormat(): string } }).gpu.getPreferredCanvasFormat() === "bgra8unorm")
    for (let i = 0; i < result.length; i += 4) [result[i], result[i + 2]] = [result[i + 2]!, result[i]!];
  return result;
}

/** Release the graph and scene, then flush the engine's deferred work. */
async function disposeProofScene(engine: AbstractEngine, graph: ForwardSceneFrameGraph, scene: Scene) {
  graph.dispose();
  await graph.whenReleased();
  scene.dispose();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  engine.beginFrame();
  engine.endFrame();
}

/** Real LUT assets through the scene effects asset context. */
export async function runColorGradingProof(backend: "webgl2" | "webgpu") {
  const { canvas, engine } = await createProofEngine(backend);
  const textureBytes = new Map([
    ["identity", await lutPng((r, g, b) => [r, g, b])],
    ["invert", await lutPng((r, g, b) => [1 - r, 1 - g, 1 - b])],
  ]);
  const captures = [];
  try {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);
    const camera = new FreeCamera("Grading Camera", new Vector3(0, 0, -5), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    // Four unlit swatches across the frame cover each channel and a mid gray.
    [[0.9, 0.2, 0.1], [0.1, 0.8, 0.3], [0.2, 0.3, 0.9], [0.5, 0.5, 0.5]].forEach((rgb, i) => {
      const material = new PBRMaterial(`Swatch ${i}`, scene);
      material.unlit = true;
      material.albedoColor = new Color3(rgb[0]!, rgb[1]!, rgb[2]!);
      const swatch = MeshBuilder.CreatePlane(`Swatch ${i}`, { width: 2.2, height: 4 }, scene);
      swatch.position.x = -3.3 + i * 2.2;
      swatch.material = material;
    });
    setSceneEffectsAssets(scene, { textureBytes });
    const effects = normalizeRenderEffectsSettings(undefined);
    const settings = () => setSceneRenderSettings(scene, { mode: "pbr", effects });
    const graph = new ForwardSceneFrameGraph(scene);
    const draw = async () => {
      settings();
      const deadline = performance.now() + 15_000;
      // The LUT publishes once loaded; only then does the plan grade.
      const wanted = effects.colorGrading.enabled && effects.colorGrading.lutTextureGuid;
      while (wanted && textureBytes.has(wanted) && !sceneRenderingSettings(scene).effectsPlan?.imageProcessing?.colorGrading) {
        if (performance.now() > deadline) throw new Error("LUT load timed out");
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
      return presentPixels(engine, graph, camera, backend, deadline);
    };
    try {
      const off = await draw();
      effects.colorGrading = { enabled: true, lutTextureGuid: "identity" };
      const identity = await draw();
      effects.colorGrading = { enabled: true, lutTextureGuid: "invert" };
      const inverted = await draw();
      effects.colorPipeline.mode = "sceneLinear";
      const linearInverted = await draw();
      effects.colorPipeline.mode = "legacyDisplay";
      effects.colorGrading = { enabled: true, lutTextureGuid: "missing" };
      const missing = await draw();
      effects.colorGrading = { enabled: false, lutTextureGuid: "invert" };
      const disabled = await draw();
      captures.push({ off, identity, inverted, linearInverted, missing, disabled });
    } finally {
      await disposeProofScene(engine, graph, scene);
    }
    return { captures };
  } finally {
    engine.dispose();
    canvas.remove();
  }
}

/**
 * Authored lit and unlit surfaces and the clear color under Legacy Display and
 * each Scene Linear tone mapping. Four swatches span the frame's width; the
 * rows above and below them show the clear color.
 */
export async function runDisplayColorProof(backend: "webgl2" | "webgpu") {
  const { canvas, engine } = await createProofEngine(backend);
  const captures: Record<string, number[]> = {};
  try {
    const scene = new Scene(engine);
    // Display-space mid gray, like every authored color below.
    scene.clearColor = new Color4(0.5, 0.5, 0.5, 1);
    const camera = new FreeCamera("Display Camera", new Vector3(0, 0, -5), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    // Unit white light facing the swatches, without ground light or highlights.
    const light = new HemisphericLight("Display Light", new Vector3(0, 0, -1), scene);
    light.groundColor = new Color3(0, 0, 0);
    light.specular = new Color3(0, 0, 0);
    const authored = async (name: string, rgb: [number, number, number], shadingModel: "pbr" | "unlit") => {
      const document = createDefaultMaterialDocument(name);
      document.shadingModel = shadingModel;
      document.nodes.find((node) => node.id === "baseColor")!.properties.value = rgb;
      const lowered = lowerMaterialDocument(document);
      if (!lowered.ok) throw new Error(`${name} did not lower`);
      const compiled = compileMaterialPlan(lowered.plan, { scene, name });
      if (!compiled.ok || (await compiled.ready).some((diagnostic) => diagnostic.severity === "error"))
        throw new Error(`${name} did not compile`);
      return compiled.material;
    };
    // Babylon's own unlit PBR surface is the linear-pipeline control.
    const native = new PBRMaterial("Native Unlit Gray", scene);
    native.unlit = true;
    native.albedoColor = new Color3(0.5, 0.5, 0.5).toLinearSpace();
    const materials = [
      await authored("Lit Gray", [0.5, 0.5, 0.5], "pbr"),
      await authored("Lit Red", [0.9, 0.2, 0.1], "pbr"),
      await authored("Unlit Gray", [0.5, 0.5, 0.5], "unlit"),
      native,
    ];
    materials.forEach((material, i) => {
      const swatch = MeshBuilder.CreatePlane(`Display Swatch ${i}`, { width: 2.2, height: 3 }, scene);
      swatch.position.x = -3.3 + i * 2.2;
      swatch.material = material;
    });
    const effects = normalizeRenderEffectsSettings(undefined);
    const graph = new ForwardSceneFrameGraph(scene);
    const draw = () => {
      setSceneRenderSettings(scene, { mode: "pbr", effects });
      return presentPixels(engine, graph, camera, backend, performance.now() + 15_000);
    };
    try {
      captures.legacy = await draw();
      effects.colorPipeline.mode = "sceneLinear";
      for (const toneMapping of ["none", "standard", "aces", "neutral"] as const) {
        effects.toneMapping = toneMapping;
        captures[toneMapping] = await draw();
      }
    } finally {
      await disposeProofScene(engine, graph, scene);
    }
    return { width: WIDTH, height: HEIGHT, captures };
  } finally {
    engine.dispose();
    canvas.remove();
  }
}
