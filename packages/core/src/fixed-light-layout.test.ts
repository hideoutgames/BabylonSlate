import { describe, expect, it } from "vitest";
import {
  EMPTY_FIXED_LIGHT_INVENTORY,
  fixedLightDeviceClass,
  fixedLightLayout,
  growFixedLightInventory,
  type FixedLightInventory,
  type FixedLightKind,
  type FixedLightLayoutInput,
} from "./fixed-light-layout";

type Counts = Partial<Record<FixedLightKind, Partial<{ lights: number; shadowCasters: number; textured: number }>>>;

function inventory(counts: Counts): FixedLightInventory {
  const result = { ...EMPTY_FIXED_LIGHT_INVENTORY };
  for (const [kind, count] of Object.entries(counts) as [FixedLightKind, Counts[FixedLightKind]][])
    result[kind] = { lights: 0, shadowCasters: 0, textured: 0, ...count };
  return result;
}

function layout(counts: Counts, overrides: Partial<FixedLightLayoutInput> = {}) {
  return fixedLightLayout({
    device: "webgl2",
    slots: 9,
    samplers: 8,
    shadows: { filter: "pcf", cascades: 2, maxLocalLights: 8 },
    inventory: inventory(counts),
    ...overrides,
  });
}

const seats = (result: ReturnType<typeof fixedLightLayout>) =>
  Object.fromEntries(result.classes.map((entry) => [entry.id, entry.seats]));

// More lights of every kind than any device seats, with shadows and emission.
const crowded: Counts = {
  directional: { lights: 2, shadowCasters: 1 },
  hemispheric: { lights: 2 },
  spot: { lights: 12, shadowCasters: 6 },
  point: { lights: 12, shadowCasters: 6 },
  area: { lights: 4, textured: 4 },
};

