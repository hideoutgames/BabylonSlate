import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Material } from "@babylonjs/core/Materials/material";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import {
  createDefaultRenderTargetCaptureProperties, createDefaultWaterDefinition, DEFAULT_RENDER_EFFECTS, normalizeRenderingQuality,
  normalizeShadowSettings, normalizeWaterBody, type RenderTargetCaptureQuality,
} from "@haptic/core";
import {
  applyAuthoredLightProperties, builtInWaterMaterial, compileMaterialPlan, configureEditorRenderingGroups, createAppWebGpuEngine,
  createWaterMesh, RenderTargetCaptures, setSceneWaterTime,
} from "@haptic/render";
import { managedRenderReservations } from "@haptic/render/managed-render-resources";
import { updateSceneRenderingSettings } from "@haptic/render/render-settings";
import { SceneRenderCoordinator } from "@haptic/render/scene-render-coordinator";
import {
  createDefaultMaterialDocument, lowerMaterialDocument, materialPinDefaultPropertyKey, type MaterialDocument,
} from "@haptic/shader-graph";
import { monitorMaterial } from "../lib/feature-test/rendering";

const QUALITIES: readonly RenderTargetCaptureQuality[] = ["fast", "highQuality", "fullQuality"];
type Backend = "webgl2" | "webgpu";

/** A rough graph Material of one colour, drawn with the light block. */
async function matte(scene: Scene, name: string, color: Color3): Promise<Material> {
  const doc = createDefaultMaterialDocument(name);
  doc.nodes.find((node) => node.id === "baseColor")!.properties.value = [color.r, color.g, color.b];
  doc.nodes.find((node) => node.id === "output")!.properties[materialPinDefaultPropertyKey("roughness")] = [1];
  const lowered = lowerMaterialDocument(doc);
  if (!lowered.ok) throw new Error(`${name} did not lower`);
  const compiled = compileMaterialPlan(lowered.plan, { scene, name });
  if (!compiled.ok) throw new Error(`${name} did not compile`);
  await compiled.ready;
  return compiled.material;
}

/** A graph Material from `doc`, sampling `textures` by guid. */
async function compileDocument(scene: Scene, doc: MaterialDocument, textures: Record<string, BaseTexture> = {}): Promise<Material> {
  const lowered = lowerMaterialDocument(doc);
  if (!lowered.ok) throw new Error(`${doc.name} did not lower`);
  const compiled = compileMaterialPlan(lowered.plan, {
    scene, name: doc.name, resolveTexture: (guid) => (textures[guid] as Texture | undefined) ?? null,
  });
  if (!compiled.ok) throw new Error(`${doc.name} did not compile`);
  await compiled.ready;
  return compiled.material;
}

/**
 * A scene view over a flat, still lake on a red bed, plus a capture of each
 * Quality with the view's exact lens, all rendered by the production
 * scene view (captures run inside its frame). Numeric primitives only.
 */
