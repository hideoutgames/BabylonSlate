import { describe, expect, it } from "vitest";
import {
  assertEveryConcreteTypeHasConverter,
  boxValue,
  createWildcardNodes,
  wildcardConverterNodeId,
} from "./wildcard";
import { CONCRETE_WILDCARD_TARGETS, INT } from "./types";

describe("wildcard", () => {
  it("boxes values with type tags", () => {
    expect(boxValue(INT, 3)).toEqual({ tag: "int", value: 3 });
  });

  it("generates converters for every concrete target", () => {
    const nodes = createWildcardNodes();
    const ids = new Set(nodes.map((n) => n.id));
    expect(assertEveryConcreteTypeHasConverter(ids)).toEqual([]);
    for (const t of CONCRETE_WILDCARD_TARGETS) {
      expect(ids.has(wildcardConverterNodeId(t))).toBe(true);
    }
  });
});
