import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine, PointLight, Scene, SpotLight, Vector3, type AbstractEngine } from "@babylonjs/core";
import { normalizeShadowSettings } from "@haptic/core";
import { planShadowAdmission, type ShadowAdmissionBudget } from "./shadow-admission-plan";
import { SHADOW_ATLAS_BYTES_PER_TEXEL, shadowAtlasEdge } from "./shadow-atlas";
import type { ShadowEntry } from "./shadow-entry";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const engine of engines.splice(0)) engine.dispose();
});

function scene(): Scene {
  const engine = new NullEngine();
  engines.push(engine);
  return new Scene(engine);
}

function entry(light: SpotLight | PointLight): ShadowEntry {
  return {
    light, requested: true, priority: 0, generator: null, key: null, settings: null, mapSize: 0, reason: null,
    failedKey: "", recovery: null, resetAllocation: false, status: "disabled", standby: false, admittedAt: -Infinity,
    distanceSquared: 0, effectiveBias: [],
  };
}

/** Room for every map but the atlas's area, and no material sampler to spare. */
const budget = (atlasEdge: number): ShadowAdmissionBudget => ({
  bytes: 1024 ** 3, passes: 64, samplers: 0, bytesPerTexel: 12, cascadedBytesPerTexel: 6,
  maxTextureSize: 16384, maxCubemapTextureSize: 16384, atlasEdge,
});

function plan(lights: (SpotLight | PointLight)[], atlasEdge: number, localMapSize: number) {
  const entries = new Map(lights.map((light) => [light, entry(light)]));
  return planShadowAdmission({
    entries, settings: normalizeShadowSettings({ cascades: 1, maxLocalLights: 8, localMapSize }), camera: null,
    previousCamera: null, restoring: null, at: 0, budget: budget(atlasEdge), measure: () => 0,
  });
}

describe("Shadow admission into the lighting plan's atlas", () => {
  it("sizes the atlas by the quality level's byte budget, within the texture limit and the device class's cap", () => {
    const engine = { getCaps: () => ({ maxTextureSize: 16384 }) } as unknown as AbstractEngine;
    expect((["low", "medium", "high", "ultra"] as const).map((profile) => shadowAtlasEdge(engine, profile))).toEqual([4096, 4096, 8192, 8192]);
    expect(shadowAtlasEdge({ getCaps: () => ({ maxTextureSize: 4096 }) } as unknown as AbstractEngine, "ultra")).toBe(4096);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)", maxTouchPoints: 5 });
    expect(shadowAtlasEdge(engine, "ultra")).toBe(2048);
  });

  it("admits spot maps by the atlas's area, with no material sampler, and counts the atlas's bytes once", () => {
    const host = scene();
    const spots = [0, 1, 2, 3, 4].map((index) => new SpotLight(`spot ${index}`, new Vector3(index, 4, 0), Vector3.Down(), 1, 2, host));
    const lamp = new PointLight("lamp", new Vector3(0, 2, 0), host);
    const { decisions, admitted } = plan([...spots, lamp], 2048, 1024);
    // Four 1024 tiles fill a 2048 atlas; a point light's map of its own needs a sampler.
    expect(decisions.map(({ status, reason, mapSize }) => [status, reason, mapSize])).toEqual([
      ...[0, 1, 2, 3].map(() => ["active", null, 1024]),
      ["budget-limited", "shadow atlas space", 0],
      ["budget-limited", "material sampler headroom", 0],
    ]);
    expect(admitted.bytes).toBe(2048 ** 2 * SHADOW_ATLAS_BYTES_PER_TEXEL);
    expect(admitted.samplers).toBe(0);
  });

  it("caps a spot map at the atlas's edge, and counts no atlas without a spot map in it", () => {
    const host = scene();
    const spot = new SpotLight("spot", new Vector3(0, 4, 0), Vector3.Down(), 1, 2, host);
    expect(plan([spot], 1024, 2048).decisions.map(({ mapSize, reason }) => [mapSize, reason])).toEqual([
      [1024, "shadow map reduced by shadow atlas space"],
    ]);
    // Off the lighting plan's path a spot map is a map of its own.
    const legacy = plan([spot], 0, 1024);
    expect(legacy.decisions.map(({ reason }) => reason)).toEqual(["material sampler headroom"]);
    expect(legacy.admitted.bytes).toBe(0);
  });
});