async function lakeHost(backend: Backend, size: number, boxes = 0) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  engine.setSize(size, size);
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.55, 0.7, 0.9, 1);
  configureEditorRenderingGroups(scene);
  updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality({ water: { profile: "high" } }) });
  const position = new Vector3(0, 3, -7);
  const rotation = Quaternion.FromEulerAngles(0.42, 0, 0);
  const camera = new FreeCamera("Main Camera", position.clone(), scene);
  camera.rotationQuaternion = rotation.clone();
  camera.fov = 50 * Math.PI / 180;
  camera.minZ = 0.1;
  camera.maxZ = 100;
  scene.activeCamera = camera;
  new HemisphericLight("Sky", new Vector3(0.3, 1, -0.2), scene);
  const bed = MeshBuilder.CreateBox("Bed", { width: 10, height: 0.2, depth: 10 }, scene);
  bed.material = await matte(scene, "Red Bed", new Color3(0.9, 0.12, 0.08));
  bed.position.y = -1.2;
  const pier = MeshBuilder.CreateBox("Pier", { width: 1, height: 3, depth: 1 }, scene);
  const grey = await matte(scene, "Grey Pier", new Color3(0.7, 0.7, 0.7));
  pier.material = grey;
  pier.position.set(1.5, 0, 1);
  for (let index = 0; index < boxes; index++) {
    const box = MeshBuilder.CreateBox(`Load ${index}`, { size: 0.4 }, scene);
    box.material = grey;
    box.position.set((index % 20) * 0.5 - 5, 0.6 + Math.floor(index / 20) * 0.5, 4 + (index % 3));
  }
  createWaterMesh(scene, "Lake", normalizeWaterBody({ width: 10, length: 10, resolution: 32 }),
    { ...createDefaultWaterDefinition(), waveHeight: 0, swellHeight: 0, detailWaves: 0, refraction: 0.35 }, builtInWaterMaterial(scene));
  // A still surface: both views shade the same water.
  setSceneWaterTime(scene, 0);
  const view = new SceneRenderCoordinator(scene);
  const captures = new RenderTargetCaptures(scene);
  captures.setAssets(
    new Map(QUALITIES.map((quality) => [quality, { mode: "SceneColor" as const, width: size, height: size }])),
    new Map(QUALITIES.map((quality) => [`${quality}Texture`, { renderTargetGuid: quality }])),
  );
  const lens = new Mesh("Lens", scene);
  lens.position.copyFrom(position);
  lens.rotationQuaternion = rotation.clone();
  const configure = (quality: RenderTargetCaptureQuality, enabled: boolean) => captures.configure(quality, {
    ...createDefaultRenderTargetCaptureProperties(), renderTargetGuid: quality, quality, enabled,
    fieldOfView: 50, nearClip: 0.1, farClip: 100,
  }, () => lens);
  const outputs = {} as Record<RenderTargetCaptureQuality, BaseTexture>;
  for (const quality of QUALITIES) outputs[quality] = captures.acquireTexture(`${quality}Texture`)!.resource;
  const frame = () => {
    engine.beginFrame();
    try { return view.render(); } finally { engine.endFrame(); }
  };
  const settle = async (ready: () => boolean, label: string) => {
    const deadline = performance.now() + 60_000;
    for (;;) {
      const result = frame();
      if (result.rendered && result.readyForPresentation && ready()) return;
      if (performance.now() > deadline) throw new Error(`${label} did not settle: ${JSON.stringify(captures.diagnostics())}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
    }
  };
  const dispose = async () => {
    captures.dispose();
    view.dispose();
    // WebGPU frees leases after its end-of-frame destruction drain: keep frames coming.
    let settled = false;
    const released = Promise.all([view.whenReleased(), captures.whenReleased()]).finally(() => { settled = true; });
    while (!settled) {
      engine.beginFrame();
      engine.endFrame();
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
    }
    await released;
    // The light block's lookup tables are the Scene's until it goes, at WebGPU's next end-of-frame drain.
    scene.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    engine.beginFrame();
    engine.endFrame();
    const retainedBytes = managedRenderReservations(engine).reservedBytes;
    engine.dispose();
    canvas.remove();
    return retainedBytes;
  };
  return { engine, scene, view, captures, outputs, configure, frame, settle, dispose };
}

async function readView(engine: AbstractEngine, backend: Backend, size: number): Promise<number[]> {
  const pixels = await engine.readPixels(0, 0, size, size);
  const values = Array.from(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
  if (backend === "webgl2") return values;
  // Babylon returns the canvas attachment's native channel order on WebGPU,
  // top row first; render-target readback is bottom row first on both backends.
  if ((engine.getCreationOptions() as { swapChainFormat?: string }).swapChainFormat === "bgra8unorm")
    for (let index = 0; index < values.length; index += 4) [values[index], values[index + 2]] = [values[index + 2]!, values[index]!];
  const rows: number[] = [];
  for (let row = size - 1; row >= 0; row--) rows.push(...values.slice(row * size * 4, (row + 1) * size * 4));
  return rows;
}

async function readCapture(texture: BaseTexture, size: number): Promise<number[]> {
  const pixels = await texture.readPixels(0, 0, null, true, false, 0, 0, size, size);
  if (!pixels) throw new Error("Capture returned no pixels.");
  return Array.from(pixels as Uint8Array);
}

/** Mean absolute RGB difference (0–255) over the image. */
function meanError(a: readonly number[], b: readonly number[]): number {
  let error = 0;
  for (let index = 0; index < a.length; index += 4)
    error += Math.abs(a[index]! - b[index]!) + Math.abs(a[index + 1]! - b[index + 1]!) + Math.abs(a[index + 2]! - b[index + 2]!);
  return error / (a.length / 4) / 3;
}

/**
 * How closely each capture matches the scene view's own image of the same
 * lens, with and without a settings effect chain (an identity vignette).
 */
export async function runRenderTargetQualityProof(backend: Backend) {
  const size = 96;
  const host = await lakeHost(backend, size);
  try {
    const cases: Record<string, Record<RenderTargetCaptureQuality, number> & { waterCopy: boolean }> = {};
    for (const [label, effects] of [["plain", DEFAULT_RENDER_EFFECTS], ["chain", { ...DEFAULT_RENDER_EFFECTS, vignette: { ...DEFAULT_RENDER_EFFECTS.vignette, enabled: true, weight: 0 } }]] as const) {
      // Fresh captures, so each case publishes only images drawn with its settings.
      for (const quality of QUALITIES) host.configure(quality, false);
      updateSceneRenderingSettings(host.scene, { effects, quality: normalizeRenderingQuality({ water: { profile: "high" } }) });
      for (const quality of QUALITIES) host.configure(quality, true);
      await host.settle(() => host.captures.diagnostics().every((entry) => entry.published), label);
      // Two more frames, so the published images are from the settled scene.
      host.frame(); host.frame();
      const reference = await readView(host.engine, backend, size);
      const errors = Object.fromEntries(await Promise.all(QUALITIES.map(async (quality) =>
        [quality, meanError(reference, await readCapture(host.outputs[quality], size))] as const)));
      cases[label] = {
        ...errors as Record<RenderTargetCaptureQuality, number>,
        waterCopy: host.captures.diagnostics().some((entry) => entry.quality === "fullQuality" && entry.waterSceneCopyPass !== null),
      };
    }
    return {
      effectiveBackend: host.engine.isWebGPU ? "webgpu" : "webgl2",
      cases,
      mainCameraPreserved: host.scene.activeCamera?.name === "Main Camera",
      retainedBytes: await host.dispose(),
    };
  } catch (error) {
    await host.dispose().catch(() => {});
    throw error;
  }
}

/** The subject's linear colour: bright enough that Exposure carries its red past Neutral's highlight shoulder. */
const MONITOR_SUBJECT = new Color3(0.9, 0.35, 0.05);

/**
 * In Scene Linear with Neutral tone mapping and a raised Exposure, how far a monitor in the scene view (the Feature
 * Test's monitor Material, sampling one capture of an unlit subject) is from the same subject seen directly beside
 * it: High Quality and Fast leave the screen effects to the scene view, which applies them once to both; Full
 * Quality's image carries them already, so the scene view applies them a second time. Mean RGB error (0–255) over a
 * patch of each.
 */
export async function runRenderTargetMonitorProof(backend: Backend) {
  const size = 96;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  engine.setSize(size, size);
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.1, 0.1, 0.12, 1);
  configureEditorRenderingGroups(scene);
  updateSceneRenderingSettings(scene, {
    mode: "pbr",
    effects: { ...DEFAULT_RENDER_EFFECTS, colorPipeline: { mode: "sceneLinear" }, toneMapping: "neutral", exposure: 1.5 },
  });
  const camera = new FreeCamera("Main Camera", new Vector3(0, 0, -5), scene);
  camera.rotationQuaternion = Quaternion.Identity();
  camera.fov = 50 * Math.PI / 180;
  camera.minZ = 0.1;
  camera.maxZ = 100;
  scene.activeCamera = camera;
  const subjectDoc = createDefaultMaterialDocument("Unlit Subject");
  subjectDoc.shadingModel = "unlit";
  subjectDoc.nodes.find((node) => node.id === "baseColor")!.properties.value = [MONITOR_SUBJECT.r, MONITOR_SUBJECT.g, MONITOR_SUBJECT.b];
  // A thin slab on the left; its front face fills each capture's frame.
  const subject = MeshBuilder.CreateBox("Subject", { width: 2, height: 2, depth: 0.2 }, scene);
  subject.material = await compileDocument(scene, subjectDoc);
  subject.position.set(-1.2, 0, 0);
  const view = new SceneRenderCoordinator(scene);
  const captures = new RenderTargetCaptures(scene);
  captures.setAssets(
    new Map(QUALITIES.map((quality) => [quality, { mode: "SceneColor" as const, width: 32, height: 32 }])),
    new Map(QUALITIES.map((quality) => [`${quality}Texture`, { renderTargetGuid: quality }])),
  );
  const lens = new Mesh("Lens", scene);
  lens.position.set(-1.2, 0, -1.1);
  lens.rotationQuaternion = Quaternion.Identity();
  const configure = (quality: RenderTargetCaptureQuality, enabled: boolean) => captures.configure(quality, {
    ...createDefaultRenderTargetCaptureProperties(), renderTargetGuid: quality, quality, enabled,
    fieldOfView: 40, nearClip: 0.1, farClip: 20,
  }, () => lens);
  const monitors: Partial<Record<RenderTargetCaptureQuality, Material>> = {};
  for (const quality of QUALITIES) {
    const texture = captures.acquireTexture(`${quality}Texture`)!.resource;
    const doc = monitorMaterial(`${quality} Monitor`, `${quality}Texture`) as unknown as MaterialDocument;
    monitors[quality] = await compileDocument(scene, doc, { [`${quality}Texture`]: texture });
  }
  // The plane's front faces -Z, toward the scene camera.
  const monitor = MeshBuilder.CreatePlane("Monitor", { size: 2 }, scene);
  monitor.position.set(1.2, 0, 0);
  const frame = () => {
    engine.beginFrame();
    try { return view.render(); } finally { engine.endFrame(); }
  };
  const settle = async (ready: () => boolean, label: string) => {
    const deadline = performance.now() + 60_000;
    for (;;) {
      const result = frame();
      if (result.rendered && result.readyForPresentation && ready()) return;
      if (performance.now() > deadline) throw new Error(`${label} did not settle: ${JSON.stringify(captures.diagnostics())}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
    }
  };
  /** An 8 × 8 patch centred on column `x` of the middle rows. */
  const patch = (pixels: readonly number[], x: number) => {
    const values: number[] = [];
    for (let row = size / 2 - 4; row < size / 2 + 4; row++)
      values.push(...pixels.slice((row * size + x - 4) * 4, (row * size + x + 4) * 4));
    return values;
  };
  // Projected centres of the subject and the monitor (x = ∓1.2 at 5 m, 50° lens).
  const offset = Math.round(1.2 / (5 * Math.tan(25 * Math.PI / 180)) * size / 2);
  const dispose = async () => {
    captures.dispose();
    view.dispose();
    let settled = false;
    const released = Promise.all([view.whenReleased(), captures.whenReleased()]).finally(() => { settled = true; });
    while (!settled) {
      engine.beginFrame();
      engine.endFrame();
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
    }
    await released;
    scene.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    engine.beginFrame();
    engine.endFrame();
    const retainedBytes = managedRenderReservations(engine).reservedBytes;
    engine.dispose();
    canvas.remove();
    return retainedBytes;
  };
  try {
    const cases = {} as Record<RenderTargetCaptureQuality, { monitorError: number; subject: number[]; monitor: number[] }>;
    for (const quality of QUALITIES) {
      for (const other of QUALITIES) configure(other, other === quality);
      monitor.material = monitors[quality]!;
      await settle(() => captures.diagnostics().some((entry) => entry.quality === quality && entry.published), quality);
      frame(); frame();
      const pixels = await readView(engine, backend, size);
      const subjectPatch = patch(pixels, size / 2 - offset), monitorPatch = patch(pixels, size / 2 + offset);
      cases[quality] = { monitorError: meanError(subjectPatch, monitorPatch), subject: subjectPatch.slice(0, 3), monitor: monitorPatch.slice(0, 3) };
    }
    return {
      effectiveBackend: engine.isWebGPU ? "webgpu" : "webgl2",
      cases,
      retainedBytes: await dispose(),
    };
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }
}

