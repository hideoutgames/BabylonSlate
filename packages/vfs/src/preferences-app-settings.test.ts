import { beforeEach, describe, expect, it, vi } from "vitest";

const stored = new Map<string, string>();
const get = vi.fn(async ({ key }: { key: string }) => ({ value: stored.get(key) ?? null }));

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: (options: { key: string }) => get(options),
    set: async ({ key, value }: { key: string; value: string }) => { stored.set(key, value); },
  },
}));

const { PreferencesAppSettingsStore } = await import("./preferences-app-settings");

describe("Preferences app settings", () => {
  beforeEach(() => {
    stored.clear();
    get.mockClear();
  });

  it("replaces unreadable stored settings instead of failing every load and update", async () => {
    stored.set("babylonslate:engine-settings", "{not-json");
    const store = new PreferencesAppSettingsStore();
    expect((await store.load()).undoHistoryLength).toBe(50);
    await store.update((settings) => { settings.undoHistoryLength = 75; });
    expect((await new PreferencesAppSettingsStore().load()).undoHistoryLength).toBe(75);
  });

  it("keeps stored settings when the native read fails", async () => {
    stored.set("babylonslate:engine-settings", JSON.stringify({ undoHistoryLength: 75 }));
    get.mockRejectedValueOnce(new Error("Preferences unavailable"));
    const store = new PreferencesAppSettingsStore();
    await expect(store.update((settings) => { settings.graphDefaultZoom = 1; }))
      .rejects.toThrow("Preferences unavailable");
    expect((await store.load()).undoHistoryLength).toBe(75);
  });
});
