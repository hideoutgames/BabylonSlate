import { beforeEach, describe, expect, it, vi } from "vitest";

const getPlatform = vi.fn(() => "web");

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => getPlatform() },
}));

const { getHostPlatform, isMobilePlatform } = await import("./platform");

describe("host platform", () => {
  beforeEach(() => {
    getPlatform.mockReturnValue("web");
  });

  it("reports web as the default host", () => {
    expect(getHostPlatform()).toBe("web");
    expect(isMobilePlatform()).toBe(false);
  });

  it("reports ios and android as mobile hosts", () => {
    getPlatform.mockReturnValue("ios");
    expect(getHostPlatform()).toBe("ios");
    expect(isMobilePlatform()).toBe(true);

    getPlatform.mockReturnValue("android");
    expect(getHostPlatform()).toBe("android");
    expect(isMobilePlatform()).toBe(true);
  });

  it("treats unknown platforms as web rather than mobile", () => {
    getPlatform.mockReturnValue("electron");
    expect(getHostPlatform()).toBe("web");
    expect(isMobilePlatform()).toBe(false);
  });
});
