import { describe, expect, it } from "vitest";
import { createDefaultScene } from "@haptic/core";
import { playSessionLoad } from "./play-session-boot";
import type { PlaySessionOptions } from "./play-session-types";

describe("Play session load", () => {
  it("carries the Global Parameter catalog, so Class graphs set and read the Play scene's collections", () => {
    const catalog = { collection: [{ id: "wind", name: "Wind Strength", type: "float" as const, defaultValue: [1] }] };
    const options = {
      scene: createDefaultScene(),
      globalParameterCatalog: catalog,
    } as unknown as PlaySessionOptions;
    expect(playSessionLoad(options, false).loadControl.globalParameterCatalog).toEqual(catalog);
  });

  it("starts each session from a fresh seed, so the normal Random nodes differ between runs", () => {
    const options = { scene: createDefaultScene() } as unknown as PlaySessionOptions;
    const seeds = new Set(Array.from({ length: 4 }, () => playSessionLoad(options, false).loadControl.seed));
    expect(seeds.size).toBeGreaterThan(1);
    for (const seed of seeds) expect(Number.isInteger(seed)).toBe(true);
  });
});
