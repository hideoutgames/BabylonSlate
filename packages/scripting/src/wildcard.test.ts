import { describe, expect, it } from "vitest";
import {
  assertEveryConcreteTypeHasConverter,
  createWildcardNodes,
  wildcardConverterNodeId,
} from "./wildcard";
import { CONCRETE_WILDCARD_TARGETS } from "./types";

describe("wildcard", () => {
  it("generates converters for every concrete target", () => {
    const nodes = createWildcardNodes();
    const ids = new Set(nodes.map((n) => n.id));
    expect(assertEveryConcreteTypeHasConverter(ids)).toEqual([]);
    for (const t of CONCRETE_WILDCARD_TARGETS) {
      expect(ids.has(wildcardConverterNodeId(t))).toBe(true);
    }
  });
});
