import { afterEach, describe, expect, it } from "vitest";
import { isTestModeEnabled, TEST_PROJECT_NAME } from "./test-mode";

/**
 * The VITE_TEST_MODE branch is not reachable from unit tests: vi.stubEnv does
 * not reach import.meta.env. It is covered by the Playwright suite, which
 * builds with VITE_TEST_MODE=true and asserts the Test mode badge.
 */
describe("test mode detection", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("exposes a stable project name for automated runs", () => {
    expect(TEST_PROJECT_NAME).toBe("TestProject.babylonslate");
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

  it("ignores unrelated query parameters", () => {
    window.history.replaceState({}, "", "/?debug=1");
    expect(isTestModeEnabled()).toBe(false);
  });
});
