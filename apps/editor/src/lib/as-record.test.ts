import { describe, expect, it } from "vitest";
import { asRecord } from "./as-record";

describe("asRecord", () => {
  it("returns an object as it is", () => {
    const payload = { kind: "skeleton" };
    expect(asRecord(payload)).toBe(payload);
  });

  it.each([
    ["an array", [1, 2]],
    ["null", null],
    ["undefined", undefined],
    ["a string", "payload"],
    ["a number", 3],
  ])("reads %s as an empty record", (_label, value) => {
    expect(asRecord(value)).toEqual({});
  });
});
