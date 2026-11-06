import { describe, expect, it } from "vitest";
import {
  componentCastsShadows,
  effectiveShadowSettings,
  normalizeShadowSettings,
  normalizeShadowOverrides,
  resolveShadowSettings,
} from "./shadows";

describe("shadow settings", () => {
  it("inherits live project values after removing an independent scene override", () => {
    const project = normalizeShadowSettings({
      distance: 350,
      normalBias: 0.02,
    });
    expect(resolveShadowSettings(project, { distance: 75 })).toMatchObject({
      distance: 75,
      normalBias: 0.02,
    });
    expect(resolveShadowSettings(project, {})).toMatchObject({
      distance: 350,
      normalBias: 0.02,
    });
    expect(normalizeShadowSettings(undefined).distance).toBe(250);
  });
  it("preserves user budgets and PBR filters without hardware policy caps", () => {
    const requested = normalizeShadowSettings({
      profile: "ultra",
      distance: 800,
      filter: "pcss",
      maxLocalLights: 12,
    });
    const result = effectiveShadowSettings(requested);
    expect(result.settings).toMatchObject({
      distance: 800,
      cascades: 4,
      mapSize: 4096,
      filter: "pcss",
      maxLocalLights: 12,
    });
    expect(requested).toMatchObject({
      distance: 800,
      cascades: 4,
      filter: "pcss",
    });
    expect(result.limits).toEqual([]);
  });
  it("snaps map sizes up to a power of two, the sun's to at most 8192 and a local light's to at most 4096", () => {
    expect([
      normalizeShadowOverrides({ mapSize: 8192, localMapSize: 8192 }),
      normalizeShadowOverrides({ mapSize: 4097, localMapSize: 4097 }),
      normalizeShadowOverrides({ mapSize: 1e6, localMapSize: 1e6 }),
      normalizeShadowOverrides({ mapSize: 4096, localMapSize: 300 }),
      normalizeShadowOverrides({ mapSize: -1, localMapSize: 256 }),
    ]).toEqual([
      { mapSize: 8192, localMapSize: 4096 },
      { mapSize: 8192, localMapSize: 4096 },
      { mapSize: 8192, localMapSize: 4096 },
      { mapSize: 4096, localMapSize: 512 },
      { mapSize: 256, localMapSize: 256 },
    ]);
  });
  it("makes any level Custom at an 8192 Directional Map Size", () => {
    for (const profile of ["low", "medium", "high", "ultra"] as const)
      expect(normalizeShadowSettings({ profile, preset: profile, mapSize: 8192 })).toMatchObject({ profile, preset: "custom", mapSize: 8192 });
  });
  it("rejects nonfinite values and keeps CEL independent of PBR contact hardening", () => {
    const requested = normalizeShadowSettings({
      distance: Infinity,
      normalBias: NaN,
      filter: "pcss",
    });
    expect(requested.distance).toBe(250);
    expect(
      effectiveShadowSettings(requested, false, "cel").settings,
    ).toMatchObject({ cascades: 1, filter: "pcf" });
    expect(effectiveShadowSettings(requested).settings.filter).toBe("pcss");
  });
  it("gives Screen-Space Shadows by level, keeps a valid authored level and turns them off in CEL", () => {
    expect((["low", "medium", "high", "ultra"] as const).map((profile) => normalizeShadowSettings({ profile }).screenShadows))
      .toEqual(["off", "off", "medium", "high"]);
    expect(normalizeShadowOverrides({ screenShadows: "high" })).toEqual({ screenShadows: "high" });
    expect(normalizeShadowOverrides({ screenShadows: "ultra" })).toEqual({});
    const requested = normalizeShadowSettings({ profile: "low", screenShadows: "medium" });
    expect(requested).toMatchObject({ screenShadows: "medium", preset: "custom" });
    expect(effectiveShadowSettings(requested).settings.screenShadows).toBe("medium");
    expect(effectiveShadowSettings(requested, true, "cel")).toMatchObject({
      settings: { screenShadows: "off" }, limits: ["screen shadows: not in CEL"],
    });
  });
  it("gives Reflection Shadows at Ultra only, keeps an authored value and drops one that is not a switch", () => {
    expect((["low", "medium", "high", "ultra"] as const).map((profile) => normalizeShadowSettings({ profile }).reflections))
      .toEqual([false, false, false, true]);
    expect(normalizeShadowOverrides({ reflections: true })).toEqual({ reflections: true });
    expect(normalizeShadowOverrides({ reflections: "on" })).toEqual({});
    // Turned on at High it is no longer High's set; turned off at Ultra, no longer Ultra's.
    expect(normalizeShadowSettings({ profile: "high", reflections: true })).toMatchObject({ reflections: true, preset: "custom" });
    expect(normalizeShadowSettings({ profile: "ultra", preset: "ultra", reflections: false })).toMatchObject({ reflections: false, preset: "custom" });
    // A scene can override the project's.
    expect(resolveShadowSettings(normalizeShadowSettings({ profile: "ultra" }), { reflections: false }).reflections).toBe(false);
    // Neither the device nor CEL changes it.
    expect(effectiveShadowSettings(normalizeShadowSettings({ profile: "ultra" }), false, "cel").settings.reflections).toBe(true);
  });

  it("selects Auto capacity by quality without overwriting a saved Manual limit", () => {
    for (const [profile, expected] of [
      ["low", 1],
      ["medium", 2],
      ["high", 4],
      ["ultra", 8],
    ] as const) {
      const requested = normalizeShadowSettings({
        profile,
        localLightMode: "auto",
        maxLocalLights: 16,
      });
      expect(effectiveShadowSettings(requested).settings.maxLocalLights).toBe(
        expected,
      );
      expect(requested.maxLocalLights).toBe(16);
    }
  });
  it("reads a capacity without a mode as manual but keeps sparse capacity and mode overrides independent", () => {
    expect(normalizeShadowSettings({ maxLocalLights: 4 }).localLightMode).toBe(
      "manual",
    );
    expect(normalizeShadowSettings(undefined).localLightMode).toBe("auto");
    const project = normalizeShadowSettings({ localLightMode: "auto" });
    expect(normalizeShadowOverrides({ maxLocalLights: 0 })).toEqual({
      maxLocalLights: 0,
    });
    const resetMode = resolveShadowSettings(project, { maxLocalLights: 0 });
    expect(resetMode.localLightMode).toBe("auto");
    expect(effectiveShadowSettings(resetMode).settings.maxLocalLights).toBe(2);
    expect(
      effectiveShadowSettings(
        resolveShadowSettings(project, {
          localLightMode: "manual",
          maxLocalLights: 0,
        }),
      ).settings.maxLocalLights,
    ).toBe(0);
  });
});

describe("component Cast Shadows defaults", () => {
  it("leaves unlit visuals out of shadow maps unless Cast Shadows is set, and every other visual in", () => {
    expect(["SpriteComponent", "TilemapComponent", "Text3DComponent", "MeshComponent", "CableComponent"].map((classId) =>
      [classId, componentCastsShadows(classId, undefined), componentCastsShadows(classId, true), componentCastsShadows(classId, false)]))
      .toEqual([
        ["SpriteComponent", false, true, false],
        ["TilemapComponent", false, true, false],
        ["Text3DComponent", false, true, false],
        ["MeshComponent", true, true, false],
        ["CableComponent", true, true, false],
      ]);
  });
});
