import { describe, expect, it } from "vitest";
import { scriptValuesEqual } from "./script-values-equal";

class Thing {
  constructor(readonly name: string) {}
}

describe("scriptValuesEqual", () => {
  const shared = new Thing("shared");
  it.each<[string, unknown, unknown, boolean]>([
    ["identical numbers", 3, 3, true],
    ["different numbers", 3, 2, false],
    ["a number and its text", 3, "3", false],
    ["vectors with the same fields", { x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 }, true],
    ["vectors that differ in one field", { x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 4 }, false],
    ["a structure with an extra field", { a: 1 }, { a: 1, b: undefined }, false],
    ["nested structures", { at: { x: 1 }, tags: [1, 2] }, { at: { x: 1 }, tags: [1, 2] }, true],
    ["arrays in a different order", [1, 2], [2, 1], false],
    ["arrays of different lengths", [1, 2], [1, 2, 3], false],
    ["an array and a structure with the same entries", [1], { 0: 1 }, false],
    ["maps with equal entries in any order", new Map([["a", 1], ["b", 2]]), new Map([["b", 2], ["a", 1]]), true],
    ["maps with vector keys", new Map([[{ x: 1 }, "hit"]]), new Map([[{ x: 1 }, "hit"]]), true],
    ["maps with one different value", new Map([["a", 1]]), new Map([["a", 2]]), false],
    ["maps with different keys", new Map([["a", 1]]), new Map([["b", 1]]), false],
    ["the same object", shared, shared, true],
    ["two objects with the same fields", new Thing("one"), new Thing("one"), false],
    ["arrays holding the same object", [shared], [shared], true],
    ["null and an empty structure", null, {}, false],
  ])("%s", (_case, a, b, equal) => {
    expect(scriptValuesEqual(a, b)).toBe(equal);
    expect(scriptValuesEqual(b, a)).toBe(equal);
  });
});
