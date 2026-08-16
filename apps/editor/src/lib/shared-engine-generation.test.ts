import { describe, expect, it } from "vitest";
import {
  isUsableEngine,
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
