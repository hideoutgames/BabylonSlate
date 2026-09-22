import { describe, expect, it } from "vitest";
import { ENGINE_VERSION } from "./engine-version";

describe("ENGINE_VERSION", () => {
  it("provides the declared numeric engine version for plugin compatibility", () => {
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
