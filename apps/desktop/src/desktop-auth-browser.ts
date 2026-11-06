import { authCallbackUrl } from "./packaged-security";

/** How long a sign-in waits for the browser to come back, as in Clerk's Electron SDK. */
const CALLBACK_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Third-party sign-in in the system browser: one pending sign-in at a time,
 * resolved by the `haptic://sso-callback` deep link the operating system
 * delivers (`open-url` on macOS, a second instance's arguments elsewhere), or
 * with null when it is replaced, times out or the browser cannot open.
 */
export function createAuthBrowserSessions(options: {
  openExternal(url: string): Promise<void>;
  timeoutMs?: number;
}) {
  let pending: { resolve(url: string | null): void; timer: ReturnType<typeof setTimeout> } | null = null;
  const settle = (owner: typeof pending, url: string | null) => {
    if (!owner || pending !== owner) return;
    pending = null;
    clearTimeout(owner.timer);
    owner.resolve(url);
  };
  return {
    open(url: string): Promise<string | null> {
      settle(pending, null);
      return new Promise(resolve => {
        const owner = {
          resolve,
          timer: setTimeout(() => settle(owner, null), options.timeoutMs ?? CALLBACK_TIMEOUT_MS),
        };
        pending = owner;
        options.openExternal(url).catch(() => settle(owner, null));
      });
    },
    /** Hands a deep link to the waiting sign-in; false when none waits or it is not ours. */
    deliver(rawUrl: string): boolean {
      const url = authCallbackUrl(rawUrl);
      if (!url || !pending) return false;
      settle(pending, url);
      return true;
    },
  };
}
