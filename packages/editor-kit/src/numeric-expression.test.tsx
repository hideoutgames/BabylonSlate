import { describe, expect, it } from "vitest";
import {
  evaluateNumericExpression,
  formatNumericDisplay,
} from "./numeric-expression";

describe("formatNumericDisplay", () => {
  it("rounds to at most two decimal places", () => {
    expect(formatNumericDisplay(1.22338899332)).toBe("1.22");
    expect(formatNumericDisplay(-1.226)).toBe("-1.23");
  });

  it("strips trailing zeros after rounding", () => {
    expect(formatNumericDisplay(1.2)).toBe("1.2");
    expect(formatNumericDisplay(1)).toBe("1");
    expect(formatNumericDisplay(-1)).toBe("-1");
    expect(formatNumericDisplay(0)).toBe("0");
  });
});

describe("evaluateNumericExpression", () => {
  it("parses plain numbers including negatives and zero", () => {
    expect(evaluateNumericExpression("1.5", 0)).toBe(1.5);
    expect(evaluateNumericExpression("0", 9)).toBe(0);
    expect(evaluateNumericExpression("-2", 1.5)).toBe(-2);
  });

  it("evaluates + - * / with * and / binding tighter than + -", () => {
    expect(evaluateNumericExpression("1+2", 0)).toBe(3);
    expect(evaluateNumericExpression("(1+2)*3", 0)).toBe(9);
    expect(evaluateNumericExpression("2*(3+4)", 0)).toBe(14);
    expect(evaluateNumericExpression("1+2*3", 0)).toBe(7);
    expect(evaluateNumericExpression(" 1 + 2 ", 0)).toBe(3);
    expect(evaluateNumericExpression("-(1+2)", 0)).toBe(-3);
  });

  it("applies a leading * / or + to the current value", () => {
    expect(evaluateNumericExpression("*2", 1.5)).toBe(3);
    expect(evaluateNumericExpression("/2", 1.5)).toBe(0.75);
    expect(evaluateNumericExpression("+2", 1.5)).toBe(3.5);
    expect(evaluateNumericExpression("*2+1", 1.5)).toBe(4);
  });

  it("returns undefined for incomplete drafts", () => {
    expect(evaluateNumericExpression("", 1)).toBeUndefined();
    expect(evaluateNumericExpression("-", 1)).toBeUndefined();
    expect(evaluateNumericExpression(".", 1)).toBeUndefined();
    expect(evaluateNumericExpression("-.", 1)).toBeUndefined();
    expect(evaluateNumericExpression("1+", 1)).toBeUndefined();
    expect(evaluateNumericExpression("*", 1)).toBeUndefined();
    expect(evaluateNumericExpression("(2", 1)).toBeUndefined();
  });

  it("returns undefined for divide-by-zero, non-finite, and invalid text", () => {
    expect(evaluateNumericExpression("1/0", 1)).toBeUndefined();
    expect(evaluateNumericExpression("abc", 1)).toBeUndefined();
  });
});
