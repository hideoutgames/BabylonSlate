import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getPlatform = vi.fn(() => "web");

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => getPlatform() },
}));

const { defaultCompactMode, resolveCompactMode } = await import("./compact-mode");
const { engineSettingsSchema } = await import("./app-settings");

function browser(userAgent: string, maxTouchPoints = 0) {
  vi.stubGlobal("navigator", { userAgent, maxTouchPoints });
}

describe("Compact Mode default", () => {
  beforeEach(() => {
    getPlatform.mockReturnValue("web");
    browser("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is on for desktop browsers and off in the iOS and Android apps", () => {
    expect(defaultCompactMode()).toBe(true);
    getPlatform.mockReturnValue("ios");
    expect(defaultCompactMode()).toBe(false);
    getPlatform.mockReturnValue("android");
    expect(defaultCompactMode()).toBe(false);
  });

  it("is off in mobile browsers, including iPadOS Safari reporting a Mac", () => {
    browser("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36");
    expect(defaultCompactMode()).toBe(false);
    browser("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148");
    expect(defaultCompactMode()).toBe(false);
    browser("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15", 5);
    expect(defaultCompactMode()).toBe(false);
    browser("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15");
    expect(defaultCompactMode()).toBe(true);
  });

  it("follows the platform until the setting is chosen, then keeps the choice", () => {
    const unset = engineSettingsSchema.parse({});
    expect(unset.compactMode).toBeUndefined();
    expect(resolveCompactMode(unset)).toBe(true);
    getPlatform.mockReturnValue("ios");
    expect(resolveCompactMode(unset)).toBe(false);
    expect(resolveCompactMode(engineSettingsSchema.parse({ compactMode: true }))).toBe(true);
    expect(resolveCompactMode(engineSettingsSchema.parse({ compactMode: "yes" }))).toBe(false);
  });
});
