import { describe, expect, it } from "vitest";
import {
  applyPrintHudCommand,
  printHudCssColor,
  printHudDurationMs,
  visiblePrintHudEntries,
} from "./print-hud";

describe("printHudDurationMs", () => {
  it("defaults to two seconds and treats non-positive duration as one frame", () => {
    expect(printHudDurationMs(undefined)).toBe(2000);
    expect(printHudDurationMs(2)).toBe(2000);
    expect(printHudDurationMs(0)).toBe(16);
    expect(printHudDurationMs(-1)).toBe(16);
  });
});

describe("printHudCssColor", () => {
  it("uses opaque white when color is missing or fully transparent", () => {
    expect(printHudCssColor(undefined)).toBe("rgba(255, 255, 255, 1)");
    expect(printHudCssColor({ x: 0, y: 0, z: 0, w: 0 })).toBe(
      "rgba(255, 255, 255, 1)",
    );
    expect(printHudCssColor({ x: 1, y: 0, z: 0, w: 0.5 })).toBe(
      "rgba(255, 0, 0, 0.5)",
    );
  });
});

describe("applyPrintHudCommand", () => {
  it("replaces an existing key in place and expires with duration", () => {
    const first = applyPrintHudCommand(
      [],
      { message: "one", key: "hp", duration: 2, color: { x: 1, y: 1, z: 1, w: 1 } },
      1_000,
    );
    const second = applyPrintHudCommand(
      first,
      { message: "two", key: "hp", duration: 1, color: { x: 0, y: 1, z: 0, w: 1 } },
      1_500,
    );
    expect(second).toEqual([
      {
        key: "hp",
        message: "two",
        color: "rgba(0, 255, 0, 1)",
        expiresAt: 2_500,
      },
    ]);
    expect(visiblePrintHudEntries(second, 2_400)).toHaveLength(1);
    expect(visiblePrintHudEntries(second, 2_500)).toHaveLength(0);
  });
});
