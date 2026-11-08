import { describe, expect, it } from "vitest";
import { RandomStream, drawRandom, drawSeeded, newSessionSeed, normalizeRandomSeed } from "./random-seed";

function draws(stream: RandomStream, count: number): number[] {
  return Array.from({ length: count }, () => stream.next());
}

describe("Random seeds", () => {
  it("resume a sequence at any Step exactly where drawing that many values would leave it", () => {
    const walked = new RandomStream("dungeon");
    const prefix = draws(walked, 5);
    expect(walked.snapshot()).toEqual({ Seed: "dungeon", Step: 5 });
    expect(draws(new RandomStream("dungeon", 5), 4)).toEqual(draws(walked, 4));
    expect(draws(new RandomStream("dungeon"), 5)).toEqual(prefix);
    expect(draws(new RandomStream("dungeon!"), 5)).not.toEqual(prefix);
  });

  it("take any text and a whole Step, reading missing fields as the empty Seed at Step 0", () => {
    expect(normalizeRandomSeed({ Seed: 42, Step: 3.9 })).toEqual({ Seed: "42", Step: 3 });
    expect(normalizeRandomSeed(null)).toEqual({ Seed: "", Step: 0 });
    // Step is an Int: past the largest one it wraps, and so does the sequence (2^32 values).
    const last = new RandomStream("x", 0x7fffffff);
    last.next();
    expect(last.step).toBe(-0x80000000);
  });

  it("advance a Seed by every value a draw takes", () => {
    const seed = { Seed: "loot", Step: 2 };
    expect(drawSeeded(seed, "float").seed).toEqual({ Seed: "loot", Step: 3 });
    expect(drawSeeded(seed, "unitVector").seed.Step).toBe(4);
    expect(drawSeeded(seed, "range:vec3", { Min: { x: 0, y: 0, z: 0 }, Max: { x: 1, y: 1, z: 1 } }).seed.Step).toBe(5);
    expect(drawSeeded(seed, "shuffle", ["a", "b", "c", "d"]).seed.Step).toBe(5);
    // Nothing to pick from takes no value.
    expect(drawSeeded(seed, "arrayItem", [])).toEqual({ value: { item: undefined, index: -1 }, seed });
    expect(drawSeeded(seed, "int", 3, 3).seed.Step).toBe(2);
    expect(drawSeeded(seed, "float").value).toBe(new RandomStream("loot", 2).nextFloat());
  });

  it("draw each shape the Random nodes return", () => {
    const stream = new RandomStream("shapes");
    for (let index = 0; index < 50; index++) {
      const { x, y, z } = drawRandom(stream, "unitVector") as { x: number; y: number; z: number };
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 12);
      const roll = drawRandom(stream, "int", 6, 1) as number;
      expect(roll).toBeGreaterThanOrEqual(1);
      expect(roll).toBeLessThanOrEqual(6);
    }
    expect(drawRandom(stream, "boolWithWeight", 0)).toBe(false);
    expect(drawRandom(stream, "boolWithWeight", 1)).toBe(true);
    const items = ["a", "b", "c", "d", "e"];
    const shuffled = drawRandom(stream, "shuffle", items) as string[];
    expect([...shuffled].sort()).toEqual(items);
    expect(items).toEqual(["a", "b", "c", "d", "e"]);
    const { item, index } = drawRandom(stream, "arrayItem", items) as { item: string; index: number };
    expect(items[index]).toBe(item);
  });

  it("start each session from a fresh 32-bit seed", () => {
    const seeds = new Set(Array.from({ length: 8 }, () => newSessionSeed()));
    expect(seeds.size).toBeGreaterThan(1);
    for (const seed of seeds) expect(Number.isInteger(seed) && seed >= 0 && seed < 2 ** 32).toBe(true);
  });
});
