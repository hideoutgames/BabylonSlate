import { describe, expect, it, vi } from "vitest";

const request = vi.fn();

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "ios" },
  CapacitorHttp: { request },
  registerPlugin: () => ({}),
}));

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
});
