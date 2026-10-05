import { afterEach, expect, it, vi } from "vitest";
import { Constants, EffectRenderer, FreeCamera, NullEngine, PBRMaterial, Scene, Vector3, Viewport } from "@babylonjs/core";
import {
  createDefaultWaterDefinition, normalizeRenderingQuality, normalizeWaterBody, normalizeWaterDefinition, waterWaveSet, type WaterDefinition,
} from "@babylonslate/core";
import { limitManagedRenderBytes, managedRenderReservations } from "./managed-render-resources";
import { sceneWaterQualityDeviceClamp, updateSceneRenderingSettings } from "./render-settings";
import { WATER_FFT_IDLE_RUNS, WATER_FFT_MAX_SIMULATIONS, waterFftDiagnostics, waterFftForSurface } from "./water-fft";
import { WATER_FFT_BUILD_TEXELS, waterFftLayout } from "./water-fft-spectrum";
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

/**
 * One engine frame: the water before-render observer (Scene.render's first step), `renders` times for captures, then
 * the materials of `sampled` asking for their band as a consumer's bind would.
 */
function frame(engine: NullEngine, scene: Scene, sampled: WaterDefinition[] = [], renders = 1) {
  engine.beginFrame();
  for (let i = 0; i < renders; i++) updateSceneWater(scene);
  for (const water of sampled) waterFftForSurface(scene, water);
  engine.endFrame();
}

/** Frames until `water`'s band is ready (effects may compile asynchronously); returns the frames it took. */
async function untilReady(engine: NullEngine, scene: Scene, sampled: WaterDefinition[], water = sampled[0]!) {
  let frames = 0;
  await vi.waitFor(() => {
    frame(engine, scene, sampled);
    frames++;
    expect(waterFftForSurface(scene, water)?.ready).toBe(true);
  }, { timeout: 5000 });
  return frames;
}

/** Bytes the FFT leases: h0 (C·N × N RGBA32F), two work atlases (2C·N × N RGBA32F) and the 2C-layer RGBA16F output. */
const footprint = (size: number, cascades: number) =>
  cascades * size * size * 16 + 2 * (2 * cascades * size * size * 16) + 2 * cascades * size * size * 8;

