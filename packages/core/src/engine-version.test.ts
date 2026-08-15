import { describe, expect, it } from "vitest";
import { ENGINE_VERSION } from "./engine-version";

describe("ENGINE_VERSION", () => {
  it("is a semver string the plugin loader can range-check", () => {
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
