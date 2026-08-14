import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearValidationRules,
  listValidationRules,
  validateGraphs,
} from "@babylonslate/scripting";
import {
  createDefaultBehaviourTree,
  parseBehaviourTreeDocument,
  registerBehaviourTreeValidationRules,
  validateBehaviourTree,
} from "../src/index";

const dir = dirname(fileURLToPath(import.meta.url));

const FIXTURES = readdirSync(dir)
  .filter((name) => name.startsWith("bt.") && name.endsWith(".json"))
  .map((name) => name.slice(0, -".json".length));

describe("behaviour tree diagnostic fixtures", () => {
  it.each(FIXTURES)("%s", (code) => {
    const raw = JSON.parse(readFileSync(join(dir, `${code}.json`), "utf8"));
    const tree = parseBehaviourTreeDocument(raw);
    expect(tree).not.toBeNull();
    const diags = validateBehaviourTree(tree!, { assetGuid: "fixture" });
    expect(diags.some((row) => row.code === code)).toBe(true);
  });
});

describe("behaviour tree scripting hook", () => {
  beforeEach(() => {
    clearValidationRules();
  });

  it("registers a bt.structural rule on the scripting validator", () => {
    registerBehaviourTreeValidationRules();
    expect(listValidationRules().some((rule) => rule.id === "bt.structural")).toBe(true);
  });

  it("emits tree diagnostics from validateGraphs when TypeContext carries the payload", () => {
    registerBehaviourTreeValidationRules();
    const tree = createDefaultBehaviourTree();
    tree.rootId = "gone";
    const diags = validateGraphs([], {
      assetGuid: "tree-1",
      behaviourTree: tree,
    });
    expect(diags.some((row) => row.code === "bt.missing_root")).toBe(true);
  });

  it("is idempotent and ignores an unparseable payload", () => {
    registerBehaviourTreeValidationRules();
    registerBehaviourTreeValidationRules();
    expect(listValidationRules().filter((rule) => rule.id === "bt.structural")).toHaveLength(1);
    expect(
      validateGraphs([], { assetGuid: "tree-1", behaviourTree: { nope: true } }),
    ).toEqual([]);
  });
});
