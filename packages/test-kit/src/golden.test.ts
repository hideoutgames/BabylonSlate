import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { normalizeGoldenText, readGolden, writeGolden } from "./golden";

describe("normalizeGoldenText", () => {
  it("normalizes CRLF and trims trailing newline", () => {
    expect(normalizeGoldenText("a\r\nb\n\n")).toBe("a\nb");
  });

  it("is idempotent for any input", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const once = normalizeGoldenText(text);
        expect(normalizeGoldenText(once)).toBe(once);
      }),
    );
  });

  it("never leaves a carriage return behind", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(normalizeGoldenText(text)).not.toContain("\r\n");
      }),
    );
  });
});

describe("golden file round-trip", () => {
  it("writes then reads the same content", () => {
    const dir = mkdtempSync(`${tmpdir()}/golden-`);
    writeGolden(dir, "fixture.txt", "hello golden");
    expect(readGolden(dir, "fixture.txt")).toBe("hello golden");
    expect(readFileSync(`${dir}/fixture.txt`, "utf8")).toBe("hello golden");
  });
});
