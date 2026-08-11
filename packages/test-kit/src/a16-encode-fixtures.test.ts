import { describe, expect, it } from "vitest";
import {
  A16_ENCODE_FIXTURES,
  A16_POLICY,
  fixtureId,
} from "./a16-encode-fixtures";

describe("A16 encode fixtures", () => {
  it("covers 512–4096 PNG and JPEG with checked-in envelopes", () => {
    const ids = A16_ENCODE_FIXTURES.map(fixtureId).sort();
    expect(ids).toContain("512-png");
    expect(ids).toContain("4096-jpeg");
    expect(A16_ENCODE_FIXTURES).toHaveLength(8);
    for (const fixture of A16_ENCODE_FIXTURES) {
      expect(fixture.a16WallMsMax).toBeGreaterThan(0);
      expect(fixture.a16HeapMbMax).toBeLessThanOrEqual(256);
    }
  });

  it("locks default policy from A16 numbers", () => {
    expect(A16_POLICY.defaultMaxDimension).toBe(2048);
    expect(A16_POLICY.defaultFormat).toBe("uastc");
    expect(A16_POLICY.requireConfirmAboveDimension).toBe(4096);
  });
});
