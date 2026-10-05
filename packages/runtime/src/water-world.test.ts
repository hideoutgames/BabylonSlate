import { describe, expect, it, vi } from "vitest";
import { Actor, ActorComponent } from "@babylonslate/object-model";
import { createDefaultWaterDefinition, normalizeWaterBody } from "@babylonslate/core";
import { composeActorWorldTransformsInto } from "./actor-world-transform";
import { WaterWorld } from "./water-world";

// Pass-through spies: count how often the worker normalizes water components and composes actor poses.
vi.mock("@babylonslate/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@babylonslate/core")>();
  return { ...core, normalizeWaterBody: vi.fn(core.normalizeWaterBody) };
});
vi.mock("./actor-world-transform", async (importOriginal) => {
  const transforms = await importOriginal<typeof import("./actor-world-transform")>();
  return { ...transforms, composeActorWorldTransformsInto: vi.fn(transforms.composeActorWorldTransformsInto) };
});

describe("Water world caching", () => {
  it("shares one evaluation between a tick's queries, sees same-tick edits and reuses unchanged components", () => {
    const normalize = vi.mocked(normalizeWaterBody), compose = vi.mocked(composeActorWorldTransformsInto);
    const lake = new Actor({ guid: "lake", classId: "Actor" });
    const component = new ActorComponent({ classId: "WaterLakeComponent", variables: { assetGuid: "water", width: 10, length: 10 } });
    lake.attachComponent(component);
    const actors = [lake, new Actor({ guid: "bystander", classId: "Actor" })], tick = 1 / 60;
    const water = new WaterWorld();
    water.setContent({ water: { ...createDefaultWaterDefinition(), waveHeight: 0 } });
    normalize.mockClear(); compose.mockClear();
    const found = (time = 0, actorId: string | null = null) => water.query(actors, time, { x: 4, y: -1, z: 0 }, actorId).found;
    expect(found()).toBe(true);
    // Further queries in the tick, including ones filtered to the lake, reuse that evaluation while nothing they
    // depend on changes.
    actors[1]!.transform.position.x = 50;
    for (let i = 0; i < 5; i++) expect(found(0, i % 2 ? "lake" : null)).toBe(true);
    expect([normalize.mock.calls.length, compose.mock.calls.length]).toEqual([1, 1]);
    // A script edit to the water in the same tick still applies to the next query.
    component.setVariable("width", 4);
    expect(found()).toBe(false);
    expect([normalize.mock.calls.length, compose.mock.calls.length]).toEqual([2, 2]);
    lake.transform.position.x = 3;
    expect(found()).toBe(true);
    // Later ticks evaluate again but keep the normalized body while its variables are unchanged, and the physics
    // step's own evaluation shares it.
    for (let i = 1; i < 6; i++) found(i * tick);
    water.update(actors, 6 * tick);
    expect(water.sample({ x: 4, y: -1, z: 0 }).found).toBe(true);
    expect(normalize).toHaveBeenCalledTimes(2);
    expect(compose.mock.calls.length).toBeGreaterThan(6);
  });
});
