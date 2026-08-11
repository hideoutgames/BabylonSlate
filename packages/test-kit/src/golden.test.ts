import { describe, expect, it } from "vitest";
import { normalizeGoldenText } from "./golden";

describe("normalizeGoldenText", () => {
  it("normalizes CRLF and trims trailing newline", () => {
    expect(normalizeGoldenText("a\r\nb\n\n")).toBe("a\nb");
  });
});