it("does no work while FFT Ocean Detail is off, Detail Waves is zero, the water is out of view, no material samples it, or floats do not render", async () => {
  const draws = vi.spyOn(EffectRenderer.prototype, "draw");
  const off = host({ fft: false });
  const offWater = lake(off.scene).water;
  for (let i = 0; i < 3; i++) frame(off.engine, off.scene, [offWater]);
  expect(waterFftForSurface(off.scene, offWater)).toBeNull();

  const on = host();
  const calm = lake(on.scene, definition({ detailWaves: 0 }), "calm").water;
  const hidden = lake(on.scene, definition(), "hidden");
  hidden.mesh.setEnabled(false);
  const behind = lake(on.scene, definition({ waveSeed: 5 }), "behind");
  behind.mesh.position.z = -40;
  // Visible built-in water whose material never asks for the band: no simulation and no spectrum work either.
  lake(on.scene, definition({ waveSeed: 6 }), "unsampled");
  const sampled = [calm, hidden.water, behind.water];
  for (let i = 0; i < 3; i++) frame(on.engine, on.scene, sampled);
  for (const water of sampled) expect(waterFftForSurface(on.scene, water)).toBeNull();
  expect(waterFftDiagnostics(on.scene)).toMatchObject({ simulations: [], built: 0, building: null });
  // The same scene does run the band for sampled water in view.
  const seen = lake(on.scene, definition(), "seen").water;
  await untilReady(on.engine, on.scene, [...sampled, seen], seen);
  expect(waterFftDiagnostics(on.scene)).toMatchObject({ created: 1, built: 1 });
  draws.mockClear();
  on.scene.dispose();

  // Without float render targets the device clamp turns FFT off and reports why.
  const weak = host({}, { textureFloatRender: false, textureHalfFloatRender: true });
  const weakWater = lake(weak.scene).water;
  for (let i = 0; i < 3; i++) frame(weak.engine, weak.scene, [weakWater]);
  expect(waterFftForSurface(weak.scene, weakWater)).toBeNull();
  expect(sceneWaterQualityDeviceClamp(weak.scene).limits).toEqual([expect.stringContaining("FFT Ocean Detail")]);

  for (const { engine, scene } of [off, weak]) {
    expect(waterFftDiagnostics(scene)).toMatchObject({ simulations: [], created: 0, built: 0 });
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
  const sampled = [a, second.water, half.water];
  setSceneWaterTime(scene, 2);
  // Frames keep rendering (analytic only) while the spectrum is drawn and the effects compile.
  await untilReady(engine, scene, sampled);
  const view = waterFftForSurface(scene, a)!;
  // Equal waves share one simulation and texture; each asset keeps its own Detail Waves gain.
  expect(waterFftForSurface(scene, second.water)!.texture).toBe(view.texture);
  expect(waterFftForSurface(scene, half.water)).toMatchObject({ texture: view.texture, amplitudeGain: 0.5 });
  expect(view).toMatchObject({ cascades: 1, amplitudeGain: 1, patchSizes: waterFftLayout(waterWaveSet(a), 64, 1).patchSizes });
  expect(waterFftDiagnostics(scene)).toMatchObject({ created: 1, built: 1, simulations: [{ size: 64, cascades: 1 }] });
  expect(managedRenderReservations(engine).categoryBytes.water).toBe(footprint(64, 1));

  // 1 evolution + log2 64 horizontal + (log2 64 − 1) vertical atlas passes + one final pass per layer (2 layers).
  const perDispatch = 1 + 6 + 5 + 2;
  draws.mockClear();
  setSceneWaterTime(scene, 2.5);
  frame(engine, scene, sampled);
  expect(draws).toHaveBeenCalledTimes(perDispatch);
  // A capture rendering the scene again in the same frame, even at a newer time, never dispatches twice.
  draws.mockClear();
  engine.beginFrame();
  setSceneWaterTime(scene, 3);
  updateSceneWater(scene);
  setSceneWaterTime(scene, 3.25);
  updateSceneWater(scene);
  for (const water of sampled) waterFftForSurface(scene, water);
  engine.endFrame();
  expect(draws).toHaveBeenCalledTimes(perDispatch);
  expect(waterFftDiagnostics(scene).simulations[0]!.time).toBe(3);
  // The next frame catches up with the clock; paused water then keeps its band until the clock steps again.
  draws.mockClear();
  frame(engine, scene, sampled);
  expect(draws).toHaveBeenCalledTimes(perDispatch);
  expect(waterFftDiagnostics(scene).simulations[0]!.time).toBe(3.25);
  draws.mockClear();
  frame(engine, scene, sampled);
  frame(engine, scene, sampled, 2);
  expect(draws).not.toHaveBeenCalled();
  // Once no material has asked for the band for two frames, it stops dispatching though the water stays in view.
  for (const time of [3.5, 3.6]) {
    setSceneWaterTime(scene, time);
    frame(engine, scene);
  }
  draws.mockClear();
  setSceneWaterTime(scene, 3.75);
  frame(engine, scene);
  expect(draws).not.toHaveBeenCalled();

  // The passes run inside the before-render observer and restore the caller's target, viewport and render state.
  const previous = engine.createRenderTargetTexture(16, { generateDepthBuffer: false });
  frame(engine, scene, sampled);
  engine.bindFramebuffer(previous);
  engine.setViewport(new Viewport(0.1, 0.2, 0.5, 0.6));
  engine.setAlphaMode(Constants.ALPHA_ADD);
  engine.setDepthWrite(true);
  setSceneWaterTime(scene, 4);
  draws.mockClear();
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
  // After a cache reset (Scene disposal on a shared engine, a context restore) Babylon reports alpha mode -1 with
  // blending off; the dispatch must leave blending off rather than restore the sentinel.
  frame(engine, scene, sampled);
  engine.wipeCaches(true);
  engine._resetAlphaMode();
  expect(engine.getAlphaMode()).toBe(-1);
  expect(engine.alphaState.alphaBlend).toBe(false);
  setSceneWaterTime(scene, 4.5);
  draws.mockClear();
  frame(engine, scene, sampled);
  expect(draws).toHaveBeenCalledTimes(perDispatch);
  expect(engine.alphaState.alphaBlend).toBe(false);
});

it("draws a new spectrum in budgeted steps without holding storage, so no single frame pays for a whole build", async () => {
  const { engine, scene } = host({ fftSize: 256, fftCascades: 3 });
  const { water } = lake(scene);
  // The first frame registers the material's demand; the build starts on the next observer run.
  frame(engine, scene, [water]);
  const steps = Math.ceil(2 * 3 * 256 * 256 / WATER_FFT_BUILD_TEXELS);
  for (let i = 0; i < steps - 1; i++) {
    frame(engine, scene, [water]);
    expect(waterFftDiagnostics(scene)).toMatchObject({ built: 0, building: expect.any(String), simulations: [] });
    expect(managedRenderReservations(engine).categoryBytes.water).toBe(0);
    expect(waterFftForSurface(scene, water)).toBeNull();
  }
  frame(engine, scene, [water]);
  expect(waterFftDiagnostics(scene)).toMatchObject({ built: 1, building: null });
  await untilReady(engine, scene, [water]);
  expect(waterFftDiagnostics(scene)).toMatchObject({ built: 1, created: 1, simulations: [{ size: 256, cascades: 3 }] });
  expect(managedRenderReservations(engine).categoryBytes.water).toBe(footprint(256, 3));
});

it("reuses storage and spectra across asset edits, bodies viewed in turn, and idle release", async () => {
  const { engine, scene } = host();
  const first = lake(scene);
  await untilReady(engine, scene, [first.water]);
  const storage = waterFftForSurface(scene, first.water)!.texture;

  // Wave Height, Wave Length and Wave Speed edits rebuild the water with a new definition: the idle simulation takes
  // the new uniforms in the same frame, with no spectrum work and no upload.
  first.mesh.dispose();
  const taller = lake(scene, definition({ waveHeight: 0.8, waveLength: 20, waveSpeed: 0.7 }), "taller");
  frame(engine, scene, [taller.water]);
  frame(engine, scene, [taller.water]);
  expect(waterFftForSurface(scene, taller.water)).toMatchObject({ texture: storage, ready: true });
  expect(waterFftForSurface(scene, first.water)).toBeNull();
  expect(waterFftDiagnostics(scene)).toMatchObject({ created: 1, retargeted: 1, respectrummed: 0, built: 1 });

  // A body with another spectrum (Wave Direction) gets its own simulation while the first one was in use recently...
  taller.mesh.setEnabled(false);
  const turned = lake(scene, definition({ waveDirection: 70 }), "turned");
  await untilReady(engine, scene, [taller.water, turned.water], turned.water);
  expect(waterFftDiagnostics(scene)).toMatchObject({ created: 2, respectrummed: 0, built: 2 });
  // ...so viewing them in turn trades nothing: each keeps its simulation, and no spectrum is drawn again.
  for (let i = 0; i < 3; i++) {
    turned.mesh.setEnabled(i % 2 === 1); taller.mesh.setEnabled(i % 2 === 0);
    await untilReady(engine, scene, [taller.water, turned.water], i % 2 === 0 ? taller.water : turned.water);
  }
  expect(waterFftDiagnostics(scene)).toMatchObject({ created: 2, retargeted: 1, respectrummed: 0, built: 2 });
  expect(managedRenderReservations(engine).categoryBytes.water).toBe(2 * footprint(64, 1));

  // Out of view: kept through brief absences, released after WATER_FFT_IDLE_RUNS runs...
  turned.mesh.setEnabled(true);
  frame(engine, scene, [taller.water, turned.water]);
  taller.mesh.setEnabled(false); turned.mesh.setEnabled(false);
  for (let i = 0; i < WATER_FFT_IDLE_RUNS; i++) frame(engine, scene, [taller.water, turned.water]);
  expect(waterFftDiagnostics(scene).simulations).toHaveLength(2);
  frame(engine, scene, [taller.water, turned.water]);
  expect(waterFftDiagnostics(scene)).toMatchObject({ simulations: [], retired: 2 });
  expect(managedRenderReservations(engine).categoryBytes.water).toBe(0);
  // ...and coming back allocates again but uploads the kept spectrum instead of drawing it.
  turned.mesh.setEnabled(true);
  await untilReady(engine, scene, [turned.water]);
  expect(waterFftDiagnostics(scene)).toMatchObject({ created: 3, built: 2 });
});

it("never holds more than WATER_FFT_MAX_SIMULATIONS simulations through repeated spectrum edits", async () => {
  const { engine, scene } = host();
  let body = lake(scene);
  await untilReady(engine, scene, [body.water]);
  for (let edit = 1; edit <= 5; edit++) {
    body.mesh.dispose();
    body = lake(scene, definition({ waveDirection: 10 * edit }), `edit-${edit}`);
    await untilReady(engine, scene, [body.water]);
    expect(waterFftDiagnostics(scene).simulations.length).toBeLessThanOrEqual(WATER_FFT_MAX_SIMULATIONS);
  }
  // Past the cap the longest-idle simulation takes the new spectrum (one upload) instead of a new lease.
  expect(waterFftDiagnostics(scene)).toMatchObject({ created: WATER_FFT_MAX_SIMULATIONS, respectrummed: 6 - WATER_FFT_MAX_SIMULATIONS, built: 6 });
  expect(managedRenderReservations(engine).categoryBytes.water).toBe(WATER_FFT_MAX_SIMULATIONS * footprint(64, 1));
});

it("releases its lease at once when FFT turns off or the Water quality size changes", async () => {
  const { engine, scene } = host();
  const { water } = lake(scene);
  await untilReady(engine, scene, [water]);
  quality(scene, { fft: true, fftSize: 128, fftCascades: 2 });
  expect(waterFftForSurface(scene, water)).toBeNull();
  await untilReady(engine, scene, [water]);
  expect(waterFftDiagnostics(scene)).toMatchObject({ retired: 1, simulations: [{ size: 128, cascades: 2 }] });
  expect(waterFftForSurface(scene, water)).toMatchObject({ cascades: 2 });
  expect(managedRenderReservations(engine).categoryBytes.water).toBe(footprint(128, 2));
  quality(scene, { fft: false });
  expect(waterFftForSurface(scene, water)).toBeNull();
  frame(engine, scene, [water]);
  expect(waterFftDiagnostics(scene)).toMatchObject({ simulations: [], retired: 2 });
  expect(managedRenderReservations(engine).categoryBytes.water).toBe(0);
});

it("keeps analytic-only water when the managed ledger cannot admit the band, retries later, and falls back to idle storage", async () => {
  const ultra = host({ fftSize: 256, fftCascades: 3 });
  const deep = lake(ultra.scene).water;
  limitManagedRenderBytes(ultra.engine, footprint(256, 3) - 1);
  for (let i = 0; i < 30; i++) frame(ultra.engine, ultra.scene, [deep]);
  expect(waterFftForSurface(ultra.scene, deep)).toBeNull();
  expect(waterFftDiagnostics(ultra.scene)).toMatchObject({ denied: 1, created: 0, built: 1, simulations: [] });
  expect(managedRenderReservations(ultra.engine).reservedBytes).toBe(0);
  // Refusals are not retried every frame.
  for (let i = 0; i < 10; i++) frame(ultra.engine, ultra.scene, [deep]);
  expect(waterFftDiagnostics(ultra.scene).denied).toBe(1);

  // Room for one simulation: a refused second spectrum serves its visible water from the idle one.
  const { engine, scene } = host();
  limitManagedRenderBytes(engine, footprint(64, 1));
  const a = lake(scene, definition(), "a");
  await untilReady(engine, scene, [a.water]);
  a.mesh.setEnabled(false);
  const b = lake(scene, definition({ waveDirection: 70 }), "b");
  await untilReady(engine, scene, [a.water, b.water], b.water);
  expect(waterFftDiagnostics(scene)).toMatchObject({ created: 1, denied: 1, respectrummed: 1, simulations: [{}] });
  expect(managedRenderReservations(engine).categoryBytes.water).toBe(footprint(64, 1));
});
