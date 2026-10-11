import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultEngineSettings } from "./app-settings";
import { ElectronAppSettingsStore } from "./electron-app-settings";
import { getElectronUserDataBridge, getHostPlatform, isElectronHost } from "./platform";

function fakeBridge(initial: string | null = null) {
  let stored = initial;
  return {
    readSettings: vi.fn(async () => stored),
    writeSettings: vi.fn(async (json: string) => {
      stored = json;
    }),
  };
}

describe("Electron userData app settings", () => {
  beforeEach(() => {
    delete (globalThis as { babylonslate?: unknown }).babylonslate;
  });

  it("persists settings through the userData bridge", async () => {
    const bridge = fakeBridge();
    const store = new ElectronAppSettingsStore(bridge);

    const next = defaultEngineSettings();
    next.automaticUpdatesEnabled = false;
    next.seenReleaseVersions = ["1.2.3"];
    await store.save(next);

    expect(bridge.writeSettings).toHaveBeenCalledOnce();
    const restored = await new ElectronAppSettingsStore(bridge).load();
    expect(restored.automaticUpdatesEnabled).toBe(false);
    expect(restored.seenReleaseVersions).toEqual(["1.2.3"]);
  });

  it("falls back to defaults when the bridge has no settings yet", async () => {
    const store = new ElectronAppSettingsStore(fakeBridge());
    expect((await store.load()).undoHistoryLength).toBe(50);
    expect((await store.load()).automaticUpdatesEnabled).toBe(true);
    expect((await store.load()).seenReleaseVersions).toEqual([]);
  });

  it("keeps settings in memory when the bridge fails", async () => {
    const bridge = {
      readSettings: vi.fn(async () => {
        throw new Error("no userData yet");
      }),
      writeSettings: vi.fn(async () => {
        throw new Error("no userData yet");
      }),
    };
    const store = new ElectronAppSettingsStore(bridge);

    const next = defaultEngineSettings();
    next.viewportFrameCap = 30;
    await store.save(next);

    expect((await store.load()).viewportFrameCap).toBe(30);
  });

  it("builds the next update on a save the bridge refused, not the older file", async () => {
    const stored = defaultEngineSettings();
    stored.viewportFrameCap = 60;
    const bridge = fakeBridge(JSON.stringify(stored));
    bridge.writeSettings.mockRejectedValue(new Error("disk full"));
    const store = new ElectronAppSettingsStore(bridge);

    await store.update((settings) => { settings.viewportFrameCap = 30; });
    const next = await store.update((settings) => { settings.undoHistoryLength = 75; });

    expect([next.viewportFrameCap, next.undoHistoryLength]).toEqual([30, 75]);
    expect((await store.load()).viewportFrameCap).toBe(30);
  });

  it("builds the next update on the last saved settings when a later read fails", async () => {
    const bridge = fakeBridge();
    const store = new ElectronAppSettingsStore(bridge);
    await store.update((settings) => { settings.viewportFrameCap = 60; });
    bridge.readSettings.mockResolvedValueOnce(null);

    const next = await store.update((settings) => { settings.undoHistoryLength = 75; });

    expect([next.viewportFrameCap, next.undoHistoryLength]).toEqual([60, 75]);
    expect(JSON.parse(bridge.writeSettings.mock.lastCall![0]).viewportFrameCap).toBe(60);
  });

  it("detects the Electron host from the injected bridge", () => {
    expect(isElectronHost()).toBe(false);
    expect(getHostPlatform()).toBe("web");

    (globalThis as { babylonslate?: unknown }).babylonslate = {
      userData: fakeBridge(),
    };
    expect(isElectronHost()).toBe(true);
    expect(getElectronUserDataBridge()).not.toBeNull();
    expect(getHostPlatform()).toBe("electron");
  });
});
