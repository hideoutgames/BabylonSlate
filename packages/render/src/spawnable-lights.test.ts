import { describe, expect, it } from "vitest";
import type { ScriptBundleEntry } from "@haptic/bridge";
import { spawnableLightsFromScripts, spawnsLights2D, spawnsUnseenClasses } from "./spawnable-lights";

const script = (classId: string, source = ""): ScriptBundleEntry =>
  ({ assetGuid: classId.toLowerCase(), classId, source, anchors: [], entryPoints: [] });

describe("spawnsUnseenClasses", () => {
  it.each([
    ["Spawn Actor Deferred (Async)", 'out = await ctx.beginDeferredSpawnActorAsync("Torch", transform);'],
    ["Spawn Actor (Blocking)", 'out = await ctx.spawnActorAsync("Torch", transform, { blocking: true });'],
    ["Spawn Actor Deferred (Blocking)", 'out = await ctx.beginDeferredSpawnActorAsync("Torch", transform, { blocking: true });'],
  ])("counts the Class of %s like Spawn Actor (Async)'s", (_node, source) => {
    const spawner = script("Spawner", source);
    const load = (scripts: ScriptBundleEntry[]) => spawnsUnseenClasses({ scripts, assets: [], isClass: () => true });
    expect([load([spawner]), load([spawner, script("Torch")])]).toEqual([true, false]);
  });
});

describe("spawnsLights2D", () => {
  it("turns on for a 2D Light a Class carries or names in Add Component, never for a class from a pin", () => {
    const carried = { ...script("Lamp"), components: [{ id: "glow", classId: "Light2DComponent", properties: {} }] } as ScriptBundleEntry;
    const named = script("Adder", 'ctx.addComponent(ctx.self, "Light2DComponent", transform);');
    const dynamic = script("AnyAdder", "ctx.addComponent(ctx.self, chosenClass, transform);");
    const of = (entry: ScriptBundleEntry) => spawnsLights2D(spawnableLightsFromScripts([entry]).values());
    expect([of(carried), of(named), of(dynamic), of(script("Plain"))]).toEqual([true, true, false, false]);
    // The pin-fed Add Component still stands for every 3D light kind.
    expect([...spawnableLightsFromScripts([dynamic]).values()].map((light) => light.kind)).toEqual(["point", "hemispheric"]);
  });
});
