import { afterEach, describe, expect, it } from "vitest";
import { isTestModeEnabled, TEST_PROJECT_NAME } from "./test-mode";

/**
 * The compiled-environment branches are not reachable from unit tests:
 * vi.stubEnv does not reach import.meta.env, which is fixed per bundle. The
 * VITE_TEST_MODE branch is covered by the Playwright suite, which builds with
 * VITE_TEST_MODE=true so Create Project prefills TestProject. The production
 * boundary — query activation with DEV=false and no VITE_TEST_QUERY — is
 * exercised against built bundles, not stubbed here.
 */
describe("test mode detection", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("exposes a stable project name for automated runs", () => {
    expect(TEST_PROJECT_NAME).toBe("TestProject");
  });

  it("is off by default", () => {
    expect(isTestModeEnabled()).toBe(false);
  });

  it("is on when the test query flag is present", () => {
    window.history.replaceState({}, "", "/?test=1");
    expect(isTestModeEnabled()).toBe(true);
  });

  it("is on for a bare test flag with no value", () => {
    window.history.replaceState({}, "", "/?test");
    expect(isTestModeEnabled()).toBe(true);
  });

  it("is off when the test flag is explicitly false", () => {
    window.history.replaceState({}, "", "/?test=false");
    expect(isTestModeEnabled()).toBe(false);
  });

  it("ignores unrelated query parameters", () => {
    window.history.replaceState({}, "", "/?debug=1");
    expect(isTestModeEnabled()).toBe(false);
  });
});
