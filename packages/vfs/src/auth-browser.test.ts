import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getPlatform = vi.fn(() => "web");
const nativeOpen = vi.fn(async () => ({ url: null as string | null }));

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => getPlatform() },
  registerPlugin: () => ({ open: nativeOpen }),
}));

const { createAuthBrowser } = await import("./auth-browser");

describe("auth browser", () => {
  beforeEach(() => {
    getPlatform.mockReturnValue("web");
    nativeOpen.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("has no browser session on the web, which uses Clerk's own window", () => {
    expect(createAuthBrowser()).toBeNull();
  });

  it.each(["ios", "android"])(
    "hands %s the callback scheme and returns the redirect, or null when closed",
    async (platform) => {
      getPlatform.mockReturnValue(platform);
      nativeOpen.mockResolvedValueOnce({
        url: "haptic://sso-callback?rotating_token_nonce=n1",
      });
      const browser = createAuthBrowser();
      expect(
        await browser?.open("https://github.com/login/oauth/authorize", "haptic://sso-callback"),
      ).toBe("haptic://sso-callback?rotating_token_nonce=n1");
      expect(nativeOpen).toHaveBeenCalledWith({
        url: "https://github.com/login/oauth/authorize",
        callbackScheme: "haptic",
      });
      nativeOpen.mockResolvedValueOnce({ url: null });
      expect(await browser?.open("https://discord.com/oauth2/authorize", "haptic://sso-callback")).toBeNull();
    },
  );

  it("uses the Electron bridge, and none when the preload does not expose it", async () => {
    const open = vi.fn(async () => "haptic://sso-callback?rotating_token_nonce=n2");
    vi.stubGlobal("haptic", {
      userData: { readSettings: async () => null, writeSettings: async () => {} },
      authBrowser: { open },
    });
    expect(
      await createAuthBrowser()?.open("https://github.com/login/oauth/authorize", "haptic://sso-callback"),
    ).toBe("haptic://sso-callback?rotating_token_nonce=n2");
    expect(open).toHaveBeenCalledWith(
      "https://github.com/login/oauth/authorize",
      "haptic://sso-callback",
    );
    vi.stubGlobal("haptic", {
      userData: { readSettings: async () => null, writeSettings: async () => {} },
    });
    expect(createAuthBrowser()).toBeNull();
  });
});
