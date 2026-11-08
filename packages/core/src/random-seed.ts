import type { Rng } from "./math-rng";
import { clampToRange, randomInRange, type RangeKind } from "./curves";

/**
 * A random sequence and how far along it is: the `engine:Seed` Structure. The same Seed text always gives
 * the same sequence, and Step counts the numbers already drawn, so a saved Seed resumes where it left off.
 */
export type RandomSeed = { Seed: string; Step: number };

/** Mulberry32's state increment (`createSeededRng`): the state after `n` draws is `base + n × increment`. */
const MULBERRY32_INCREMENT = 0x6d2b79f5;

/** 32-bit FNV-1a of the Seed text: where its sequence starts. */
function seedBase(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function mulberry32(state: number): number {
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

/** A whole Step that fits an Int; it wraps like the sequence, which repeats every 2^32 draws. */
function stepOf(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) | 0 : 0;
}

/** A Seed value from anything a graph holds: missing text is the empty Seed, a missing Step is 0. */
export function normalizeRandomSeed(value: unknown): RandomSeed {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const seed = record.Seed;
  return { Seed: typeof seed === "string" ? seed : seed == null ? "" : String(seed), Step: stepOf(record.Step) };
}

/**
 * Mulberry32 positioned by Seed text and Step. Jumping to any Step costs nothing, because the generator's
 * state is a counter: each draw advances Step by one, so Step is the number of values drawn so far.
 */
export class RandomStream implements Rng {
  private base = 0;
  private seedText = "";
  private drawn = 0;

  constructor(seed: string, step = 0) {
    this.reset(seed, step);
  }

  get seed(): string {
    return this.seedText;
  }

  get step(): number {
    return this.drawn;
  }

  /** Continue from `step` of the sequence for `seed`. */
  reset(seed: string, step = 0): void {
    this.seedText = seed;
    this.base = seedBase(seed);
    this.drawn = stepOf(step);
  }

  next(): number {
    this.drawn = (this.drawn + 1) | 0;
    return mulberry32((this.base + Math.imul(this.drawn, MULBERRY32_INCREMENT)) >>> 0);
  }

  nextFloat(): number {
    return this.next() / 0x100000000;
  }

  snapshot(): RandomSeed {
    return { Seed: this.seedText, Step: this.drawn };
  }
}

/**
 * A fresh session seed for Play and exported games, so the normal Random nodes differ between runs. The
 * runtime records it in traces, so a replay repeats the run; Set Global Randomization Seed overrides it.
 */
export function newSessionSeed(): number {
  const values = new Uint32Array(1);
  globalThis.crypto.getRandomValues(values);
  return values[0]!;
}

/** What a Random node draws; a Seeded Random node names the same draw. */
export type RandomDraw =
  | "float" | "int" | "bool" | "boolWithWeight" | "unitVector" | "arrayItem" | "shuffle"
  | `range:${RangeKind}`;

/** Random Int: Min to Max, both included; reversed bounds swap. One draw unless they are equal. */
function randomInt(rng: Rng, min: unknown, max: unknown): number {
  const a = Number(min) | 0;
  const b = Number(max) | 0;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (hi === lo) return lo;
  return lo + (rng.next() % (hi - lo + 1));
}

/** Random Unit Vector: uniform over the sphere from two draws. */
function randomUnitVector(rng: Rng): { x: number; y: number; z: number } {
  const z = 2 * rng.nextFloat() - 1;
  const angle = 2 * Math.PI * rng.nextFloat();
  const radius = Math.sqrt(Math.max(0, 1 - z * z));
  return { x: radius * Math.cos(angle), y: radius * Math.sin(angle), z };
}

/** Random Array Item: one draw; an empty Array draws nothing and returns no item at Index -1. */
function randomArrayItem(rng: Rng, array: unknown): { item: unknown; index: number } {
  const items = Array.isArray(array) ? array : [];
  if (items.length === 0) return { item: undefined, index: -1 };
  const index = rng.next() % items.length;
  return { item: items[index], index };
}

/** Shuffle Array: a reordered copy (Fisher–Yates), one draw per item after the first. */
function shuffleArray(rng: Rng, array: unknown): unknown[] {
  const items = Array.isArray(array) ? [...array] : [];
  for (let index = items.length - 1; index > 0; index--) {
    const swap = rng.next() % (index + 1);
    [items[index], items[swap]] = [items[swap], items[index]];
  }
  return items;
}

/**
 * One Random node's draw. `a` and `b` are its inputs: Min and Max, Weight, the Array, or the Range. Every
 * value drawn advances the generator by one Step: Random Unit Vector takes two, a Vector In Range three.
 */
export function drawRandom(rng: Rng, draw: RandomDraw, a?: unknown, b?: unknown): unknown {
  switch (draw) {
    case "float": return rng.nextFloat();
    case "int": return randomInt(rng, a, b);
    case "bool": return rng.nextFloat() < 0.5;
    case "boolWithWeight": return rng.nextFloat() < clampToRange("float", a, { Min: 0, Max: 1 });
    case "unitVector": return randomUnitVector(rng);
    case "arrayItem": return randomArrayItem(rng, a);
    case "shuffle": return shuffleArray(rng, a);
    default: return randomInRange(draw.slice("range:".length) as RangeKind, a, rng);
  }
}

/** A Seeded Random node: the draw from `seed` and the Seed moved on by the values it took. */
export function drawSeeded(seed: unknown, draw: RandomDraw, a?: unknown, b?: unknown): { value: unknown; seed: RandomSeed } {
  const start = normalizeRandomSeed(seed);
  const stream = new RandomStream(start.Seed, start.Step);
  const value = drawRandom(stream, draw, a, b);
  return { value, seed: stream.snapshot() };
}
