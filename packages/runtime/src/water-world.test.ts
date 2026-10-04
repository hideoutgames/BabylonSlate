import { describe, expect, it, vi } from "vitest";
import { Actor, ActorComponent } from "@babylonslate/object-model";
import { createDefaultWaterDefinition, normalizeWaterBody } from "@babylonslate/core";
import { actorWorldTransforms } from "./actor-world-transform";
import { WaterWorld } from "./water-world";

// Pass-through spies: count how often the worker normalizes water components and rescans actor transforms.
vi.mock("@babylonslate/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@babylonslate/core")>();
  return { ...core, normalizeWaterBody: vi.fn(core.normalizeWaterBody) };
});
vi.mock("./actor-world-transform", async (importOriginal) => {
  const transforms = await importOriginal<typeof import("./actor-world-transform")>();
  return { ...transforms, actorWorldTransforms: vi.fn(transforms.actorWorldTransforms) };
});

describe("Water world caching", () => {
  it("shares one scan between a tick's queries, sees same-tick edits and reuses unchanged components", () => {
    const normalize = vi.mocked(normalizeWaterBody), scan = vi.mocked(actorWorldTransforms);
    const lake = new Actor({ guid: "lake", classId: "Actor" });
    const component = new ActorComponent({ classId: "WaterLakeComponent", variables: { assetGuid: "water", width: 10, length: 10 } });
    lake.attachComponent(component);
    const actors = [lake, new Actor({ guid: "bystander", classId: "Actor" })], tick = 1 / 60;
    const water = new WaterWorld();
    water.setContent({ water: { ...createDefaultWaterDefinition(), waveHeight: 0 } });
    normalize.mockClear(); scan.mockClear();
    const found = () => water.sample({ x: 4, y: -1, z: 0 }).found;
    water.sync(actors, 0);
    expect(found()).toBe(true);
    // Further queries in the tick reuse that scan while nothing they depend on changes.
    actors[1]!.transform.position.x = 50;
    for (let i = 0; i < 5; i++) water.sync(actors, 0);
    expect([normalize.mock.calls.length, scan.mock.calls.length]).toEqual([1, 1]);
    // A script edit to the water in the same tick still applies to the next query.
    component.setVariable("width", 4);
    water.sync(actors, 0);
    expect(found()).toBe(false);
    expect([normalize.mock.calls.length, scan.mock.calls.length]).toEqual([2, 2]);
    lake.transform.position.x = 3;
    water.sync(actors, 0);
    expect(found()).toBe(true);
    // Later ticks rescan transforms but keep the normalized body while its variables are unchanged.
    for (let i = 1; i < 6; i++) water.sync(actors, i * tick);
    water.update(actors, 6 * tick);
    expect(found()).toBe(true);
    expect(normalize).toHaveBeenCalledTimes(2);
    expect(scan.mock.calls.length).toBeGreaterThan(6);
  });
});
