import { describe, expect, it } from "vitest";
import { FreeCamera, MeshBuilder, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeWaterBody } from "@haptic/core";
import { sceneWaterQualityDeviceClamp } from "./render-settings";
import {
  WATER_CLOCK_UNIFORM, WATER_EYE_UNIFORM, WATER_FFT_SAMPLER, WATER_FOAM_SAMPLER, WATER_NODE_FOAM_UNIFORM, WATER_NODE_SUN_UNIFORM, WATER_VERTEX_WAVE_UNIFORMS,
  WaterVertexWaves, waterFoamDrift, waterFoamThresholdOf,
} from "./water-material";

describe("Water vertex waves", () => {
  it("binds the displacement the Water Waves node reads, plus its clock, eye, foam and sun", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      new FreeCamera("camera", new Vector3(3, 4, -5), scene).computeWorldMatrix();
      const mesh = MeshBuilder.CreateGround("surface", { width: 2, height: 2 }, scene);
      mesh.computeWorldMatrix(true);
      const water = createDefaultWaterDefinition(), body = normalizeWaterBody({});
      const waves = new WaterVertexWaves(water, body);
      waves.time = 7.25;
      const vectors = new Map<string, number[]>(), textures = new Map<string, unknown>();
      waves.bind({
        setFloat4: (name: string, ...values: number[]) => { vectors.set(name, values); },
        setTexture: (name: string, texture: unknown) => { textures.set(name, texture); },
      }, scene, mesh);
      // Every vertex uniform the node's shader reads is bound, with the spectrum's and the foam's textures.
      expect([...vectors.keys()].sort()).toEqual([...WATER_VERTEX_WAVE_UNIFORMS, WATER_CLOCK_UNIFORM, WATER_EYE_UNIFORM, WATER_NODE_FOAM_UNIFORM, WATER_NODE_SUN_UNIFORM].sort());
      expect(textures.has(WATER_FFT_SAMPLER)).toBe(true);
      expect(textures.has(WATER_FOAM_SAMPLER)).toBe(true);
      const drift = waterFoamDrift(water, body.waveScale, { x: 0, z: 0 });
      expect(Math.hypot(drift.x, drift.z)).toBeGreaterThan(0);
      expect(vectors.get(WATER_CLOCK_UNIFORM)).toEqual([7.25, drift.x, drift.z, 0]);
      expect(vectors.get(WATER_EYE_UNIFORM)).toEqual([3, 4, -5, 0]);
      const { fftSize, fftCascades } = sceneWaterQualityDeviceClamp(scene).quality;
      expect(vectors.get(WATER_NODE_FOAM_UNIFORM)).toEqual([water.crestFoam, water.foamAmount,
        waterFoamThresholdOf(water, body.waveScale, fftSize, fftCascades), 1 / Math.min(1, body.waveScale)]);
      expect(vectors.get(WATER_NODE_SUN_UNIFORM)![3]).toBe(water.subsurface);
    } finally { scene.dispose(); engine.dispose(); }
  });
});
