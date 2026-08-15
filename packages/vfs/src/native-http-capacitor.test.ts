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
});
