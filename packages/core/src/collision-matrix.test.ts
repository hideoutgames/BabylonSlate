import { describe, expect, it } from "vitest";
import {
  collisionMatrixAllows,
  normalizeCollisionMatrix,
  parseCollisionMaskSource,
  resolveCollisionMask,
  setCollisionMatrixPair,
} from "./collision-matrix";

describe("collision matrix", () => {
  it("defaults every named layer to collide with every layer", () => {
    expect(normalizeCollisionMatrix(undefined, 3)).toEqual([0xffffffff, 0xffffffff, 0xffffffff]);
  });

  it("keeps a pair only when both rows agree, and unnamed layers always collide", () => {
    // Row 0 drops layer 1, but row 1 still lists layer 0: the pair is off for both.
    const matrix = normalizeCollisionMatrix([0xffffffff - 2, 0xffffffff], 2);
    expect(collisionMatrixAllows(matrix, 0, 1)).toBe(false);
    expect(collisionMatrixAllows(matrix, 1, 0)).toBe(false);
    expect(collisionMatrixAllows(matrix, 0, 0)).toBe(true);
    expect(collisionMatrixAllows(matrix, 1, 7)).toBe(true);
  });

  it("follows the layer count and toggles a pair on both rows", () => {
    expect(normalizeCollisionMatrix([1, 1, 1, 1], 2)).toHaveLength(2);
    const off = setCollisionMatrixPair(normalizeCollisionMatrix(undefined, 3), 0, 2, false);
    expect(collisionMatrixAllows(off, 0, 2)).toBe(false);
    expect(collisionMatrixAllows(off, 2, 0)).toBe(false);
    expect(collisionMatrixAllows(off, 0, 1)).toBe(true);
  });

  it("resolves a project collider's mask from its layer rows and leaves custom masks alone", () => {
    const matrix = setCollisionMatrixPair(normalizeCollisionMatrix(undefined, 3), 1, 2, false);
    expect(resolveCollisionMask(0b010, 0xffffffff, "project", matrix)).toBe(matrix[1]);
    expect(resolveCollisionMask(0b110, 0, "project", matrix)).toBe((matrix[1]! | matrix[2]!) >>> 0);
    expect(resolveCollisionMask(0, 0xffffffff, "project", matrix)).toBe(0);
    expect(resolveCollisionMask(0b010, 5, "custom", matrix)).toBe(5);
    expect(resolveCollisionMask(0b010, 5, "project", undefined)).toBe(5);
  });

  it("reads a missing or unknown source as custom so older documents keep their masks", () => {
    expect(parseCollisionMaskSource(undefined)).toBe("custom");
    expect(parseCollisionMaskSource("project")).toBe("project");
  });
});
