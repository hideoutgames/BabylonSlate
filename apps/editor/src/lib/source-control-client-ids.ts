import type { DeviceSignInHost } from "@haptic/source-control/device-flow";

/** The fake host signs in with any client id, so test mode always offers Sign In. */
const TEST_CLIENT_ID = "haptic-test-client";

/**
 * The public OAuth client ids of the GitHub and GitLab apps, set at build time
 * like `VITE_CLERK_PUBLISHABLE_KEY`. Without one, that host's Sign In is hidden.
 */
export function deviceClientId(host: DeviceSignInHost, testMode: boolean): string | null {
  if (testMode) return TEST_CLIENT_ID;
  const value = host === "github" ? import.meta.env.VITE_GITHUB_CLIENT_ID : import.meta.env.VITE_GITLAB_CLIENT_ID;
  return value?.trim() || null;
}
