import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "document-context.tsx"),
  "utf8",
);

describe("document Play loaders", () => {
  it("does not keep a path-based Play fallback when no scene tab is open", () => {
    expect(source).not.toContain("collectPlayStartupScene");
  });
});
