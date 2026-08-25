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

  it("treats a disposed engine as unusable", () => {
    expect(isUsableEngine({ isDisposed: true })).toBe(false);
    expect(isUsableEngine({ isDisposed: false })).toBe(true);
    expect(isUsableEngine(null)).toBe(false);
  });
});

describe("nextRegisteredSharedEngine", () => {
  const viewport = { isDisposed: false };
  const owned = { isDisposed: false };

  it("keeps the live overlay Play engine when the viewport unregisters", () => {
    expect(
      nextRegisteredSharedEngine({
        incoming: null,
        previous: viewport,
        owned: null,
        overlayPlaying: true,
      }),
    ).toBe(viewport);
  });

  it("falls back to the owned engine when overlay Play is not running", () => {
    expect(
      nextRegisteredSharedEngine({
        incoming: null,
        previous: viewport,
        owned,
        overlayPlaying: false,
      }),
    ).toBe(owned);
  });

  it("keeps the project-owned engine when the viewport unregisters during overlay Play", () => {
    expect(
      nextRegisteredSharedEngine({
        incoming: null,
        previous: viewport,
        owned,
        overlayPlaying: true,
      }),
    ).toBe(owned);
  });

  it("accepts a usable incoming engine even during overlay Play", () => {
    const remounted = { isDisposed: false };
    expect(
      nextRegisteredSharedEngine({
        incoming: remounted,
        previous: viewport,
        owned: null,
        overlayPlaying: true,
      }),
    ).toBe(remounted);
  });
});
