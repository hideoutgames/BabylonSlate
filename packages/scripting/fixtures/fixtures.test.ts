import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  NodeRegistry,
  validateGraphs,
  type LogicGraph,
  type TypeContext,
} from "../src/index";

const dir = dirname(fileURLToPath(import.meta.url));

/** Each `<code>.json` is a broken graph plus the context its rule needs. */
type Fixture = LogicGraph & {
  /** TypeContext fields; set-valued ones are stored as arrays. */
  context?: Omit<TypeContext, "assetGuid" | "knownGuids" | "knownClassIds" | "parentEventNames"> & {
    knownGuids?: string[];
    knownClassIds?: string[];
    parentEventNames?: string[];
  };
  /** Node types the registry marks pure (pure-evaluation dependencies). */
  pureTypeIds?: string[];
};

const FIXTURES = readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.slice(0, -".json".length));

describe("validator diagnostic fixtures", () => {
  it.each(FIXTURES)("%s", (code) => {
    const fixture = JSON.parse(
      readFileSync(join(dir, `${code}.json`), "utf8"),
    ) as Fixture;
    const { context = {}, pureTypeIds = [], ...graph } = fixture;
    const registry = new NodeRegistry();
    for (const id of pureTypeIds) {
      registry.register({ id, title: id, category: "fixture", pure: true, pins: () => [], codegen: () => undefined });
    }
    const { knownGuids, knownClassIds, parentEventNames, ...rest } = context;
    const ctx: TypeContext = {
      ...rest,
      assetGuid: "fixture",
      ...(knownGuids ? { knownGuids: new Set(knownGuids) } : {}),
      ...(knownClassIds ? { knownClassIds: new Set(knownClassIds) } : {}),
      ...(parentEventNames ? { parentEventNames: new Set(parentEventNames) } : {}),
    };
    const diags = validateGraphs([graph], ctx, { registry });
    expect(diags.map((entry) => entry.code)).toContain(code);
  });
});
