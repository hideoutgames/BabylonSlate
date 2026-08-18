import { describe, expect, it } from "vitest";
import { objectContainRect } from "./object-contain";

describe("objectContainRect", () => {
  it("letterboxes a landscape image in a square", () => {
    expect(objectContainRect(1, 1, 200, 100)).toEqual({
      left: 0,
      top: 0.25,
      width: 1,
      height: 0.5,
    });
  });

  it("pillarboxes a portrait image in a square", () => {
    expect(objectContainRect(100, 100, 50, 100)).toEqual({
      left: 25,
      top: 0,
      width: 50,
      height: 100,
    });
  });
});
