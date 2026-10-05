import { afterEach, expect, it, vi } from "vitest";
import { Constants, EffectRenderer, FreeCamera, NullEngine, PBRMaterial, Scene, Vector3, Viewport } from "@babylonjs/core";
import {
  createDefaultWaterDefinition, normalizeRenderingQuality, normalizeWaterBody, normalizeWaterDefinition, waterWaveSet, type WaterDefinition,
} from "@babylonslate/core";
import { limitManagedRenderBytes, managedRenderReservations } from "./managed-render-resources";
import { sceneWaterQualityDeviceClamp, updateSceneRenderingSettings } from "./render-settings";
import { WATER_FFT_IDLE_RUNS, waterFftDiagnostics, waterFftForSurface } from "./water-fft";
import { waterFftLayout } from "./water-fft-spectrum";
import type { WaterMaterialPlugin } from "./water-material";
import { createWaterMesh, setSceneWaterTime, updateSceneWater } from "./water-mesh";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

type FftQuality = { fft?: boolean; fftSize?: number; fftCascades?: number };

/** A device that renders float and half-float targets, a camera over the origin, and a Water quality. */
function host(fft: FftQuality = {}, caps = { textureFloatRender: true, textureHalfFloatRender: true }) {
  const engine = new NullEngine();
  engines.push(engine);
  Object.assign(engine.getCaps(), caps);
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 8, -12), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  quality(scene, { fft: true, fftSize: 64, fftCascades: 1, ...fft });
  return { engine, scene };
}

function quality(scene: Scene, water: FftQuality) {
  updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality({ water }) });
}

const definition = (patch: Partial<WaterDefinition> = {}) => normalizeWaterDefinition({ ...createDefaultWaterDefinition(), ...patch });

/** Built-in water and the definition its material plugin holds (what a water material passes to waterFftForSurface). */
function lake(scene: Scene, asset: WaterDefinition = definition(), name = "lake") {
  const mesh = createWaterMesh(scene, name, normalizeWaterBody({ width: 6, length: 6, resolution: 8 }), asset);
  const plugin = (mesh.material as PBRMaterial).pluginManager!.getPlugin<WaterMaterialPlugin>("SlateWater")!;
  return { mesh, water: plugin.water };
}

/** One engine frame of the water before-render observer (Scene.render's first step), `renders` times for captures. */
function frame(engine: NullEngine, scene: Scene, renders = 1) {
  engine.beginFrame();
  for (let i = 0; i < renders; i++) updateSceneWater(scene);
  engine.endFrame();
}

/** Bytes the FFT leases: h0 (C·N × N RGBA32F), two work atlases (2C·N × N RGBA32F) and the 2C-layer RGBA16F output. */
const footprint = (size: number, cascades: number) =>
  cascades * size * size * 16 + 2 * (2 * cascades * size * size * 16) + 2 * cascades * size * size * 8;

it("allocates and dispatches nothing while FFT Ocean Detail is off, Detail Waves is zero, the water is out of view, or the device lacks float targets", () => {
  const draws = vi.spyOn(EffectRenderer.prototype, "draw");
  const off = host({ fft: false });
  const offWater = lake(off.scene).water;
  for (let i = 0; i < 3; i++) frame(off.engine, off.scene);
  expect(waterFftForSurface(off.scene, offWater)).toBeNull();

  const on = host();
  const calm = lake(on.scene, definition({ detailWaves: 0 }), "calm").water;
  const hidden = lake(on.scene, definition(), "hidden");
  hidden.mesh.setEnabled(false);
  const behind = lake(on.scene, definition({ waveSeed: 5 }), "behind");
  behind.mesh.position.z = -40;
  for (let i = 0; i < 3; i++) frame(on.engine, on.scene);
  for (const water of [calm, hidden.water, behind.water]) expect(waterFftForSurface(on.scene, water)).toBeNull();
  // The same scene does run the band for water in view.
  const seen = lake(on.scene, definition(), "seen").water;
  frame(on.engine, on.scene);
  expect(waterFftForSurface(on.scene, seen)).not.toBeNull();
  draws.mockClear();
  on.scene.dispose();

  // Without float render targets the device clamp turns FFT off and reports why.
  const weak = host({}, { textureFloatRender: false, textureHalfFloatRender: true });
  const weakWater = lake(weak.scene).water;
  for (let i = 0; i < 3; i++) frame(weak.engine, weak.scene);
  expect(waterFftForSurface(weak.scene, weakWater)).toBeNull();
  expect(sceneWaterQualityDeviceClamp(weak.scene).limits).toEqual([expect.stringContaining("FFT Ocean Detail")]);

  for (const { engine, scene } of [off, weak]) {
    expect(waterFftDiagnostics(scene)).toMatchObject({ simulations: [], created: 0 });
    expect(managedRenderReservations(engine).categoryBytes.water).toBe(0);
  }
  // Disposing the scene released the one band that ran.
  expect(managedRenderReservations(on.engine).categoryBytes.water).toBe(0);
  expect(draws).not.toHaveBeenCalled();
});

