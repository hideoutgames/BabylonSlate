import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.fn();

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "web" },
  CapacitorHttp: { request },
  registerPlugin: () => ({}),
}));

const { createNativeHttp } = await import("./native-http");
const { getElectronHttpBridge, isElectronHost } = await import("./platform");

describe("nativeHttp", () => {
  beforeEach(() => {
    delete (globalThis as { babylonslate?: unknown }).babylonslate;
    request.mockReset();
  });

  it("returns null on web", () => {
    expect(createNativeHttp()).toBeNull();
    expect(isElectronHost()).toBe(false);
  });

  it("forwards through the Electron HTTP bridge", async () => {
    const fetch = vi.fn(async () => ({ status: 200, bodyText: "{}" }));
    (globalThis as { babylonslate?: unknown }).babylonslate = {
      userData: {
        readSettings: async () => null,
        writeSettings: async () => {},
      },
      http: { fetch },
    };
    expect(getElectronHttpBridge()).not.toBeNull();
    const http = createNativeHttp();
    expect(http).not.toBeNull();
    await http?.({
      method: "GET",
      url: "https://example.test/locks",
      headers: { Accept: "application/vnd.git-lfs+json" },
    });
    expect(fetch).toHaveBeenCalledWith({
      method: "GET",
      url: "https://example.test/locks",
      headers: { Accept: "application/vnd.git-lfs+json" },
    });
  });
});
