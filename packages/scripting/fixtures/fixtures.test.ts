import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateGraphs, type LogicGraph } from "../src/index";

const dir = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): LogicGraph {
  return JSON.parse(
    readFileSync(join(dir, name), "utf8"),
  ) as LogicGraph;
}

describe("validator fixtures", () => {
  it("type.mismatch fixture", () => {
    const graph = loadFixture("type-mismatch.json");
    const diags = validateGraphs([graph], { assetGuid: "fixture" });
    expect(diags.some((d) => d.code === "type.mismatch")).toBe(true);
  });

  it("js.parse fixture", () => {
    const graph = loadFixture("js-parse-error.json");
    const diags = validateGraphs([graph], { assetGuid: "fixture" });
    expect(diags.some((d) => d.code === "js.parse")).toBe(true);
  });
});
