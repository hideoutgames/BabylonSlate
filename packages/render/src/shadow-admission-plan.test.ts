import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectionalLight, NullEngine, PointLight, Scene, SpotLight, Vector3, type AbstractEngine } from "@babylonjs/core";
import { normalizeShadowSettings, SHADOW_FIRST_CASCADE_SCALE, SHADOW_HALF_TILE_CASCADES, type ShadowProfile } from "@haptic/core";
import { planShadowAdmission, type ShadowAdmissionBudget, type ShadowAdmissionDecision } from "./shadow-admission-plan";
import { cascadeTileSizes, SHADOW_ATLAS_BYTES_PER_TEXEL, shadowAtlasEdge, shadowAtlasEdgeLimit } from "./shadow-atlas";
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

/** Room for every map but the atlas's area: the level's `atlasEdge`, which a sun may grow up to `atlasEdgeLimit`. */
const budget = (atlasEdge: number, atlasEdgeLimit = atlasEdge): ShadowAdmissionBudget => ({
  bytes: 1024 ** 3, passes: 64, atlasEdge, atlasEdgeLimit,
});

function plan(
  lights: (SpotLight | PointLight | DirectionalLight)[], atlasEdge: number, localMapSize: number,
  sun: { mapSize: number; cascades: number; profile?: ShadowProfile } = { mapSize: 2048, cascades: 1 },
  atlasEdgeLimit = atlasEdge, entries = new Map(lights.map((light) => [light, entry(light)])),
) {
  return planShadowAdmission({
    entries, settings: normalizeShadowSettings({ ...sun, maxLocalLights: 8, localMapSize }), camera: null,
    previousCamera: null, at: 0, budget: budget(atlasEdge, atlasEdgeLimit), measure: () => 0,
  });
}

const MIB = 1024 ** 2;

