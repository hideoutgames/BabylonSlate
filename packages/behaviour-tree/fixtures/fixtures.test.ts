import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseBehaviourTreeDocument, validateBehaviourTree } from "../src/index";

const dir = dirname(fileURLToPath(import.meta.url));

const FIXTURES = readdirSync(dir)
  .filter((name) => name.startsWith("bt.") && name.endsWith(".json"))
  .map((name) => name.slice(0, -".json".length));

describe("behaviour tree diagnostic fixtures", () => {
  it.each(FIXTURES)("%s", (code) => {
    const raw = JSON.parse(readFileSync(join(dir, `${code}.json`), "utf8"));
    const tree = parseBehaviourTreeDocument(raw);
    expect(tree).not.toBeNull();
    const blackboardKeys = Array.isArray(raw.blackboardKeys)
      ? raw.blackboardKeys.filter((entry: unknown) => typeof entry === "string")
      : undefined;
    const diags = validateBehaviourTree(tree!, { assetGuid: "fixture", blackboardKeys });
    expect(diags.some((row) => row.code === code)).toBe(true);
  });
});
