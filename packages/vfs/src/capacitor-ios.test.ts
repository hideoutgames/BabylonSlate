import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../package.json"),
    "utf8",
  ),
) as { dependencies: Record<string, string> };

describe("Capacitor 8 iOS host", () => {
  it("keeps scoped-storage on Capacitor 8", () => {
    expect(pkg.dependencies["@capacitor/core"]).toMatch(/^\^8/);
    expect(pkg.dependencies["@daniele-rolli/capacitor-scoped-storage"]).toBe(
      "^0.0.3",
    );
  });
});
