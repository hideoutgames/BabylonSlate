import { chromium, firefox, webkit, type FullConfig } from "@playwright/test";
import { assertAppBoots } from "./app-boot-check";

/**
 * Direct Playwright invocations may list tests; execution requires an owned server. Before any test runs, the editor
 * must boot once in the first project's browser: a bundle that cannot start fails the run here, with its error,
 * instead of in every test's timeout.
 */
export default async function verifyTestServer(config: FullConfig) {
  const baseURL = process.env.HAPTIC_TEST_BASE_URL;
  if (!baseURL || !process.env.HAPTIC_TEST_SERVER_NONCE)
    throw new Error(
      "Run browser tests with pnpm test:e2e so the build and server are owned by this run",
    );
  const response = await fetch(`${baseURL}/__test_identity`, {
    signal: AbortSignal.timeout(5_000),
  });
  const identity = (await response.json()) as { key: string; nonce: string };
  if (
    !response.ok ||
    identity.key !== process.env.HAPTIC_TEST_BUILD_KEY ||
    identity.nonce !== process.env.HAPTIC_TEST_SERVER_NONCE
  )
    throw new Error("Test server identity does not match this run");
  const use = config.projects[0]?.use ?? {};
  const browserType = { chromium, firefox, webkit }[use.browserName ?? "chromium"];
  await assertAppBoots(browserType, baseURL, { channel: use.channel });
}
