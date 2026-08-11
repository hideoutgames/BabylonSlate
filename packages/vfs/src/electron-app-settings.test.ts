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
    next.templatesFolder = "Templates";
    await store.save(next);

    expect(bridge.writeSettings).toHaveBeenCalledOnce();
    expect((await new ElectronAppSettingsStore(bridge).load()).templatesFolder).toBe(
      "Templates",
    );
  });

  it("falls back to defaults when the bridge has no settings yet", async () => {
    const store = new ElectronAppSettingsStore(fakeBridge());
    expect((await store.load()).undoHistoryLength).toBe(50);
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

  it("works with no bridge at all (stub until the desktop host lands)", async () => {
    const store = new ElectronAppSettingsStore(null);
    const next = defaultEngineSettings();
    next.thumbnailsEnabled = false;
    await store.save(next);
    expect((await store.load()).thumbnailsEnabled).toBe(false);
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
