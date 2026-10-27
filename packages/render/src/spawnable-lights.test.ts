import { describe, expect, it } from "vitest";
import type { ScriptBundleEntry } from "@haptic/bridge";
import { spawnsUnseenClasses } from "./spawnable-lights";

const script = (classId: string, source = ""): ScriptBundleEntry =>
  ({ assetGuid: classId.toLowerCase(), classId, source, anchors: [], entryPoints: [] });

describe("spawnsUnseenClasses", () => {
  it("counts a Deferred Spawn Actor's Class like a Spawn Actor's", () => {
    const spawner = script("Spawner", 'out = await ctx.beginDeferredSpawnActorAsync("Torch", transform);');
    const load = (scripts: ScriptBundleEntry[]) => spawnsUnseenClasses({ scripts, assets: [], isClass: () => true });
    expect([load([spawner]), load([spawner, script("Torch")])]).toEqual([true, false]);
  });
});
