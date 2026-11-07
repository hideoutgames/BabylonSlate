import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthBrowserSessions } from "./desktop-auth-browser";
import { authProviderUrl, validateIpcArguments } from "./packaged-security";

afterEach(() => vi.useRealTimers());

describe("desktop third-party sign-in", () => {
  it("opens only provider sign-in pages and accepts only the sign-in callback", () => {
    expect(authProviderUrl("https://github.com/login/oauth/authorize?client_id=a")).toBe(
      "https://github.com/login/oauth/authorize?client_id=a",
    );
    for (const url of [
      "http://github.com/login/oauth/authorize",
      "https://user:pass@github.com/login",
      "https://evil.example/login",
      "https://github.com.evil.example/login",
      "file:///etc/passwd",
    ]) {
      expect(authProviderUrl(url)).toBeNull();
      expect(() => validateIpcArguments("auth:open-browser", [url, "haptic://sso-callback"])).toThrow();
    }
    expect(() =>
      validateIpcArguments("auth:open-browser", ["https://discord.com/oauth2/authorize", "haptic://sso-callback"]),
    ).not.toThrow();
    expect(() =>
      validateIpcArguments("auth:open-browser", ["https://discord.com/oauth2/authorize", "haptic://other"]),
    ).toThrow();
  });

  it("resolves the waiting sign-in with its deep link and ignores other links", async () => {
    const openExternal = vi.fn(async () => {});
    const sessions = createAuthBrowserSessions({ openExternal });
    const result = sessions.open("https://github.com/login/oauth/authorize");
    expect(openExternal).toHaveBeenCalledWith("https://github.com/login/oauth/authorize");
    expect(sessions.deliver("haptic://other?x=1")).toBe(false);
    expect(sessions.deliver("--flag")).toBe(false);
    expect(sessions.deliver("haptic://sso-callback?rotating_token_nonce=n1")).toBe(true);
    await expect(result).resolves.toBe("haptic://sso-callback?rotating_token_nonce=n1");
    expect(sessions.deliver("haptic://sso-callback?rotating_token_nonce=late")).toBe(false);
  });

  it("closes a replaced, timed-out or unopenable sign-in with null", async () => {
    vi.useFakeTimers();
    const openExternal = vi.fn(async () => {});
    const sessions = createAuthBrowserSessions({ openExternal, timeoutMs: 1000 });
    const first = sessions.open("https://github.com/a");
    const second = sessions.open("https://github.com/b");
    await expect(first).resolves.toBeNull();
    vi.advanceTimersByTime(1000);
    await expect(second).resolves.toBeNull();
    openExternal.mockRejectedValueOnce(new Error("no browser"));
    await expect(sessions.open("https://github.com/c")).resolves.toBeNull();
  });
});
