import { registerPlugin } from "@capacitor/core";
import { getHostPlatform } from "./platform";

/**
 * Opens a third-party sign-in page in a system browser session and waits for
 * the provider to redirect back to the app's callback URL.
 */
export interface AuthBrowser {
  /**
   * Resolves with the full callback URL (query included), or null when the
   * person closed the browser without finishing.
   */
  open(url: string, callbackUrl: string): Promise<string | null>;
}

/** The Electron preload bridge: main opens the system browser and receives the deep link. */
export interface ElectronAuthBrowserBridge {
  open(url: string, callbackUrl: string): Promise<string | null>;
}

interface BabylonSlateAuthSessionPlugin {
  open(options: {
    url: string;
    callbackScheme: string;
  }): Promise<{ url: string | null }>;
}

const BabylonSlateAuthSession = registerPlugin<BabylonSlateAuthSessionPlugin>(
  "BabylonSlateAuthSession",
);

function callbackScheme(callbackUrl: string): string {
  return new URL(callbackUrl).protocol.slice(0, -1);
}

/**
 * iOS (ASWebAuthenticationSession) and Android (system browser plus a deep
 * link) through the first-party plugin, Electron through its bridge. The web
 * build signs in with Clerk's own window, so it has none.
 */
export function createAuthBrowser(): AuthBrowser | null {
  const host = getHostPlatform();
  if (host === "ios" || host === "android") {
    return {
      open: async (url, callbackUrl) =>
        (
          await BabylonSlateAuthSession.open({
            url,
            callbackScheme: callbackScheme(callbackUrl),
          })
        ).url ?? null,
    };
  }
  if (host === "electron") {
    const bridge = (
      globalThis as { haptic?: { authBrowser?: ElectronAuthBrowserBridge } }
    ).haptic?.authBrowser;
    return bridge ? { open: (url, callbackUrl) => bridge.open(url, callbackUrl) } : null;
  }
  return null;
}
