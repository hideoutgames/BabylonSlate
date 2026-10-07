import { GPUParticleSystem, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { afterEach, expect, it, vi } from "vitest";

const engines: NullEngine[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const engine of engines.splice(0)) engine.dispose(); });
function host() {
  const engine = new NullEngine();
  engines.push(engine);
  vi.spyOn(engine, "getCaps").mockReturnValue({ ...engine.getCaps(), supportTransformFeedbacks: true });
  const scene = new Scene(engine);
  const system = new GPUParticleSystem("GPU emitter", { capacity: 8, emitRateControl: true }, scene);
  system.emitter = Vector3.Zero();
  system.start(0);
  return { scene, system };
}

it("holds the real GPU emitter clock and queued emissions while paused", () => {
  const { system } = host();
  system.targetStopDuration = 0.1;
  system.updateSpeed = 0.04;
  system.animate(true);
  expect(system.isStopped()).toBe(false);
  system.paused = true;
  system.manualEmitCount = 3;
  for (let index = 0; index < 10; index++) system.animate(true);
  expect(system.isStopped()).toBe(false);
  expect(system.manualEmitCount).toBe(3);
  system.paused = false;
  system.animate(true);
  expect(system.isStopped()).toBe(false);
  system.animate(true);
  expect(system.isStopped()).toBe(true);
});

it("does not initialize or prewarm an unrendered GPU system during paused redraw", () => {
  const { scene, system } = host();
  system.preWarmCycles = 10;
  system.manualEmitCount = 3;
  system.paused = true;
  const textures = scene.textures.length;
  expect(system.render()).toBe(0);
  expect(system.render(true, true)).toBe(0);
  expect(system.manualEmitCount).toBe(3);
  expect(system.getActiveCount()).toBe(0);
  expect(system.vertexBuffers).toBeUndefined();
  expect(scene.textures).toHaveLength(textures);
});
