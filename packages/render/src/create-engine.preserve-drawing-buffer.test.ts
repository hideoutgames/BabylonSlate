import { afterEach, describe, expect, it, vi } from "vitest";
import { preserveDrawingBufferSetting, setPreserveDrawingBufferSetting } from "./create-engine";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("preservebuffer setting", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("keeps the drawing buffer by default, and stores off until it is turned back on", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(preserveDrawingBufferSetting()).toBe(true);
    setPreserveDrawingBufferSetting(false);
    expect(preserveDrawingBufferSetting()).toBe(false);
    setPreserveDrawingBufferSetting(true);
    expect(preserveDrawingBufferSetting()).toBe(true);
  });

  it("keeps the drawing buffer when storage is unavailable", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
    setPreserveDrawingBufferSetting(false);
    expect(preserveDrawingBufferSetting()).toBe(true);
  });
});
