import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectionalLight, NullEngine, PointLight, Scene, SpotLight, Vector3, type AbstractEngine } from "@babylonjs/core";
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

function entry(light: SpotLight | PointLight | DirectionalLight): ShadowEntry {
  return {
    light, requested: true, priority: 0, generator: null, key: null, settings: null, mapSize: 0, reason: null,
    failedKey: "", recovery: null, resetAllocation: false, status: "disabled", standby: false, admittedAt: -Infinity,
    distanceSquared: 0, effectiveBias: [],
  };
}

/** Room for every map but the atlas's area. */
const budget = (atlasEdge: number): ShadowAdmissionBudget => ({
  bytes: 1024 ** 3, passes: 64, bytesPerTexel: 12, cascadedBytesPerTexel: 6,
  maxTextureSize: 16384, maxCubemapTextureSize: 16384, atlasEdge,
});

function plan(lights: (SpotLight | PointLight | DirectionalLight)[], atlasEdge: number, localMapSize: number, sun = { mapSize: 2048, cascades: 1 }) {
  const entries = new Map(lights.map((light) => [light, entry(light)]));
  return planShadowAdmission({
    entries, settings: normalizeShadowSettings({ ...sun, maxLocalLights: 8, localMapSize }), camera: null,
    previousCamera: null, at: 0, budget: budget(atlasEdge), measure: () => 0,
  });
}

describe("Shadow admission into the shadow atlas", () => {
  it("sizes the atlas by the quality level's byte budget, within the texture limit and the device class's cap", () => {
    const engine = { getCaps: () => ({ maxTextureSize: 16384 }) } as unknown as AbstractEngine;
    expect((["low", "medium", "high", "ultra"] as const).map((profile) => shadowAtlasEdge(engine, profile))).toEqual([4096, 4096, 8192, 8192]);
    expect(shadowAtlasEdge({ getCaps: () => ({ maxTextureSize: 4096 }) } as unknown as AbstractEngine, "ultra")).toBe(4096);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)", maxTouchPoints: 5 });
    expect(shadowAtlasEdge(engine, "ultra")).toBe(2048);
  });

  it("admits spot maps by the atlas's area and counts the atlas's bytes once", () => {
    const host = scene();
    const spots = [0, 1, 2, 3, 4].map((index) => new SpotLight(`spot ${index}`, new Vector3(index, 4, 0), Vector3.Down(), 1, 2, host));
    const lamp = new PointLight("lamp", new Vector3(0, 2, 0), host);
    const { decisions, admitted } = plan([...spots, lamp], 2048, 1024);
    // Four 1024 tiles fill a 2048 atlas: neither the fifth spot light nor a point light's six faces find room.
    expect(decisions.map(({ status, reason, mapSize }) => [status, reason, mapSize])).toEqual([
      ...[0, 1, 2, 3].map(() => ["active", null, 1024]),
      ["budget-limited", "shadow atlas space", 0],
      ["budget-limited", "shadow atlas space", 0],
    ]);
    expect(admitted.bytes).toBe(2048 ** 2 * SHADOW_ATLAS_BYTES_PER_TEXEL);
  });

  it("admits the sun's cascades as tiles, leaving room for the local maps planned into the atlas", () => {
    const host = scene();
    const sun = new DirectionalLight("sun", new Vector3(0, -1, 0), host);
    const spots = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => new SpotLight(`spot ${index}`, new Vector3(index, 4, 0), Vector3.Down(), 1, 2, host));
    // Ultra: four 4096 cascades would fill the 8192 atlas; eight 2048 spot tiles keep half of it.
    const ultra = plan([sun, ...spots], 8192, 2048, { mapSize: 4096, cascades: 4 });
    expect(ultra.decisions.map(({ status, mapSize }) => [status, mapSize])).toEqual([["active", 2048], ...spots.map(() => ["active", 2048])]);
    expect(ultra.decisions[0]!.reason).toBe("shadow map reduced by shadow atlas space");
    // Alone, the sun takes the whole atlas.
    expect(plan([sun], 8192, 2048, { mapSize: 4096, cascades: 4 }).decisions.map(({ mapSize, reason }) => [mapSize, reason])).toEqual([[4096, null]]);
    // Medium: three 2048 cascades and two 1024 spot tiles fit a 4096 atlas.
    const medium = plan([sun, spots[0]!, spots[1]!], 4096, 1024, { mapSize: 2048, cascades: 3 });
    expect(medium.decisions.map(({ status, mapSize }) => [status, mapSize])).toEqual([["active", 2048], ["active", 1024], ["active", 1024]]);
    // A point light's six faces count in the room the sun leaves: Medium's three 2048 cascades and one point light's
    // six 1024 faces need 18.9 Mtexels of a 4096 atlas's 16.8, so the cascades halve.
    const lamp = new PointLight("lamp", new Vector3(0, 2, 0), host);
    expect(plan([sun, lamp], 4096, 1024, { mapSize: 2048, cascades: 3 }).decisions.map(({ status, mapSize }) => [status, mapSize]))
      .toEqual([["active", 1024], ["active", 1024]]);
  });

  it("keeps the sun's cascades when the local maps planned would fill the atlas, leaving them at most half of it", () => {
    const host = scene();
    const sun = new DirectionalLight("sun", new Vector3(0, -1, 0), host);
    const lamps = [0, 1, 2].map((index) => new PointLight(`lamp ${index}`, new Vector3(index * 3, 2, 0), host));
    // High: three point lights' six 2048 faces (75.5 Mtexels) exceed the 8192 atlas (67.1); the sun keeps its four
    // 2048 cascades in the half it reserves, two points fill the rest and the third finds no room.
    expect(plan([sun, ...lamps], 8192, 2048, { mapSize: 2048, cascades: 4 }).decisions.map(({ status, mapSize }) => [status, mapSize]))
      .toEqual([["active", 2048], ["active", 2048], ["active", 2048], ["budget-limited", 0]]);
  });

  it("caps a spot map at the atlas's edge", () => {
    const host = scene();
    const spot = new SpotLight("spot", new Vector3(0, 4, 0), Vector3.Down(), 1, 2, host);
    expect(plan([spot], 1024, 2048).decisions.map(({ mapSize, reason }) => [mapSize, reason])).toEqual([
      [1024, "shadow map reduced by shadow atlas space"],
    ]);
  });
});
