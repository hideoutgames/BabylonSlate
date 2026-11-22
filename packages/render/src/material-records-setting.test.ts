import { afterEach, describe, expect, it, vi } from "vitest";
import { materialRecordsStartupSetting, setMaterialRecordsStartupSetting } from "./material-records-setting";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("materialrecords start-up setting", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("starts without the Material record by default, and stores on until it is turned back off", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(materialRecordsStartupSetting()).toBe(false);
    setMaterialRecordsStartupSetting(true);
    expect(materialRecordsStartupSetting()).toBe(true);
    setMaterialRecordsStartupSetting(false);
    expect(materialRecordsStartupSetting()).toBe(false);
  });

  it("starts without the Material record when storage is unavailable", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
    setMaterialRecordsStartupSetting(true);
    expect(materialRecordsStartupSetting()).toBe(false);
  });
});
