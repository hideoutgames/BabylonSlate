import { describe, expect, it } from "vitest";
import { TICK_BUDGET_MS, isTickOverBudget } from "./stats";

describe("isTickOverBudget", () => {
  it("flags the combined script plus physics tick against the 8ms budget", () => {
    expect(TICK_BUDGET_MS).toBe(8);
    expect(isTickOverBudget(3, 2)).toBe(false);
    expect(isTickOverBudget(5, 4)).toBe(true);
  });
});