it("shares one leased simulation per spectrum, becomes ready without blocking, and dispatches once per frame only when the water clock moves", async () => {
  const draws = vi.spyOn(EffectRenderer.prototype, "draw");
  const { engine, scene } = host();
  const a = lake(scene, definition(), "a").water;
  const second = lake(scene, definition(), "b");
  second.mesh.position.x = 3;
  const half = lake(scene, definition({ detailWaves: 0.5 }), "half");
  half.mesh.position.x = -3;
  setSceneWaterTime(scene, 2);
  frame(engine, scene);
  const view = waterFftForSurface(scene, a)!;
  expect(view).not.toBeNull();
  // Equal waves share one simulation and texture; each asset keeps its own Detail Waves gain.
  expect(waterFftForSurface(scene, second.water)!.texture).toBe(view.texture);
  expect(waterFftForSurface(scene, half.water)).toMatchObject({ texture: view.texture, amplitudeGain: 0.5 });
  expect(view).toMatchObject({ cascades: 1, amplitudeGain: 1, patchSizes: waterFftLayout(waterWaveSet(a), 64, 1).patchSizes });
  expect(waterFftDiagnostics(scene)).toMatchObject({ created: 1, simulations: [{ size: 64, cascades: 1 }] });
  expect(managedRenderReservations(engine).categoryBytes.water).toBe(footprint(64, 1));

  // Effects may compile asynchronously: frames keep rendering (analytic only) until the first dispatch lands.
  await vi.waitFor(() => {
    frame(engine, scene);
    expect(view.ready).toBe(true);
  });
  // 1 evolution + log2 64 horizontal + (log2 64 − 1) vertical atlas passes + one final pass per layer (2 layers).
  const perDispatch = 1 + 6 + 5 + 2;
  draws.mockClear();
  setSceneWaterTime(scene, 2.5);
  frame(engine, scene);
  expect(draws).toHaveBeenCalledTimes(perDispatch);
  // A capture rendering the scene again in the same frame, even at a newer time, never dispatches twice.
  draws.mockClear();
  engine.beginFrame();
  setSceneWaterTime(scene, 3);
  updateSceneWater(scene);
  setSceneWaterTime(scene, 3.25);
  updateSceneWater(scene);
  engine.endFrame();
  expect(draws).toHaveBeenCalledTimes(perDispatch);
  expect(waterFftDiagnostics(scene).simulations[0]!.time).toBe(3);
  // The next frame catches up with the clock; paused water then keeps its band until the clock steps again.
  draws.mockClear();
  frame(engine, scene);
  expect(draws).toHaveBeenCalledTimes(perDispatch);
  expect(waterFftDiagnostics(scene).simulations[0]!.time).toBe(3.25);
  draws.mockClear();
  frame(engine, scene);
  frame(engine, scene, 2);
  expect(draws).not.toHaveBeenCalled();

  // The passes run inside the before-render observer and restore the caller's target, viewport and render state.
  const previous = engine.createRenderTargetTexture(16, { generateDepthBuffer: false });
  engine.bindFramebuffer(previous);
  engine.setViewport(new Viewport(0.1, 0.2, 0.5, 0.6));
  engine.setAlphaMode(Constants.ALPHA_ADD);
  engine.setDepthWrite(true);
  setSceneWaterTime(scene, 4);
  engine.beginFrame();
  updateSceneWater(scene);
  expect(draws).toHaveBeenCalledTimes(perDispatch);
  expect(engine._currentRenderTarget).toBe(previous);
  expect(engine.currentViewport).toMatchObject({ x: 0.1, y: 0.2, width: 0.5, height: 0.6 });
  expect(engine.getAlphaMode()).toBe(Constants.ALPHA_ADD);
  expect(engine.getDepthWrite()).toBe(true);
  engine.endFrame();
  engine.unBindFramebuffer(previous);
  previous.dispose();
});

