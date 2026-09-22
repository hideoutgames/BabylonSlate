import { describe, expect, it } from "vitest";
import {
  resolveDirectionalShadowBias,
  type DirectionalShadowBiasInput,
} from "./shadow-bias";

const projection: DirectionalShadowBiasInput = {
  width: 100,
  height: 100,
  depth: 100,
  mapWidth: 1000,
  mapHeight: 1000,
  filter: "pcf",
  filterQuality: "low",
  depthClamp: false,
  authoredDepthBias: 0.0001,
  authoredNormalBias: 0.005,
};

describe("directional automatic shadow bias", () => {
  it.each([
    { filter: "pcf", depthClamp: false, bias: 0.001, depthScale: 0.5 },
    { filter: "pcf", depthClamp: true, bias: 1 / 3000, depthScale: 1.5 },
    { filter: "pcss", depthClamp: true, bias: 0.001, depthScale: 0.5 },
    { filter: "none", depthClamp: false, bias: 0.0005, depthScale: 1 },
  ] as const)(
    "preserves the same world-depth correction for $filter with clamp=$depthClamp",
    ({ filter, depthClamp, bias, depthScale }) => {
      const effective = resolveDirectionalShadowBias({
        ...projection,
        filter,
        depthClamp,
      });
      expect(effective.bias).toBeCloseTo(bias, 12);
      expect(effective.depthScale).toBe(depthScale);
      // 0.1-world-unit texels need a 0.05-world-unit base correction. These
      // independently derived comparison-depth factors are the pinned contract.
      expect(effective.bias * depthScale * 100).toBeCloseTo(0.05, 12);
    },
  );

  it("uses the limiting axis of actual allocation and current projection depth", () => {
    const downsize = resolveDirectionalShadowBias({
      ...projection,
      width: 80,
      height: 160,
      mapWidth: 1000,
      mapHeight: 400,
    });
    expect(downsize.worldTexelSize).toBe(0.4);
    expect(downsize.bias).toBe(0.004);
    const recovery = resolveDirectionalShadowBias({
      ...projection,
      width: 80,
      height: 160,
      depth: 200,
      mapWidth: 1000,
      mapHeight: 1600,
    });
    expect(recovery.worldTexelSize).toBe(0.1);
    expect(recovery.bias).toBe(0.0005);
  });

  it("uses PCF reconstruction width but does not mistake PCSS tap count for width", () => {
    expect(
      resolveDirectionalShadowBias({ ...projection, filterQuality: "medium" })
        .bias,
    ).toBeCloseTo(0.003, 12);
    expect(
      resolveDirectionalShadowBias({ ...projection, filterQuality: "high" })
        .bias,
    ).toBeCloseTo(0.005, 12);
    for (const filterQuality of ["low", "medium", "high"] as const) {
      expect(
        resolveDirectionalShadowBias({
          ...projection,
          filter: "pcss",
          filterQuality,
        }).bias,
      ).toBeCloseTo(0.001, 12);
    }
  });

  it("uses the effective Poisson radius independently of requested quality", () => {
    for (const filterQuality of ["low", "high"] as const) {
      const effective = resolveDirectionalShadowBias({
        ...projection,
        filter: "poisson",
        filterQuality,
        poissonRadiusTexels: 2,
      });
      expect(effective.bias).toBeCloseTo(0.002, 12);
    }
    expect(
      resolveDirectionalShadowBias({
        ...projection,
        filter: "poisson",
        poissonRadiusTexels: 1,
      }).bias,
    ).toBeCloseTo(0.001, 12);
  });

  it("preserves authored floors and never increases normal inset at coarse resolutions", () => {
    const authored = Object.freeze({
      ...projection,
      authoredDepthBias: 0.01,
      authoredNormalBias: 0.0002,
    });
    expect(resolveDirectionalShadowBias(authored).bias).toBe(0.01);
    const coarse = resolveDirectionalShadowBias({ ...authored, mapWidth: 1 });
    expect(coarse.normalBias).toBe(0.0002);
    expect(coarse.bias).toBe(0.05);
    expect(authored.authoredDepthBias).toBe(0.01);
    expect(authored.authoredNormalBias).toBe(0.0002);
    expect(
      resolveDirectionalShadowBias({ ...projection, authoredNormalBias: 0 })
        .normalBias,
    ).toBe(0);
  });

  it.each([
    { width: 0 },
    { height: -1 },
    { depth: Number.NaN },
    { mapWidth: 0 },
    { mapHeight: Number.POSITIVE_INFINITY },
  ])(
    "retains authored bias while projection/allocation is unavailable: %j",
    (invalid) => {
      const effective = resolveDirectionalShadowBias({
        ...projection,
        ...invalid,
      });
      expect(effective.bias).toBe(0.0001);
      expect(effective.normalBias).toBe(0.005);
      expect(effective.worldTexelSize).toBe(0);
    },
  );

  it("keeps recovering extreme and invalid scalar states finite", () => {
    const effective = resolveDirectionalShadowBias({
      ...projection,
      width: Number.MAX_VALUE,
      depth: Number.MIN_VALUE,
      authoredDepthBias: Number.NaN,
      authoredNormalBias: Number.POSITIVE_INFINITY,
    });
    expect(effective.bias).toBe(0.05);
    expect(effective.normalBias).toBe(0);
    expect(Number.isFinite(effective.worldTexelSize)).toBe(true);
  });
});
