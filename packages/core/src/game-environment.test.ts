import { describe, expect, it } from "vitest";
import { browserDeviceFacts, devicePlatformFromUserAgent, normalizeGameEnvironment } from "./game-environment";

describe("game environment", () => {
  it.each([
    ["iPhone Safari", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1", 5, "iOS"],
    ["iPadOS Safari, which reports a Mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15", 5, "iOS"],
    ["Mac Safari", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15", 0, "macOS"],
    ["Android Chrome, which also names Linux", "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36", 5, "Android"],
    ["Windows Edge", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0", 0, "Windows"],
    ["Linux Firefox", "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0", 0, "Linux"],
    ["an unknown agent", "SomeConsoleBrowser/1.0", 0, "Other"],
  ] as const)("names the platform of %s", (_label, userAgent, maxTouchPoints, platform) => {
    expect(devicePlatformFromUserAgent({ userAgent, maxTouchPoints })).toBe(platform);
  });

  it("reports touch from the device's touch points", () => {
    expect(browserDeviceFacts({ userAgent: "Mozilla/5.0 (Windows NT 10.0)", maxTouchPoints: 10 }))
      .toEqual({ platform: "Windows", touchDevice: true });
    expect(browserDeviceFacts(undefined)).toEqual({ platform: "Other", touchDevice: false });
  });

  it("keeps valid load fields and defaults the rest", () => {
    expect(normalizeGameEnvironment({ platform: "Android", touchDevice: true, inEditor: true, developmentBuild: false }))
      .toEqual({ platform: "Android", touchDevice: true, inEditor: true, developmentBuild: false });
    expect(normalizeGameEnvironment({ platform: "PlayStation", touchDevice: "yes" }))
      .toEqual({ platform: "Other", touchDevice: false, inEditor: false, developmentBuild: true });
    expect(normalizeGameEnvironment(null))
      .toEqual({ platform: "Other", touchDevice: false, inEditor: false, developmentBuild: true });
  });
});