describe("Shadow admission into the shadow atlas", () => {
  it("sizes the atlas by the quality level's byte budget within the texture limit, on a phone too", () => {
    const engine = { getCaps: () => ({ maxTextureSize: 16384 }) } as unknown as AbstractEngine;
    expect((["low", "medium", "high", "ultra"] as const).map((profile) => shadowAtlasEdge(engine, profile))).toEqual([4096, 4096, 8192, 8192]);
    expect(shadowAtlasEdge({ getCaps: () => ({ maxTextureSize: 4096 }) } as unknown as AbstractEngine, "ultra")).toBe(4096);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)", maxTouchPoints: 5 });
    expect((["low", "medium", "high", "ultra"] as const).map((profile) => shadowAtlasEdge(engine, profile))).toEqual([4096, 4096, 8192, 8192]);
  });

  it("lets a sun grow the atlas to 16384 within the texture limit, and to 8192 on a phone", () => {
    const engine = (maxTextureSize: number) => ({ getCaps: () => ({ maxTextureSize }) }) as unknown as AbstractEngine;
    expect([shadowAtlasEdgeLimit(engine(32768)), shadowAtlasEdgeLimit(engine(16384)), shadowAtlasEdgeLimit(engine(8192))])
      .toEqual([16384, 16384, 8192]);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)", maxTouchPoints: 5 });
    expect(shadowAtlasEdgeLimit(engine(16384))).toBe(8192);
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

  it("decides with a caller's reused decisions as a fresh plan does, rewriting the same objects", () => {
    // The break: a reused decision keeping its last plan's status, reason or size, or a reuse that makes new objects.
    const host = scene();
    const spots = [0, 1, 2, 3, 4].map((index) => new SpotLight(`spot ${index}`, new Vector3(index, 4, 0), Vector3.Down(), 1, 2, host));
    const lamp = new PointLight("lamp", new Vector3(0, 2, 0), host);
    const entries = new Map([...spots, lamp].map((light) => [light, entry(light)]));
    const input = {
      entries, settings: normalizeShadowSettings({ mapSize: 2048, cascades: 1, maxLocalLights: 8, localMapSize: 1024 }), camera: null,
      previousCamera: null, at: 0, budget: budget(2048), measure: () => 0,
    };
    const reuse: ShadowAdmissionDecision[] = [];
    expect(planShadowAdmission(input, reuse).decisions).toBe(reuse);
    const objects = [...reuse];
    const shape = (decisions: readonly ShadowAdmissionDecision[]) =>
      decisions.map(({ entry: { light }, status, reason, mapSize }) => [light.name, status, reason, mapSize]);
    // The first spot light goes out and the lamp withdraws its request: the fifth spot light takes the room.
    spots[0]!.setEnabled(false);
    entries.get(lamp)!.requested = false;
    const replanned = planShadowAdmission(input, reuse).decisions;
    expect(replanned.every((decision, index) => decision === objects[index])).toBe(true);
    expect(shape(replanned)).toEqual([
      ["spot 0", "disabled", null, 0],
      ...[1, 2, 3, 4].map((index) => [`spot ${index}`, "active", null, 1024]),
      ["lamp", "not-requested", null, 0],
    ]);
    expect(shape(replanned)).toEqual(shape(planShadowAdmission(input).decisions));
    // A light that leaves takes its decision with it.
    entries.delete(lamp);
    expect(planShadowAdmission(input, reuse).decisions).toHaveLength(5);
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
    // A point light's six faces count in the room the sun leaves: Medium's cascades (two 2048 tiles and its last at
    // half that edge, 9.4 Mtexels) and one point light's six 1024 faces (6.3) fit a 4096 atlas's 16.8.
    const lamp = new PointLight("lamp", new Vector3(0, 2, 0), host);
    expect(plan([sun, lamp], 4096, 1024, { mapSize: 2048, cascades: 3 }).decisions.map(({ status, mapSize }) => [status, mapSize]))
      .toEqual([["active", 2048], ["active", 1024]]);
    // Four 2048 cascades: Medium's, its last at half edge (13.6 Mtexels), halve beside the faces; Ultra's, its last two
    // at half edge (10.5), fit.
    const four = (profile: ShadowProfile) =>
      plan([sun, lamp], 4096, 1024, { mapSize: 2048, cascades: 4, profile }).decisions.map(({ mapSize }) => mapSize);
    expect([four("medium"), four("ultra")]).toEqual([[1024, 1024], [2048, 1024]]);
  });

  it("keeps the sun's cascades when the local maps planned would fill the atlas, leaving them at most half of it", () => {
    const host = scene();
    const sun = new DirectionalLight("sun", new Vector3(0, -1, 0), host);
    const lamps = [0, 1, 2].map((index) => new PointLight(`lamp ${index}`, new Vector3(index * 3, 2, 0), host));
    // Three point lights' six 2048 faces (75.5 Mtexels) exceed the 8192 atlas (67.1); the sun keeps its four 2048
    // cascades (its last at half that edge, 13.6) in the half it reserves, two points take 50.3 of the rest and the
    // third's faces fit at 512.
    expect(plan([sun, ...lamps], 8192, 2048, { mapSize: 2048, cascades: 4 }).decisions.map(({ status, mapSize }) => [status, mapSize]))
      .toEqual([["active", 2048], ["active", 2048], ["active", 2048], ["active", 512]]);
  });

  it("caps a spot map at the atlas's edge", () => {
    const host = scene();
    const spot = new SpotLight("spot", new Vector3(0, 4, 0), Vector3.Down(), 1, 2, host);
    expect(plan([spot], 1024, 2048).decisions.map(({ mapSize, reason }) => [mapSize, reason])).toEqual([
      [1024, "shadow map reduced by shadow atlas space"],
    ]);
  });
});

