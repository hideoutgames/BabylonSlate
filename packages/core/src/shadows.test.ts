import { describe, expect, it } from "vitest";
import { effectiveShadowSettings, normalizeShadowSettings, resolveShadowSettings } from "./shadows";

describe("shadow settings", () => {
  it("inherits live project values after removing an independent scene override", () => {
    const project = normalizeShadowSettings({ distance: 350, normalBias: 0.02 });
    expect(resolveShadowSettings(project, { distance: 75 })).toMatchObject({ distance: 75, normalBias: 0.02 });
    expect(resolveShadowSettings(project, {})).toMatchObject({ distance: 350, normalBias: 0.02 });
    expect(normalizeShadowSettings(undefined).distance).toBe(200);
  });
  it("caps expensive options without changing authored values or shadow distance", () => {
    const requested = normalizeShadowSettings({ profile: "ultra", distance: 800, filter: "pcss" });
    const result = effectiveShadowSettings(requested, "a16");
    expect(result.settings).toMatchObject({ distance: 800, cascades: 2, mapSize: 1024, filter: "pcf", maxLocalLights: 1 });
    expect(requested).toMatchObject({ distance: 800, cascades: 4, filter: "pcss" });
    expect(result.limits.length).toBeGreaterThan(0);
  });
  it("rejects nonfinite values and keeps CEL independent of PBR contact hardening", () => {
    const requested = normalizeShadowSettings({ distance: Infinity, normalBias: NaN, filter: "pcss" });
    expect(requested.distance).toBe(200);
    expect(effectiveShadowSettings(requested, "project", false, "cel").settings).toMatchObject({ cascades: 1, filter: "pcf" });
    expect(effectiveShadowSettings(requested).settings.filter).toBe("pcss");
  });
});
