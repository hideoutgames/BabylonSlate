import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.fn();
const getPlatform = vi.fn(() => "web");

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform },
  CapacitorHttp: { request },
  registerPlugin: () => ({}),
}));
// `getHostPlatform` reads the Capacitor bridge global that the native shells inject.
(globalThis as { Capacitor?: unknown }).Capacitor = { getPlatform: () => getPlatform() };

const { createNativeHttp } = await import("./native-http");
const { getElectronHttpBridge, isElectronHost } = await import("./platform");

describe("nativeHttp", () => {
  beforeEach(() => {
    delete (globalThis as { haptic?: unknown }).haptic;
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
    (globalThis as { haptic?: unknown }).haptic = {
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

  // IPC validation takes a byte body only as an ArrayBuffer, which must hold exactly the view's bytes.
  it("hands the Electron bridge a byte body as an exact ArrayBuffer", async () => {
    const fetch = vi.fn<(request: { body?: unknown }) => Promise<{ status: number; bodyText: string; bodyBytes: Uint8Array }>>(async () => ({ status: 200, bodyText: "", bodyBytes: new Uint8Array([9]) }));
    (globalThis as { haptic?: unknown }).haptic = { userData: { readSettings: async () => null, writeSettings: async () => {} }, http: { fetch } };
    const view = new Uint8Array([1, 2, 3, 4, 5]).subarray(1, 4);
    const response = await createNativeHttp()!({ method: "PUT", url: "https://lfs.example/objects/a", headers: {}, body: view, responseType: "binary" });
    const sent = fetch.mock.calls[0]![0].body;
    expect(sent).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(sent as ArrayBuffer)).toEqual(new Uint8Array([2, 3, 4]));
    expect(response.bodyBytes).toEqual(new Uint8Array([9]));
  });
});