describe("An 8192 Directional Map Size", () => {
  // Per level: its cascades, its own atlas edge, the sun's tiles at 8192 in a 16384 atlas, and the bytes of that 1 GiB
  // atlas past the level's own, which count against no other allocation.
  const levels = [
    ["low", 2, 4096, [8192, 8192], 960 * MIB],
    ["medium", 3, 4096, [8192, 8192, 4096], 960 * MIB],
    // Twice the map size would be the whole atlas: the first cascade keeps the map size.
    ["high", 4, 8192, [8192, 8192, 8192, 4096], 768 * MIB],
    ["ultra", 4, 8192, [8192, 8192, 4096, 4096], 768 * MIB],
  ] as const;

  it.each(levels)("grows the %s atlas to 16384 for the sun's %i cascades at 8192", (profile, cascades, levelEdge, tiles, exempt) => {
    const sun = new DirectionalLight("sun", Vector3.Down(), scene());
    const result = plan([sun], levelEdge, 2048, { mapSize: 8192, cascades, profile }, 16384);
    expect(result.atlasEdge).toBe(16384);
    expect(result.decisions.map(({ status, mapSize, reason }) => [status, mapSize, reason])).toEqual([["active", 8192, null]]);
    expect(cascadeTileSizes(8192, cascades, SHADOW_HALF_TILE_CASCADES[profile], SHADOW_FIRST_CASCADE_SCALE[profile], result.atlasEdge))
      .toEqual(tiles);
    expect(result.admitted).toMatchObject({ bytes: 1024 * MIB, exempt });
  });

  // Low and Medium's atlas still grows to 8192 for 4096 cascades.
  it.each(levels.map(([profile, cascades, levelEdge], index) => [profile, cascades, levelEdge, index < 2 ? 192 * MIB : 0] as const))(
    "falls back to 4096 at %s where the device makes no 16384 atlas", (profile, cascades, levelEdge, exempt) => {
      const sun = new DirectionalLight("sun", Vector3.Down(), scene());
      const result = plan([sun], levelEdge, 2048, { mapSize: 8192, cascades, profile }, 8192);
      expect(result.atlasEdge).toBe(8192);
      expect(result.decisions.map(({ status, mapSize, reason }) => [status, mapSize, reason]))
        .toEqual([["active", 4096, "shadow map reduced by shadow atlas space"]]);
      expect(result.admitted).toMatchObject({ bytes: 256 * MIB, exempt });
    });

  it("grows the atlas only as far as the sun's tiles need, and not without a sun", () => {
    const host = scene();
    const sun = new DirectionalLight("sun", Vector3.Down(), host);
    // High's Custom 4096 cascades fit its own 8192 atlas, the first at the map size; Low's grow its atlas to 8192.
    const high = plan([sun], 8192, 2048, { mapSize: 4096, cascades: 4, profile: "high" }, 16384);
    expect([high.atlasEdge, high.decisions[0]!.mapSize, high.admitted.exempt]).toEqual([8192, 4096, 0]);
    const low = plan([sun], 4096, 512, { mapSize: 4096, cascades: 2, profile: "low" }, 16384);
    expect([low.atlasEdge, low.decisions[0]!.mapSize, low.admitted.exempt]).toEqual([8192, 4096, 192 * MIB]);
    // Local maps never grow it.
    const spot = new SpotLight("spot", new Vector3(0, 4, 0), Vector3.Down(), 1, 2, host);
    const local = plan([spot], 8192, 2048, { mapSize: 8192, cascades: 4, profile: "high" }, 16384);
    expect([local.atlasEdge, local.admitted]).toEqual([8192, { bytes: 256 * MIB, passes: 1, exempt: 0 }]);
  });

  it("keeps the level's local lights beside the sun's 8192 cascades, halving the sun for point lights past their room", () => {
    const host = scene();
    const sun = new DirectionalLight("sun", Vector3.Down(), host);
    const high = { mapSize: 8192, cascades: 4, profile: "high" } as const;
    // High's cascades leave three 4096 quadrants: its four 2048 spot tiles fit.
    const spots = [0, 1, 2, 3].map((index) => new SpotLight(`spot ${index}`, new Vector3(index, 4, 0), Vector3.Down(), 1, 2, host));
    expect(plan([sun, ...spots], 8192, 2048, high, 16384).decisions.map(({ mapSize }) => mapSize)).toEqual([8192, 2048, 2048, 2048, 2048]);
    // Four point lights' 24 faces (100.7 Mtexels) take the reserve: the sun halves to 4096, its first cascade at twice that.
    const lamps = [0, 1, 2, 3].map((index) => new PointLight(`lamp ${index}`, new Vector3(index * 3, 2, 0), host));
    const points = plan([sun, ...lamps], 8192, 2048, high, 16384);
    expect([points.atlasEdge, ...points.decisions.map(({ mapSize }) => mapSize)]).toEqual([16384, 4096, 2048, 2048, 2048, 2048]);
    expect(cascadeTileSizes(4096, 4, 1, 2, 16384)).toEqual([8192, 4096, 4096, 2048]);
  });

  it("halves the first cascade's scale while its tile would be wider than half the atlas, never below the map size", () => {
    // High's own 2048 keeps twice the edge in its 8192 atlas; a 4096 there keeps the map size, as does any single cascade.
    expect([cascadeTileSizes(2048, 4, 1, 2, 8192), cascadeTileSizes(4096, 4, 1, 2, 8192), cascadeTileSizes(8192, 1, 1, 2, 8192)])
      .toEqual([[4096, 2048, 2048, 1024], [4096, 4096, 4096, 2048], [8192]]);
  });
});
