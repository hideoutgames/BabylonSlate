import { describe, expect, it } from "vitest";
import {
  arrayAppendItem,
  arrayAppendArray,
  arrayClear,
  arrayContains,
  arrayFindIndex,
  arrayFirst,
  arrayGetAt,
  arrayInsertAt,
  arrayIsEmpty,
  arrayIsValidIndex,
  arrayLast,
  arrayLastIndex,
  arrayLength,
  arrayRemoveAt,
  arrayRemoveItem,
  arrayReverse,
  arraySetAt,
  arraySlice,
  mapBreakEntries,
  mapClear,
  mapGet,
  mapHas,
  mapIsEmpty,
  mapKeys,
  mapRemove,
  mapSet,
  mapSize,
  mapValues,
  makeArray,
  makeMap,
} from "./container-ops";

describe("container-ops array", () => {
  it("makes an array from items without sharing the input list", () => {
    const items = [1, 2, 3];
    const made = makeArray(items);
    expect(made).toEqual([1, 2, 3]);
    expect(made).not.toBe(items);
  });

  it("gets with a type default on miss and never returns undefined", () => {
    expect(arrayGetAt([10, 20], 1, 0)).toEqual({ value: 20, valid: true });
    expect(arrayGetAt([10, 20], 5, 0)).toEqual({ value: 0, valid: false });
    expect(arrayGetAt([10, 20], -1, 0).value).not.toBeUndefined();
    expect(arrayGetAt(undefined, 0, "").value).toBe("");
  });

  it("reports length, empty, last index, and valid index", () => {
    expect(arrayLength([1, 2])).toBe(2);
    expect(arrayIsEmpty([])).toBe(true);
    expect(arrayIsEmpty([1])).toBe(false);
    expect(arrayLastIndex([1, 2, 3])).toBe(2);
    expect(arrayLastIndex([])).toBe(-1);
    expect(arrayIsValidIndex([1, 2], 1)).toBe(true);
    expect(arrayIsValidIndex([1, 2], 2)).toBe(false);
  });

  it("contains and finds the first index", () => {
    expect(arrayContains(["a", "b"], "b")).toBe(true);
    expect(arrayFindIndex(["a", "b", "a"], "a")).toBe(0);
    expect(arrayFindIndex(["a", "b"], "z")).toBe(-1);
  });

  it("immutably appends, sets, inserts, removes, clears, reverses, and slices", () => {
    const base = [1, 2, 3];
    expect(arrayAppendItem(base, 4)).toEqual([1, 2, 3, 4]);
    expect(arrayAppendArray(base, [4, 5])).toEqual([1, 2, 3, 4, 5]);
    expect(arraySetAt(base, 1, 9)).toEqual({ array: [1, 9, 3], success: true });
    expect(arraySetAt(base, 9, 9).success).toBe(false);
    expect(arrayInsertAt(base, 1, 9)).toEqual([1, 9, 2, 3]);
    expect(arrayRemoveAt(base, 1)).toEqual({ array: [1, 3], success: true });
    expect(arrayRemoveItem(base, 2)).toEqual({ array: [1, 3], success: true });
    expect(arrayRemoveItem(base, 9).success).toBe(false);
    expect(arrayClear(base)).toEqual([]);
    expect(arrayReverse(base)).toEqual([3, 2, 1]);
    expect(arraySlice(base, 1, 3)).toEqual([2, 3]);
    expect(base).toEqual([1, 2, 3]);
  });

  it("reads first and last with defaults on empty", () => {
    expect(arrayFirst([7, 8], 0)).toBe(7);
    expect(arrayLast([7, 8], 0)).toBe(8);
    expect(arrayFirst([], 0)).toBe(0);
    expect(arrayLast([], "")).toBe("");
  });
});

describe("container-ops map", () => {
  it("makes a map from key/value pairs without sharing the source", () => {
    const pairs: Array<[string, number]> = [
      ["a", 1],
      ["b", 2],
    ];
    const made = makeMap(pairs);
    expect([...made.entries()]).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    made.set("c", 3);
    expect(pairs).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("gets value with found and type default on miss", () => {
    const map = new Map<string, number>([["x", 3]]);
    expect(mapGet(map, "x", 0)).toEqual({ value: 3, found: true });
    expect(mapGet(map, "missing", 0)).toEqual({ value: 0, found: false });
    expect(mapGet(undefined, "x", "").value).not.toBeUndefined();
  });

  it("sets, has, removes with removed, size, empty, clear", () => {
    const map = new Map<string, number>([["a", 1]]);
    expect(mapHas(map, "a")).toBe(true);
    const afterSet = mapSet(map, "b", 2);
    expect([...afterSet.entries()]).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(map).toEqual(new Map([["a", 1]]));
    const removed = mapRemove(map, "a");
    expect(removed.removed).toBe(true);
    expect([...removed.map.keys()]).toEqual([]);
    expect(mapSize(map)).toBe(1);
    expect(mapIsEmpty(new Map())).toBe(true);
    expect(mapClear(map)).toEqual(new Map());
  });

  it("breaks keys and values in insertion order", () => {
    const map = new Map<string, number>([
      ["first", 1],
      ["second", 2],
      ["third", 3],
    ]);
    expect(mapKeys(map)).toEqual(["first", "second", "third"]);
    expect(mapValues(map)).toEqual([1, 2, 3]);
    expect(mapBreakEntries(map)).toEqual({
      keys: ["first", "second", "third"],
      values: [1, 2, 3],
    });
  });
});
