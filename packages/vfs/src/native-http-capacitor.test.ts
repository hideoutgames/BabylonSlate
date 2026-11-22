import { describe, expect, it, vi } from "vitest";

const request = vi.fn();
const getPlatform = vi.fn(() => "ios");

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform },
  CapacitorHttp: { request },
  registerPlugin: () => ({}),
}));
// `getHostPlatform` reads the Capacitor bridge global that the native shells inject.
(globalThis as { Capacitor?: unknown }).Capacitor = { getPlatform: () => getPlatform() };

const { createNativeHttp } = await import("./native-http");

describe("Capacitor nativeHttp", () => {
  it("sends LFS JSON through CapacitorHttp as text", async () => {
    request.mockResolvedValueOnce({ status: 201, data: '{"lock":{}}' });
    const http = createNativeHttp();
    expect(http).not.toBeNull();
    const response = await http!({
      method: "POST",
      url: "https://github.com/org/repo.git/info/lfs/locks",
      headers: { Accept: "application/vnd.git-lfs+json" },
      body: "{\"path\":\"a\"}",
    });
    expect(response).toEqual({ status: 201, bodyText: '{"lock":{}}' });
    expect(request).toHaveBeenCalledWith({
      url: "https://github.com/org/repo.git/info/lfs/locks",
      method: "POST",
      headers: { Accept: "application/vnd.git-lfs+json" },
      data: "{\"path\":\"a\"}",
      responseType: "text",
    });
  });

  it("asks the native layer not to follow redirects for a credentialed request", async () => {
    request.mockResolvedValueOnce({ status: 302, data: "" });
    const http = createNativeHttp();
    const response = await http!({
      method: "GET",
      url: "https://api.github.com/user",
      headers: { Authorization: "Bearer token" },
      disableRedirects: true,
    });
    expect(response.status).toBe(302);
    expect(request).toHaveBeenLastCalledWith({
      url: "https://api.github.com/user",
      method: "GET",
      headers: { Authorization: "Bearer token" },
      data: undefined,
      disableRedirects: true,
      responseType: "text",
    });
  });

  // iOS and Android drop a body when Content-Type is missing, and treat a JSON
  // or URL-encoded type as text, so an upload must reach them as `formData`
  // entries under a multipart type whatever the caller sent.
  it("sends an image upload as a native multipart form without the caller's Content-Type", async () => {
    request.mockResolvedValueOnce({ status: 200, data: { response: {} }, headers: {} });
    const http = createNativeHttp();
    await http!({
      method: "POST",
      url: "https://example.clerk.accounts.dev/v1/me/profile_image",
      headers: { Accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      upload: { field: "file", fileName: "avatar.png", contentType: "image/png", base64: "iVBORw0KGgo=" },
    });
    expect(request).toHaveBeenLastCalledWith({
      url: "https://example.clerk.accounts.dev/v1/me/profile_image",
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "multipart/form-data" },
      data: [
        { type: "base64File", key: "file", value: "iVBORw0KGgo=", fileName: "avatar.png", contentType: "image/png" },
      ],
      dataType: "formData",
      responseType: "text",
    });
  });

  // Git packs and LFS objects. The native layers take a byte body only as base64 with the
  // `file` data type, under a Content-Type that is present and not JSON (Android reads JSON
  // first), and answer `arraybuffer` as base64, which Android wraps in lines.
  it("sends a byte body as base64 file data and decodes a binary answer, wrapped or not", async () => {
    const pack = Uint8Array.from([0x00, 0xff, 0x0d, 0x0a, 0x80, 0x41]);
    const answer = Uint8Array.from({ length: 120 }, (_, index) => (index * 37) % 256);
    const wrapped = btoa(String.fromCharCode(...answer)).replace(/.{76}/g, "$&\n");
    request.mockResolvedValueOnce({ status: 200, data: wrapped, headers: { "content-type": "application/x-git-upload-pack-result" } });
    const http = createNativeHttp()!;
    const response = await http({
      method: "POST",
      url: "https://github.com/org/game.git/git-upload-pack",
      headers: { "content-type": "application/x-git-upload-pack-request", Authorization: "Basic abc" },
      body: pack,
      responseType: "binary",
      disableRedirects: true,
    });
    expect(request).toHaveBeenLastCalledWith({
      url: "https://github.com/org/game.git/git-upload-pack",
      method: "POST",
      headers: { "Content-Type": "application/x-git-upload-pack-request", Authorization: "Basic abc" },
      data: "AP8NCoBB",
      dataType: "file",
      disableRedirects: true,
      responseType: "arraybuffer",
    });
    expect(wrapped).toContain("\n");
    expect(response).toEqual({ status: 200, bodyText: "", bodyBytes: answer, headers: { "content-type": "application/x-git-upload-pack-result" } });

    request.mockResolvedValueOnce({ status: 200, data: "", headers: {} });
    await http({ method: "PUT", url: "https://lfs.example.com/objects/abc", headers: {}, body: new Uint8Array([1, 2]) });
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ headers: { "Content-Type": "application/octet-stream" }, data: "AQI=", dataType: "file", responseType: "text" }));
    await expect(http({ method: "POST", url: "https://example.com", headers: { "Content-Type": "application/json" }, body: pack })).rejects.toThrow("JSON");
  });

  it("answers parsed JSON and Android's plain-text error bodies as bytes", async () => {
    const http = createNativeHttp()!;
    const binary = { method: "GET" as const, url: "https://github.com/org/game.git/info/refs", headers: {}, responseType: "binary" as const };
    request.mockResolvedValueOnce({ status: 200, data: { message: "ok" }, headers: {} });
    expect(new TextDecoder().decode((await http(binary)).bodyBytes)).toBe('{"message":"ok"}');
    getPlatform.mockReturnValue("android");
    request.mockResolvedValueOnce({ status: 404, data: "Repository not found", headers: {} });
    expect(new TextDecoder().decode((await http(binary)).bodyBytes)).toBe("Repository not found");
    getPlatform.mockReturnValue("ios");
    request.mockResolvedValueOnce({ status: 404, data: btoa("Repository not found"), headers: {} });
    expect(new TextDecoder().decode((await http(binary)).bodyBytes)).toBe("Repository not found");
    request.mockResolvedValueOnce({ status: 204, data: null, headers: {} });
    expect((await http(binary)).bodyBytes).toEqual(new Uint8Array());
  });
});
