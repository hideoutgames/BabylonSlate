import { describe, expect, it } from "vitest";
import { VISIBILITY_HEAL_INTERVAL, VisibilityCheck, sameList, verifyVisibilityQueries, visibilityDiagnostics } from "./visibility-check";

describe("VisibilityCheck", () => {
  it("asks for the full path on every 32nd query, and on every query while verifying", () => {
    const check = new VisibilityCheck("main");
    const due: number[] = [];
    for (let query = 1; query <= 100; query++) if (check.due()) due.push(query);
    expect(due).toEqual([32, 64, 96]);
    expect(VISIBILITY_HEAL_INTERVAL).toBe(32);
    verifyVisibilityQueries(true);
    try {
      expect([check.due(), check.due(), check.due()]).toEqual([true, true, true]);
    } finally {
      verifyVisibilityQueries(false);
    }
    expect(check.due()).toBe(false);
  });

  it("counts a differing list as a mismatch, and as a heal only when a periodic check found it", () => {
    const before = visibilityDiagnostics()?.mirror ?? { queries: 0, queryMs: 0, checks: 0, fullMs: 0, mismatches: 0, heals: 0 };
    const check = new VisibilityCheck("mirror");
    for (let query = 1; query < VISIBILITY_HEAL_INTERVAL; query++) {
      expect(check.due()).toBe(false);
      check.queried(0.5);
    }
    // The 32nd query is a periodic check: agreeing costs nothing, differing is a mismatch and a heal.
    expect(check.due()).toBe(true);
    check.queried(0.5);
    check.checked(true, 2);
    const agreed = visibilityDiagnostics()!.mirror!;
    expect([agreed.queries - before.queries, agreed.checks - before.checks, agreed.mismatches - before.mismatches, agreed.heals - before.heals])
      .toEqual([32, 1, 0, 0]);
    expect(agreed.queryMs - before.queryMs).toBeCloseTo(16);
    expect(agreed.fullMs - before.fullMs).toBeCloseTo(2);
    for (let query = 1; query < VISIBILITY_HEAL_INTERVAL; query++) check.due();
    check.due();
    check.checked(false, 1);
    // A difference the verifier finds between periodic checks is a mismatch only.
    verifyVisibilityQueries(true);
    try {
      expect(check.due()).toBe(true);
      check.checked(false, 1);
    } finally {
      verifyVisibilityQueries(false);
    }
    const differed = visibilityDiagnostics()!.mirror!;
    expect([differed.checks - before.checks, differed.mismatches - before.mismatches, differed.heals - before.heals]).toEqual([3, 2, 1]);
  });

  it("compares lists by length, members and order", () => {
    const a = {}, b = {}, c = {};
    expect(sameList([a, b, c], [a, b, c])).toBe(true);
    expect(sameList([], [])).toBe(true);
    expect(sameList([a, b], [a, b, c])).toBe(false);
    expect(sameList([a, b, c], [a, c, b])).toBe(false);
    expect(sameList([a, b], [a, c])).toBe(false);
    expect(sameList(null, null)).toBe(true);
    expect(sameList(null, [])).toBe(false);
  });
});
