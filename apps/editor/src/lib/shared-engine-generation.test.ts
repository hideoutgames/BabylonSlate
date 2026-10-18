import { describe, expect, it } from "vitest";
import {
  isUsableEngine,
  nextRegisteredSharedEngine,
  nextSharedEngineGeneration,
} from "./shared-engine-generation";

describe("shared engine generation", () => {
  it("bumps when the engine instance changes", () => {
    const first = { isDisposed: false };
    const second = { isDisposed: false };
    expect(nextSharedEngineGeneration(0, first, first)).toBe(0);
    expect(nextSharedEngineGeneration(0, second, first)).toBe(1);
  });

  it("treats a disposed engine or a lost WebGPU device as unusable", () => {
    expect(isUsableEngine({ isDisposed: true })).toBe(false);
    expect(isUsableEngine({ isDisposed: false })).toBe(true);
    expect(isUsableEngine(null)).toBe(false);
    // Babylon's own lost-context flag: a lost WebGPU device never recovers in place.
    const lostWebGpu = { isDisposed: false, isWebGPU: true, _contextWasLost: true };
    const liveWebGpu = { isDisposed: false, isWebGPU: true, _contextWasLost: false };
    expect(isUsableEngine(lostWebGpu)).toBe(false);
    expect(isUsableEngine(liveWebGpu)).toBe(true);
    // Babylon restores a lost WebGL2 context on the same Engine, so its clients keep it.
    const lostWebGl = { isDisposed: false, isWebGPU: false, _contextWasLost: true };
    expect(isUsableEngine(lostWebGl)).toBe(true);
  });
});

describe("nextRegisteredSharedEngine", () => {
  const viewport = { isDisposed: false };
  const owned = { isDisposed: false };

  it("keeps a still-usable engine when the viewport unregisters", () => {
    expect(
      nextRegisteredSharedEngine({ incoming: null, previous: viewport, owned: null }),
    ).toBe(viewport);
  });

  it("prefers the project-owned engine when the viewport unregisters", () => {
    expect(
      nextRegisteredSharedEngine({ incoming: null, previous: viewport, owned }),
    ).toBe(owned);
  });

  it("accepts a usable incoming engine over the previous one", () => {
    const remounted = { isDisposed: false };
    expect(
      nextRegisteredSharedEngine({ incoming: remounted, previous: viewport, owned: null }),
    ).toBe(remounted);
  });

  it("drops a disposed previous engine when nothing usable replaces it", () => {
    expect(
      nextRegisteredSharedEngine({ incoming: null, previous: { isDisposed: true }, owned: null }),
    ).toBeNull();
  });
});
