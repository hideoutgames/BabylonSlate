import { describe, expect, it } from "vitest";
import {
  STATS_COMMAND_INTERVAL_MS,
  TICK_BUDGET_MS,
  isTickOverBudget,
  shouldEmitStatsCommand,
} from "./stats";

describe("isTickOverBudget", () => {
  it("flags the combined script plus physics tick against the 8ms budget", () => {
    expect(TICK_BUDGET_MS).toBe(8);
    expect(isTickOverBudget(3, 2)).toBe(false);
    expect(isTickOverBudget(5, 4)).toBe(true);
  });
});

describe("shouldEmitStatsCommand", () => {
  it("emits the first sample then waits 200ms so the HUD stays near 5 Hz", () => {
    expect(STATS_COMMAND_INTERVAL_MS).toBe(200);
    expect(shouldEmitStatsCommand(0, null)).toBe(true);
    expect(shouldEmitStatsCommand(199, 0)).toBe(false);
    expect(shouldEmitStatsCommand(200, 0)).toBe(true);
    expect(shouldEmitStatsCommand(399, 200)).toBe(false);
    expect(shouldEmitStatsCommand(400, 200)).toBe(true);
  });
});