it("releases its lease when water leaves view, FFT turns off or the size changes, and reuses idle storage for a new spectrum", async () => {
  const { engine, scene } = host();
  const first = lake(scene);
  frame(engine, scene);
  await vi.waitFor(() => {
    frame(engine, scene);
    expect(waterFftForSurface(scene, first.water)?.ready).toBe(true);
  });

  // Editing the asset rebuilds the water with a new definition: the idle simulation takes the new spectrum in place.
  const storage = waterFftForSurface(scene, first.water)!.texture;
  first.mesh.dispose();
  const edited = lake(scene, definition({ waveDirection: 70 }), "edited");
  frame(engine, scene);
  expect(waterFftDiagnostics(scene)).toMatchObject({ created: 1, respectrummed: 1, simulations: [{ ready: true }] });
  expect(waterFftForSurface(scene, first.water)).toBeNull();
  expect(waterFftForSurface(scene, edited.water)).toMatchObject({ texture: storage, ready: true });
  expect(managedRenderReservations(engine).categoryBytes.water).toBe(footprint(64, 1));

  // Out of view: kept through brief absences, released after WATER_FFT_IDLE_RUNS runs.
  edited.mesh.setEnabled(false);
  for (let i = 0; i < WATER_FFT_IDLE_RUNS; i++) frame(engine, scene);
  expect(waterFftDiagnostics(scene).simulations).toHaveLength(1);
  frame(engine, scene);
  expect(waterFftDiagnostics(scene)).toMatchObject({ simulations: [], retired: 1 });
  expect(managedRenderReservations(engine).categoryBytes.water).toBe(0);

  // A new Water quality size replaces the simulation at once; FFT off releases it at once.
  edited.mesh.setEnabled(true);
  frame(engine, scene);
  quality(scene, { fft: true, fftSize: 128, fftCascades: 2 });
  expect(waterFftForSurface(scene, edited.water)).toBeNull();
  frame(engine, scene);
  expect(waterFftDiagnostics(scene)).toMatchObject({ retired: 2, simulations: [{ size: 128, cascades: 2 }] });
  expect(waterFftForSurface(scene, edited.water)).toMatchObject({ cascades: 2 });
  expect(managedRenderReservations(engine).categoryBytes.water).toBe(footprint(128, 2));
  quality(scene, { fft: false });
  expect(waterFftForSurface(scene, edited.water)).toBeNull();
  frame(engine, scene);
  expect(waterFftDiagnostics(scene)).toMatchObject({ simulations: [], retired: 3 });
  expect(managedRenderReservations(engine).categoryBytes.water).toBe(0);
});

it("keeps analytic-only water when the managed ledger cannot admit the band, and retries later", () => {
  const { engine, scene } = host({ fftSize: 256, fftCascades: 3 });
  const { water } = lake(scene);
  limitManagedRenderBytes(engine, footprint(256, 3) - 1);
  frame(engine, scene);
  expect(waterFftForSurface(scene, water)).toBeNull();
  expect(waterFftDiagnostics(scene)).toMatchObject({ denied: 1, created: 0, simulations: [] });
  expect(managedRenderReservations(engine).reservedBytes).toBe(0);
  // Refusals are not retried every frame.
  for (let i = 0; i < 10; i++) frame(engine, scene);
  expect(waterFftDiagnostics(scene).denied).toBe(1);
});
