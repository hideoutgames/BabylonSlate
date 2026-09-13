import { describe, expect, it } from "vitest";
import {
  effectiveShadowSettings,
  normalizeShadowSettings,
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
    expect(normalizeShadowSettings(undefined).distance).toBe(200);
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
  it("rejects nonfinite values and keeps CEL independent of PBR contact hardening", () => {
    const requested = normalizeShadowSettings({
      distance: Infinity,
      normalBias: NaN,
      filter: "pcss",
    });
    expect(requested.distance).toBe(200);
    expect(
      effectiveShadowSettings(requested, false, "cel").settings,
    ).toMatchObject({ cascades: 1, filter: "pcf" });
    expect(effectiveShadowSettings(requested).settings.filter).toBe("pcss");
  });
});
