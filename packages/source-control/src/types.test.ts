import { describe, expect, it } from "vitest";
import {
  isSourceControlHost,
} from "./types";

describe("source-control host and secret key", () => {
  it("enables native hosts and test mode, not production web", () => {
    expect(isSourceControlHost("web", false)).toBe(false);
    expect(isSourceControlHost("web", true)).toBe(true);
    expect(isSourceControlHost("ios", false)).toBe(true);
    expect(isSourceControlHost("android", false)).toBe(true);
    expect(isSourceControlHost("electron", false)).toBe(true);
  });
});
