import { describe, expect, it } from "vitest";
import {
  err,
  isErr,
  isOk,
  newGuid,
  ok,
  type Guid,
} from "./guid-result";
import {
  createSeededRng,
  identityTransform,
  quatIdentity,
  serializeTransform,
  serializeVec3,
  vec3,
} from "./math-rng";

describe("Guid", () => {
  it("newGuid returns a non-empty string", () => {
    const id: Guid = newGuid();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("accepts an injectable factory for deterministic tests", () => {
    let n = 0;
    const id = newGuid(() => `fixed-${++n}`);
    expect(id).toBe("fixed-1");
    expect(newGuid(() => `fixed-${++n}`)).toBe("fixed-2");
  });
});

describe("Result", () => {
  it("ok and err discriminate correctly", () => {
    const a = ok(42);
    const b = err("nope");
    expect(isOk(a)).toBe(true);
    expect(isErr(a)).toBe(false);
    expect(isOk(b)).toBe(false);
    expect(isErr(b)).toBe(true);
    if (isOk(a)) expect(a.value).toBe(42);
    if (isErr(b)) expect(b.error).toBe("nope");
  });
});

describe("math", () => {
  it("serializes Vec3 and Transform deterministically", () => {
    const t = identityTransform();
    t.position = vec3(1, 2, 3);
    expect(serializeVec3(t.position)).toEqual([1, 2, 3]);
    expect(serializeTransform(t)).toEqual({
      position: [1, 2, 3],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    });
    expect(quatIdentity()).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });
});

describe("seeded RNG", () => {
  it("is deterministic for the same seed", () => {
    const a = createSeededRng(12345);
    const b = createSeededRng(12345);
    const seqA = Array.from({ length: 8 }, () => a.next());
    const seqB = Array.from({ length: 8 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("differs across seeds and nextFloat is in [0,1)", () => {
    const a = createSeededRng(1);
    const b = createSeededRng(2);
    expect(a.next()).not.toBe(b.next());
    const f = createSeededRng(99).nextFloat();
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThan(1);
  });
});