/** The capture's pose: over a pillar yard, far from where the scene camera starts. */
const SHADOW_LENS = { position: new Vector3(0, 7, -14), rotation: Quaternion.FromEulerAngles(0.45, 0.1, 0) };
/**
 * Where the scene camera starts: the same heading 200 m south of the lens, so
 * neither its cascades nor its single sun map (Low: 80 m around the camera)
 * reach the yard.
 */
const SHADOW_FAR_VIEW = new Vector3(0, 7, -214);

/**
 * A pillar yard on a pale ground under a shadowed sun, rendered by the
 * production scene view, with one Full Quality capture over the yard: graph
 * Materials drawn with the light block, shadows in its atlas. Numeric
 * primitives only.
 */
async function shadowHost(backend: Backend, size: number) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  engine.setSize(size, size);
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.55, 0.7, 0.9, 1);
  configureEditorRenderingGroups(scene);
  const camera = new FreeCamera("Main Camera", SHADOW_FAR_VIEW.clone(), scene);
  camera.rotationQuaternion = SHADOW_LENS.rotation.clone();
  camera.fov = 50 * Math.PI / 180;
  camera.minZ = 0.1;
  camera.maxZ = 100;
  scene.activeCamera = camera;
  new HemisphericLight("Sky", new Vector3(0, 1, 0), scene).intensity = 0.35;
  // Low and behind the yard, so long shadows fall toward the lens. The light block's diffuse divides by π.
  const sun = new DirectionalLight("Sun", new Vector3(0.35, -0.75, -0.8), scene);
  const sunIntensity = 1.4 * Math.PI;
  applyAuthoredLightProperties(sun, { intensity: sunIntensity, color: [1, 1, 1], castShadows: true });
  const ground = MeshBuilder.CreateGround("Ground", { width: 600, height: 600 }, scene);
  ground.material = await matte(scene, "Pale Ground", new Color3(0.85, 0.85, 0.8));
  const grey = await matte(scene, "Grey Pillar", new Color3(0.6, 0.6, 0.65));
  for (const [x, z, height] of [[-5, 4, 5], [-2, 7, 6], [1, 3, 4], [4, 6, 6], [7, 2, 5], [-7, 9, 6], [2, 10, 7]] as const) {
    const pillar = MeshBuilder.CreateBox(`Pillar ${x} ${z}`, { width: 1.2, height, depth: 1.2 }, scene);
    pillar.material = grey;
    pillar.position.set(x, height / 2, z);
  }
  const view = new SceneRenderCoordinator(scene);
  const captures = new RenderTargetCaptures(scene);
  captures.setAssets(new Map([["yard", { mode: "SceneColor", width: size, height: size }]]),
    new Map([["yardTexture", { renderTargetGuid: "yard" }]]));
  const lens = new Mesh("Lens", scene);
  lens.position.copyFrom(SHADOW_LENS.position);
  lens.rotationQuaternion = SHADOW_LENS.rotation.clone();
  const configure = (enabled: boolean) => captures.configure("yard", {
    ...createDefaultRenderTargetCaptureProperties(), renderTargetGuid: "yard", quality: "fullQuality", enabled,
    fieldOfView: 50, nearClip: 0.1, farClip: 100,
  }, () => lens);
  const output = captures.acquireTexture("yardTexture")!.resource;
  const frame = () => {
    engine.beginFrame();
    try { return view.render(); } finally { engine.endFrame(); }
  };
  const settle = async (ready: () => boolean, label: string) => {
    const deadline = performance.now() + 60_000;
    for (;;) {
      const result = frame();
      if (result.rendered && result.readyForPresentation && ready()) return;
      if (performance.now() > deadline) throw new Error(`${label} did not settle: ${JSON.stringify(captures.diagnostics())}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
    }
  };
  const dispose = async () => {
    captures.dispose();
    view.dispose();
    let settled = false;
    const released = Promise.all([view.whenReleased(), captures.whenReleased()]).finally(() => { settled = true; });
    while (!settled) {
      engine.beginFrame();
      engine.endFrame();
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
    }
    await released;
    // The scene view's own shadow maps are charged until the scene goes.
    scene.dispose();
    // The light block's lookup tables go at WebGPU's next end-of-frame drain.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    engine.beginFrame();
    engine.endFrame();
    const retainedBytes = managedRenderReservations(engine).reservedBytes;
    engine.dispose();
    canvas.remove();
    return retainedBytes;
  };
  return { engine, scene, camera, sun, sunIntensity, view, captures, output, configure, frame, settle, dispose };
}

/**
 * A Full Quality capture over a pillar yard far from the scene camera, against
 * the scene view's own image after its camera moves to the capture's pose and
 * lens: the sun shadows in view must be the ones that view draws. Cascaded and
 * single-map (Low) sun shadows, in the light block's atlas. `shadowContrast` is how much the reference
 * changes without sun shadows, so a match cannot come from shadows missing in both.
 */
export async function runRenderTargetShadowProof(backend: Backend) {
  const size = 96;
  const cases: Record<string, { fullQuality: number; shadowContrast: number }> = {};
  const shadowSettings = [
    ["cascaded", normalizeShadowSettings({ cascades: 2, distance: 50, mapSize: 1024 })],
    ["low", normalizeShadowSettings({ profile: "low" })],
  ] as const;
  const host = await shadowHost(backend, size);
  try {
    for (const [label, shadows] of shadowSettings) {
      updateSceneRenderingSettings(host.scene, { shadows });
      host.camera.position.copyFrom(SHADOW_FAR_VIEW);
      // A fresh capture, so it publishes only images drawn with this case's settings.
      host.configure(false);
      host.configure(true);
      await host.settle(() => host.captures.diagnostics().every((entry) => entry.published), `${label} capture`);
      host.frame(); host.frame();
      const capture = await readCapture(host.output, size);
      host.configure(false);
      host.camera.position.copyFrom(SHADOW_LENS.position);
      await host.settle(() => true, `${label} view at the capture pose`);
      host.frame(); host.frame();
      const reference = await readView(host.engine, backend, size);
      applyAuthoredLightProperties(host.sun, { intensity: host.sunIntensity, color: [1, 1, 1], castShadows: false });
      await host.settle(() => true, `${label} view without sun shadows`);
      host.frame(); host.frame();
      const unshadowed = await readView(host.engine, backend, size);
      applyAuthoredLightProperties(host.sun, { intensity: host.sunIntensity, color: [1, 1, 1], castShadows: true });
      cases[label] = {
        fullQuality: meanError(reference, capture), shadowContrast: meanError(reference, unshadowed),
      };
    }
    return {
      effectiveBackend: host.engine.isWebGPU ? "webgpu" : "webgl2",
      cases,
      mainCameraPreserved: host.scene.activeCamera === host.camera,
      retainedBytes: await host.dispose(),
    };
  } catch (error) {
    await host.dispose().catch(() => {});
    throw error;
  }
}

/**
 * Scene view frame time with no capture and with a capture of each Quality of
 * the same lens, each frame waited to GPU completion. The
 * difference from the baseline is the capture's cost on this device.
 */
export async function runRenderTargetQualityCost(backend: Backend, options: { size?: number; frames?: number; boxes?: number } = {}) {
  const size = options.size ?? 256, frames = options.frames ?? 90;
  const host = await lakeHost(backend, size, options.boxes ?? 200);
  const timed = async (label: string) => {
    for (let warm = 0; warm < 20; warm++) { host.frame(); await host.engine.readPixels(0, 0, 1, 1); }
    const samples: number[] = [];
    for (let index = 0; index < frames; index++) {
      const start = performance.now();
      host.frame();
      // Wait for the GPU, so the sample includes the frame's GPU work.
      await host.engine.readPixels(0, 0, 1, 1);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return { label, medianMs: samples[Math.floor(samples.length / 2)]!, meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length };
  };
  try {
    for (const quality of QUALITIES) host.configure(quality, false);
    await host.settle(() => true, "baseline");
    const baseline = await timed("none");
    const results = [baseline];
    for (const quality of QUALITIES) {
      for (const other of QUALITIES) host.configure(other, other === quality);
      await host.settle(() => host.captures.diagnostics().some((entry) => entry.published), quality);
      results.push(await timed(quality));
    }
    return {
      effectiveBackend: host.engine.isWebGPU ? "webgpu" : "webgl2",
      size, frames,
      results: results.map((entry) => ({ ...entry, captureMs: entry.medianMs - baseline.medianMs })),
      retainedBytes: await host.dispose(),
    };
  } catch (error) {
    await host.dispose().catch(() => {});
    throw error;
  }
}
