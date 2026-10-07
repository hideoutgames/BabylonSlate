import { afterEach, describe, expect, it } from "vitest";
import { isTestModeEnabled } from "./test-mode";

/**
 * The compiled-environment branches are not reachable from unit tests:
 * vi.stubEnv does not reach import.meta.env, which is fixed per bundle. The
 * VITE_TEST_MODE branch is covered by the Playwright suite, which builds with
 * VITE_TEST_MODE=true so storage uses the TestProject folder. The production
 * boundary — query activation with DEV=false and no VITE_TEST_QUERY — is
 * exercised against built bundles, not stubbed here.
 */
describe("test mode detection", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it.each([
    ["/", false],
    ["/?test=1", true],
    ["/?test", true],
    ["/?test=false", false],
    ["/?debug=1", false],
  ])("reads %s as test mode %s", (url, enabled) => {
    window.history.replaceState({}, "", url);
    expect(isTestModeEnabled()).toBe(enabled);
  });
});