describe("fixed light layout", () => {
  it("takes the cap column from the device's Forward light budget", () => {
    expect(fixedLightDeviceClass({ webgpu: true, slots: 8 })).toBe("webgpu");
    expect(fixedLightDeviceClass({ webgpu: true, slots: 16 })).toBe("webgpuRaised");
    expect(fixedLightDeviceClass({ webgpu: false, slots: 13 })).toBe("webgl2");
  });

  it.each([
    ["webgl2", 9, { SUN: 1, FILL: 1, SPOT_SHADOW: 2, POINT_SHADOW: 1, LOCAL_SPOT: 2, LOCAL_POINT: 1, AREA: 1 }],
    ["webgpu", 8, { SUN: 1, FILL: 1, SPOT_SHADOW: 2, POINT_SHADOW: 1, LOCAL_SPOT: 1, LOCAL_POINT: 1, AREA: 1 }],
    // Emission and one point shadow seat give way to the eight lighting samplers.
    ["webgpuRaised", 16, { SUN: 1, FILL: 1, SPOT_SHADOW: 4, POINT_SHADOW: 1, LOCAL_SPOT: 4, LOCAL_POINT: 3, AREA: 2 }],
  ] as const)("caps each class on %s and gives the remaining %i slots to local lights", (device, slots, expected) => {
    const result = layout(crowded, { device, slots });
    expect(seats(result)).toEqual(expected);
    expect(result.seats).toBe(slots);
    expect(result.samplers).toBeLessThanOrEqual(8);
  });

  it("never seats more than the raised WebGPU cap", () => {
    expect(layout(crowded, { device: "webgpuRaised", slots: 20 }).seats).toBe(16);
  });

  it("sizes each class by the inventory rather than the device maximum", () => {
    const result = layout({ directional: { lights: 1 }, point: { lights: 3 } });
    expect(seats(result)).toEqual({ SUN: 1, FILL: 0, SPOT_SHADOW: 0, POINT_SHADOW: 0, LOCAL_SPOT: 0, LOCAL_POINT: 3, AREA: 0 });
    expect(result.samplers).toBe(0);
    expect(result.classes.every((entry) => entry.shadow === null)).toBe(true);
  });

  it("gives every local light a seat, shadow casters beyond their class unshadowed in their own kind's seats", () => {
    const result = layout({ spot: { lights: 3, shadowCasters: 3 }, point: { lights: 1 } });
    expect(seats(result)).toMatchObject({ SPOT_SHADOW: 2, LOCAL_SPOT: 1, LOCAL_POINT: 1 });
    expect(result.seats).toBe(4);
  });

  it("changes only when the inventory high-water mark grows", () => {
    const small = inventory({ spot: { lights: 2, shadowCasters: 1 } });
    const fewer = inventory({ spot: { lights: 1 } });
    expect(growFixedLightInventory(small, fewer)).toBe(small);
    const grown = growFixedLightInventory(small, inventory({ spot: { lights: 1, shadowCasters: 1 }, point: { lights: 2 } }));
    expect(grown).toEqual(inventory({ spot: { lights: 2, shadowCasters: 1 }, point: { lights: 2 } }));
    const before = fixedLightLayout({ device: "webgl2", slots: 9, samplers: 8, shadows: { filter: "pcf", cascades: 1, maxLocalLights: 2 }, inventory: small });
    const after = fixedLightLayout({ device: "webgl2", slots: 9, samplers: 8, shadows: { filter: "pcf", cascades: 1, maxLocalLights: 2 }, inventory: grown });
    expect(after.seats).toBe(before.seats + 2);
    expect(after.key).not.toBe(before.key);
  });

  it("keeps the shadow seats within the shadow profile's local shadow lights, point maps first", () => {
    const result = layout(
      { spot: { lights: 2, shadowCasters: 2 }, point: { lights: 1, shadowCasters: 1 } },
      { shadows: { filter: "pcf", cascades: 1, maxLocalLights: 1 } },
    );
    expect(seats(result)).toMatchObject({ SPOT_SHADOW: 1, POINT_SHADOW: 0, LOCAL_SPOT: 1, LOCAL_POINT: 1 });
    expect(result.trims.join()).toContain("POINT_SHADOW: seat over the shadow profile's 1 local shadow lights");
    const none = layout({ spot: { lights: 2, shadowCasters: 2 } }, { shadows: { filter: "pcf", cascades: 1, maxLocalLights: 0 } });
    expect(seats(none)).toMatchObject({ SPOT_SHADOW: 0, LOCAL_SPOT: 2, LOCAL_POINT: 0 });
  });

  it("fits the lighting sampler headroom by dropping emission, then point and spot shadow seats", () => {
    // PCSS: two samplers per spot map and two for the sun's.
    const pcss = layout(crowded, { device: "webgpuRaised", slots: 16, shadows: { filter: "pcss", cascades: 4, maxLocalLights: 8 } });
    expect(seats(pcss)).toMatchObject({ SPOT_SHADOW: 2, POINT_SHADOW: 0, AREA: 2 });
    expect(pcss.classes.find((entry) => entry.id === "AREA")?.textured).toBe(false);
    expect(pcss.samplers).toBe(8);
    const tight = layout(crowded, { samplers: 3 });
    expect(seats(tight)).toMatchObject({ SUN: 1, SPOT_SHADOW: 0, POINT_SHADOW: 0, AREA: 1 });
    expect(tight.classes.find((entry) => entry.id === "SUN")?.shadow).toBe("directional");
    expect(tight.samplers).toBe(3);
    // Without any headroom the sun loses its map and area lights their seats.
    const none = layout(crowded, { samplers: 0 });
    expect(none.samplers).toBe(0);
    expect(seats(none)).toMatchObject({ SUN: 1, AREA: 0 });
    expect(none.classes.find((entry) => entry.id === "SUN")?.shadow).toBeNull();
  });

  it("seats no more lights than the device's slots", () => {
    const result = layout(crowded, { slots: 4 });
    expect(result.seats).toBe(4);
    expect(seats(result)).toMatchObject({ SUN: 1, FILL: 1 });
  });

  it("identifies a layout by its seats, shadows, emission, filter and cascades", () => {
    const shadowed = layout({ directional: { lights: 1, shadowCasters: 1 }, area: { lights: 1, textured: 1 } });
    expect(shadowed.key).toBe("SUN1s,FILL0,SPOT_SHADOW0,POINT_SHADOW0,LOCAL_SPOT0,LOCAL_POINT0,AREA1t|pcf,c2");
    expect(layout({ directional: { lights: 1, shadowCasters: 1 } }, { shadows: { filter: "pcf", cascades: 4, maxLocalLights: 2 } }).key)
      .not.toBe(layout({ directional: { lights: 1, shadowCasters: 1 } }).key);
    expect(layout({ directional: { lights: 1 } }).key).toBe("SUN1,FILL0,SPOT_SHADOW0,POINT_SHADOW0,LOCAL_SPOT0,LOCAL_POINT0,AREA0");
  });

  it("shares the slots left between spot and point seats, one each in turn, and never lends a kind's seat to the other", () => {
    // Four slots for six spots and six points: two seats each, so two spots and two points are limited.
    expect(seats(layout({ spot: { lights: 6 }, point: { lights: 6 } }, { slots: 4 }))).toMatchObject({ LOCAL_SPOT: 2, LOCAL_POINT: 2 });
    // One spot: the points take every other slot.
    expect(seats(layout({ spot: { lights: 1 }, point: { lights: 10 } }))).toMatchObject({ LOCAL_SPOT: 1, LOCAL_POINT: 8 });
  });
});
