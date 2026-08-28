import { describe, expect, it } from "vitest";
import {
  mapDefaultLiteral,
  mapFromDefaultEntries,
  parseMapDefaultEntries,
} from "./map-default";

describe("parseMapDefaultEntries", () => {
  it("reads JSON { key, value } rows and ignores malformed items", () => {
    expect(parseMapDefaultEntries(undefined)).toEqual([]);
    expect(parseMapDefaultEntries([])).toEqual([]);
    expect(
      parseMapDefaultEntries([
        { key: "a", value: 1 },
        { key: "b", value: 2 },
        "skip",
        { value: 3 },
      ]),
    ).toEqual([
      { key: "a", value: 1 },
      { key: "b", value: 2 },
    ]);
  });

  it("accepts a live Map for editor/runtime round-trip", () => {
    expect(parseMapDefaultEntries(new Map([["a", 1]]))).toEqual([
      { key: "a", value: 1 },
    ]);
  });
});

describe("mapFromDefaultEntries", () => {
  it("builds a Map and lets later duplicate keys win", () => {
    const map = mapFromDefaultEntries([
      { key: "a", value: 1 },
      { key: "a", value: 2 },
    ]);
    expect(map).toBeInstanceOf(Map);
    expect(map.get("a")).toBe(2);
    expect(map.size).toBe(1);
  });
});

describe("mapDefaultLiteral", () => {
  it("emits new Map() when empty and JSON pairs when filled", () => {
    expect(mapDefaultLiteral(undefined)).toBe("new Map()");
    expect(mapDefaultLiteral([])).toBe("new Map()");
    expect(mapDefaultLiteral([{ key: "a", value: 1 }])).toBe(
      'new Map([["a",1]])',
    );
  });
});
