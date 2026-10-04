import { describe, expect, it, vi } from "vitest";
import { Actor, ActorComponent } from "@babylonslate/object-model";
import { createDefaultWaterDefinition, normalizeWaterBody } from "@babylonslate/core";
import { WaterWorld } from "./water-world";

// Pass-through spy: counts how often the worker normalizes water components.
vi.mock("@babylonslate/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@babylonslate/core")>();
  return { ...core, normalizeWaterBody: vi.fn(core.normalizeWaterBody) };
});

describe("Water world caching", () => {
  it("scans water once per simulation tick and reuses unchanged components between ticks", () => {
    const normalize = vi.mocked(normalizeWaterBody);
    const lake = new Actor({ guid: "lake", classId: "Actor" });
    const component = new ActorComponent({ classId: "WaterLakeComponent", variables: { assetGuid: "water", width: 10, length: 10 } });
    lake.attachComponent(component);
    const actors = [lake], tick = 1 / 60;
    const water = new WaterWorld();
    water.setContent({ water: { ...createDefaultWaterDefinition(), waveHeight: 0 } });
    normalize.mockClear();
    water.sync(actors, 0);
    expect(water.sample({ x: 4, y: -1, z: 0 }).found).toBe(true);
    // Further queries in the same tick share that scan, so an edit applies from the next tick.
    component.setVariable("width", 4);
    for (let i = 0; i < 5; i++) water.sync(actors, 0);
    expect(water.sample({ x: 4, y: -1, z: 0 }).found).toBe(true);
    expect(normalize).toHaveBeenCalledTimes(1);
    water.sync(actors, tick);
    expect(water.sample({ x: 4, y: -1, z: 0 }).found).toBe(false);
    expect(normalize).toHaveBeenCalledTimes(2);
    // Later ticks rescan transforms but keep the normalized body while its variables are unchanged.
    lake.transform.position.x = 3;
    for (let i = 2; i < 6; i++) water.sync(actors, i * tick);
    water.update(actors, 6 * tick);
    expect(water.sample({ x: 4, y: -1, z: 0 }).found).toBe(true);
    expect(normalize).toHaveBeenCalledTimes(2);
  });
});
