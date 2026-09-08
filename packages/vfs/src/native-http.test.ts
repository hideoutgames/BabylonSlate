import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.fn();
const getPlatform = vi.fn(() => "web");

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform },
  CapacitorHttp: { request },
  registerPlugin: () => ({}),
}));

const { createNativeHttp } = await import("./native-http");
const { getElectronHttpBridge, isElectronHost } = await import("./platform");

describe("nativeHttp", () => {
  beforeEach(() => {
    delete (globalThis as { babylonslate?: unknown }).babylonslate;
    request.mockReset();
    getPlatform.mockReturnValue("web");
  });

  it("returns null on web", () => {
    expect(createNativeHttp()).toBeNull();
    expect(isElectronHost()).toBe(false);
  });

  it("preserves native response headers needed for rotating account tokens", async () => {
    getPlatform.mockReturnValue("ios");
    request.mockResolvedValue({
      status: 200,
      data: { response: {} },
      headers: { Authorization: "rotated-client" },
    });
    const response = await createNativeHttp()!({
      method: "GET",
      url: "https://example.test/client",
      headers: {},
    });
    expect(response).toEqual({
      status: 200,
      bodyText: '{"response":{}}',
      headers: { Authorization: "rotated-client" },
    });
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
