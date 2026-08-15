import { describe, expect, it } from "vitest";
import { parseSemver, satisfiesRange } from "./semver-range";

describe("parseSemver", () => {
  it("parses major.minor.patch", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("rejects junk", () => {
    expect(parseSemver("nope")).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
  });
});

describe("satisfiesRange", () => {
  it("matches an exact version", () => {
    expect(satisfiesRange("1.2.3", "1.2.3")).toBe(true);
    expect(satisfiesRange("1.2.4", "1.2.3")).toBe(false);
  });

  it("matches caret ranges", () => {
    expect(satisfiesRange("1.2.3", "^1.2.0")).toBe(true);
    expect(satisfiesRange("1.9.0", "^1.2.0")).toBe(true);
    expect(satisfiesRange("2.0.0", "^1.2.0")).toBe(false);
    expect(satisfiesRange("0.2.1", "^0.2.0")).toBe(true);
    expect(satisfiesRange("0.3.0", "^0.2.0")).toBe(false);
  });

  it("matches tilde ranges", () => {
    expect(satisfiesRange("1.2.9", "~1.2.0")).toBe(true);
    expect(satisfiesRange("1.3.0", "~1.2.0")).toBe(false);
  });

  it("matches comparators and x wildcards", () => {
    expect(satisfiesRange("1.4.0", ">=1.2.0")).toBe(true);
    expect(satisfiesRange("1.1.9", ">=1.2.0")).toBe(false);
    expect(satisfiesRange("1.4.0", "<2.0.0")).toBe(true);
    expect(satisfiesRange("2.0.0", "<2.0.0")).toBe(false);
    expect(satisfiesRange("1.9.1", "1.x")).toBe(true);
    expect(satisfiesRange("2.0.0", "1.x")).toBe(false);
  });

  it("matches a space-separated intersection", () => {
    expect(satisfiesRange("1.5.0", ">=1.0.0 <2.0.0")).toBe(true);
    expect(satisfiesRange("2.0.0", ">=1.0.0 <2.0.0")).toBe(false);
  });
});
