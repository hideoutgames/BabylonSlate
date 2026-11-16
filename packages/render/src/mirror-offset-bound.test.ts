import { AddBlock } from "@babylonjs/core/Materials/Node/Blocks/addBlock";
import { ClampBlock } from "@babylonjs/core/Materials/Node/Blocks/clampBlock";
import { DivideBlock } from "@babylonjs/core/Materials/Node/Blocks/divideBlock";
import { InputBlock } from "@babylonjs/core/Materials/Node/Blocks/Input/inputBlock";
import { LerpBlock } from "@babylonjs/core/Materials/Node/Blocks/lerpBlock";
import { MaxBlock } from "@babylonjs/core/Materials/Node/Blocks/maxBlock";
import { MinBlock } from "@babylonjs/core/Materials/Node/Blocks/minBlock";
import { MultiplyBlock } from "@babylonjs/core/Materials/Node/Blocks/multiplyBlock";
import { NegateBlock } from "@babylonjs/core/Materials/Node/Blocks/negateBlock";
import { OneMinusBlock } from "@babylonjs/core/Materials/Node/Blocks/oneMinusBlock";
import { ScaleBlock } from "@babylonjs/core/Materials/Node/Blocks/scaleBlock";
import { SimplexPerlin3DBlock } from "@babylonjs/core/Materials/Node/Blocks/simplexPerlin3DBlock";
import { SubtractBlock } from "@babylonjs/core/Materials/Node/Blocks/subtractBlock";
import { TrigonometryBlock, TrigonometryBlockOperations } from "@babylonjs/core/Materials/Node/Blocks/trigonometryBlock";
import { VectorMergerBlock } from "@babylonjs/core/Materials/Node/Blocks/vectorMergerBlock";
import { VectorSplitterBlock } from "@babylonjs/core/Materials/Node/Blocks/vectorSplitterBlock";
import { NodeMaterialBlockConnectionPointTypes as Types } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockConnectionPointTypes";
import type { NodeMaterialConnectionPoint } from "@babylonjs/core/Materials/Node/nodeMaterialBlockConnectionPoint";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { describe, expect, it } from "vitest";
import { GameTimeInputBlock } from "./game-time-input-block";
import {
  absolute, add, boundOutput, clamp, lerp, maximum, minimum, multiply, negate, offsetReach, oneMinus, periodic,
  SIMPLEX_PERLIN_3D_BOUND, subtract, type Interval,
} from "./mirror-offset-bound";
import { MirrorReflectionBlock } from "./mirror-reflection-block";

/** A deterministic generator, so a failure reproduces. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const value = (name: string, v: number | Vector2 | Vector3) => {
  const block = new InputBlock(name, undefined, typeof v === "number" ? Types.Float : v instanceof Vector2 ? Types.Vector2 : Types.Vector3);
  block.value = v;
  return block;
};

describe("interval rules hold every value their operation computes", () => {
  const next = random(7);
  /** A random interval: finite, or with an unbounded side now and then. */
  const interval = (): Interval => {
    const a = (next() - 0.5) * 20, b = (next() - 0.5) * 20;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const pick = next();
    if (pick < 0.05) return { lo: [-Infinity], hi: [hi] };
    if (pick < 0.1) return { lo: [lo], hi: [Infinity] };
    if (pick < 0.15) return { lo: [0], hi: [0] };
    return { lo: [lo], hi: [hi] };
  };
  /** A finite value inside `range` (unbounded sides reach 1e6 past the finite one). */
  const inside = (range: Interval) => {
    const lo = Number.isFinite(range.lo[0]!) ? range.lo[0]! : (Number.isFinite(range.hi[0]!) ? range.hi[0]! : 0) - 1e6 * next();
    const hi = Number.isFinite(range.hi[0]!) ? range.hi[0]! : lo + 1e6 * next();
    const t = next();
    return t < 0.1 ? lo : t < 0.2 ? hi : lo + (hi - lo) * next();
  };
  const holds = (range: Interval | null, v: number) => {
    expect(range).not.toBeNull();
    expect(v).toBeGreaterThanOrEqual(range!.lo[0]!);
    expect(v).toBeLessThanOrEqual(range!.hi[0]!);
  };
  const cases: { name: string; arity: 1 | 2 | 3; rule: (...args: Interval[]) => Interval | null; op: (...args: number[]) => number }[] = [
    { name: "add", arity: 2, rule: add, op: (a, b) => a! + b! },
    { name: "subtract", arity: 2, rule: subtract, op: (a, b) => a! - b! },
    { name: "multiply", arity: 2, rule: multiply, op: (a, b) => a! * b! },
    { name: "min", arity: 2, rule: minimum, op: (a, b) => Math.min(a!, b!) },
    { name: "max", arity: 2, rule: maximum, op: (a, b) => Math.max(a!, b!) },
    { name: "negate", arity: 1, rule: negate, op: (a) => -1 * a! },
    { name: "one minus", arity: 1, rule: oneMinus, op: (a) => 1 - a! },
    { name: "abs", arity: 1, rule: absolute, op: (a) => Math.abs(a!) },
    { name: "sin", arity: 1, rule: periodic, op: (a) => Math.sin(a!) },
    { name: "cos", arity: 1, rule: periodic, op: (a) => Math.cos(a!) },
    // GLSL's mix(a, b, t) is a·(1 − t) + b·t.
    { name: "lerp", arity: 3, rule: lerp, op: (a, b, t) => a! * (1 - t!) + b! * t! },
  ];
  for (const { name, arity, rule, op } of cases) {
    it(name, () => {
      for (let trial = 0; trial < 400; trial++) {
        const ranges = Array.from({ length: arity }, interval);
        const bound = rule(...ranges);
        for (let sample = 0; sample < 20; sample++) {
          const result = op(...ranges.map(inside));
          // Sums of values near 1e6 round: compare with a rounding slack far below the bound's own margin.
          const slack = 1e-9 * Math.max(1, Math.abs(result));
          holds(bound && { lo: [bound.lo[0]! - slack], hi: [bound.hi[0]! + slack] }, result);
        }
      }
    });
  }
  it("clamp", () => {
    for (let trial = 0; trial < 400; trial++) {
      const range = interval();
      const a = (next() - 0.5) * 10, b = (next() - 0.5) * 10;
      const bound = clamp(range, Math.min(a, b), Math.max(a, b));
      for (let sample = 0; sample < 20; sample++) holds(bound, Math.min(Math.max(inside(range), Math.min(a, b)), Math.max(a, b)));
    }
    // GLSL leaves clamp with min above max undefined.
    expect(clamp({ lo: [0], hi: [1] }, 1, 0)).toBeNull();
  });
  it("broadcasts one component over a vector and refuses other width mismatches", () => {
    expect(multiply({ lo: [1, -2], hi: [2, 3] }, { lo: [2], hi: [2] })).toEqual({ lo: [2, -4], hi: [4, 6] });
    expect(add({ lo: [0, 0, 0], hi: [1, 1, 1] }, { lo: [0, 0], hi: [1, 1] })).toBeNull();
  });
});

describe("Simplex Perlin 3D", () => {
  /** Babylon's SimplexPerlin3DBlock function, transcribed line for line (single precision aside). */
  function simplexPerlin3D(sx: number, sy: number, sz: number): number {
    const fract = (v: number) => v - Math.floor(v);
    const step = (edge: number, v: number) => (v < edge ? 0 : 1);
    let P = [sx === 0 && sy === 0 && sz === 0 ? 0.00001 : sx, sy, sz];
    P = P.map((v) => v * Math.SQRT1_2);
    const skew = (P[0]! + P[1]! + P[2]!) / 3;
    let Pi = P.map((v) => Math.floor(v + skew));
    const unskew = (Pi[0]! + Pi[1]! + Pi[2]!) / 6;
    const x0 = P.map((v, i) => v - Pi[i]! + unskew);
    const g = [step(x0[1]!, x0[0]!), step(x0[2]!, x0[1]!), step(x0[0]!, x0[2]!)];
    const l = g.map((v) => 1 - v);
    let Pi1 = [Math.min(g[0]!, l[2]!), Math.min(g[1]!, l[0]!), Math.min(g[2]!, l[1]!)];
    let Pi2 = [Math.max(g[0]!, l[2]!), Math.max(g[1]!, l[0]!), Math.max(g[2]!, l[1]!)];
    const x1 = x0.map((v, i) => v - Pi1[i]! + 1 / 6);
    const x2 = x0.map((v, i) => v - Pi2[i]! + 1 / 3);
    const x3 = x0.map((v) => v - 0.5);
    const vx = [x0[0]!, x1[0]!, x2[0]!, x3[0]!], vy = [x0[1]!, x1[1]!, x2[1]!, x3[1]!], vz = [x0[2]!, x1[2]!, x2[2]!, x3[2]!];
    Pi = Pi.map((v) => v - Math.floor(v * (1 / 69)) * 69);
    const PiInc1 = Pi.map((v) => step(v, 69 - 1.5) * (v + 1));
    let Pt = [Pi[0]! + 50, Pi[1]! + 161, PiInc1[0]! + 50, PiInc1[1]! + 161].map((v) => v * v);
    const mix = (a: number, b: number, t: number) => a * (1 - t) + b * t;
    const V = [mix(Pt[0]!, Pt[2]!, Pi1[0]!), mix(Pt[1]!, Pt[3]!, Pi1[1]!), mix(Pt[0]!, Pt[2]!, Pi2[0]!), mix(Pt[1]!, Pt[3]!, Pi2[1]!)];
    Pt = [Pt[0]! * Pt[1]!, V[0]! * V[1]!, V[2]! * V[3]!, Pt[2]! * Pt[3]!];
    const large = [635.298681, 682.357502, 668.926525], zinc = [48.500388, 65.294118, 63.934599];
    const lowz = large.map((v, i) => 1 / (v + Pi[2]! * zinc[i]!));
    const highz = large.map((v, i) => 1 / (v + PiInc1[2]! * zinc[i]!));
    Pi1 = Pi1[2]! < 0.5 ? lowz : highz;
    Pi2 = Pi2[2]! < 0.5 ? lowz : highz;
    const hash = (axis: number) => [lowz[axis]!, Pi1[axis]!, Pi2[axis]!, highz[axis]!].map((m, i) => fract(Pt[i]! * m) - 0.49999);
    const h0 = hash(0), h1 = hash(1), h2 = hash(2);
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      const grad = (h0[i]! * vx[i]! + h1[i]! * vy[i]! + h2[i]! * vz[i]!) / Math.sqrt(h0[i]! ** 2 + h1[i]! ** 2 + h2[i]! ** 2);
      const weight = Math.max(0.5 - (vx[i]! ** 2 + vy[i]! ** 2 + vz[i]! ** 2), 0);
      sum += weight ** 3 * grad;
    }
    return sum * 37.837227241611316;
  }

  it("holds the bound: N · Σ f(|x0 − cᵢ|) over every x0, for each step outcome the shader can compute", () => {
    // f(r) = r · max(0.5 − r², 0)³ bounds a corner's term over its unit gradient; |f′| ≤ 0.125 (at r = 0).
    const f = (r2: number) => { const w = 0.5 - r2; return w > 0 ? Math.sqrt(r2) * w * w * w : 0; };
    let slope = 0;
    for (let r = 0; r <= Math.SQRT1_2; r += 1e-5) { const w = 0.5 - r * r; slope = Math.max(slope, Math.abs(w ** 3 - 6 * r * r * w * w)); }
    expect(slope).toBeLessThanOrEqual(0.125);
    const corners = (bits: number) => {
      const g = [bits & 1, (bits >> 1) & 1, (bits >> 2) & 1];
      const lz = [1 - g[2]!, 1 - g[0]!, 1 - g[1]!];
      const pi1 = g.map((v, i) => Math.min(v, lz[i]!)), pi2 = g.map((v, i) => Math.max(v, lz[i]!));
      return [[0, 0, 0], pi1.map((v) => v - 1 / 6), pi2.map((v) => v - 1 / 3), [0.5, 0.5, 0.5]];
    };
    const sum = (c: number[][], x: number, y: number, z: number) => {
      let s = 0;
      for (let i = 0; i < 4; i++) {
        const k = c[i]!, dx = x - k[0]!, dy = y - k[1]!, dz = z - k[2]!;
        s += f(dx * dx + dy * dy + dz * dz);
      }
      return s;
    };
    // Every term is 0 outside [−1.1, 1.6]³: the corners lie in [−1/3, 5/6]³ and a term reaches √0.5 from its corner.
    const N = 37.837227241611316;
    // g = 000 needs x < y < z < x. Every mixed g, on a grid of step h: the sum moves at most 4 · 0.125 · h√3/2 off it.
    const h = 0.0075;
    let mixed = 0;
    for (let bits = 1; bits < 7; bits++) {
      const c = corners(bits);
      for (let x = -1.1; x <= 1.6 + h; x += h) for (let y = -1.1; y <= 1.6 + h; y += h) for (let z = -1.1; z <= 1.6 + h; z += h) {
        const s = sum(c, x, y, z);
        if (s > mixed) mixed = s;
      }
    }
    expect(N * (mixed + 0.5 * h * Math.sqrt(3) / 2)).toBeLessThan(SIMPLEX_PERLIN_3D_BOUND);
    // g = 111 needs x0's components equal: x0 = (t, t, t), with grid points h√3 apart along the line.
    const step = 1e-4, diagonal = corners(7);
    let equal = 0;
    for (let t = -1.1; t <= 1.6 + step; t += step) equal = Math.max(equal, sum(diagonal, t, t, t));
    expect(N * (equal + 0.5 * step * Math.sqrt(3) / 2)).toBeLessThan(SIMPLEX_PERLIN_3D_BOUND);
  }, 60_000);

  it("stays within the bound over a dense sample of the shader's own function", () => {
    const next = random(11);
    let largest = 0;
    for (let sample = 0; sample < 200_000; sample++) {
      const scale = sample % 2 ? 4 : 400;
      const n = simplexPerlin3D((next() - 0.5) * scale, (next() - 0.5) * scale, (next() - 0.5) * scale);
      largest = Math.max(largest, Math.abs(n));
    }
    expect(largest).toBeLessThanOrEqual(SIMPLEX_PERLIN_3D_BOUND);
    // The function itself stays near ±1, inside the bound.
    expect(largest).toBeLessThan(1.1);
  });

  it("bounds the block whatever its finite argument, and not an argument no rule covers", () => {
    const noise = new SimplexPerlin3DBlock("noise");
    const time = new GameTimeInputBlock("time");
    const seed = new VectorMergerBlock("seed");
    time.output.connectTo(seed.x);
    seed.xyzOut.connectTo(noise.seed);
    expect(boundOutput(noise.output)).toEqual({ lo: [-SIMPLEX_PERLIN_3D_BOUND], hi: [SIMPLEX_PERLIN_3D_BOUND] });
    const divide = new DivideBlock("divide");
    value("a", 1).output.connectTo(divide.left);
    value("b", 2).output.connectTo(divide.right);
    const unknown = new VectorMergerBlock("unknown seed");
    divide.output.connectTo(unknown.x);
    const other = new SimplexPerlin3DBlock("other");
    unknown.xyzOut.connectTo(other.seed);
    expect(boundOutput(other.output)).toBeNull();
  });
});

describe("Mirror Reflection Offset reach", () => {
  const reachOf = (source: NodeMaterialConnectionPoint) => {
    const block = new MirrorReflectionBlock("reflection");
    source.connectTo(block.offset);
    const out = { x: -1, y: -1 };
    return offsetReach(block.offset, out) ? out : null;
  };

  it("reads value inputs on every ask, so a parameter edit moves the bound", () => {
    const offset = value("offset", new Vector2(0.1, -0.2));
    const block = new MirrorReflectionBlock("reflection");
    offset.output.connectTo(block.offset);
    const out = { x: 0, y: 0 };
    expect(offsetReach(block.offset, out)).toBe(true);
    expect(out.x).toBeCloseTo(0.1 * 1.001 + 1e-4, 9);
    expect(out.y).toBeCloseTo(0.2 * 1.001 + 1e-4, 9);
    offset.value = new Vector2(0.5, 0);
    expect(offsetReach(block.offset, out)).toBe(true);
    expect(out.x).toBeCloseTo(0.5 * 1.001 + 1e-4, 9);
    offset.value = new Vector2(Number.NaN, 0);
    expect(offsetReach(block.offset, out)).toBe(false);
  });

  it("each operation block takes its rule", () => {
    const pair = (Block: typeof AddBlock | typeof SubtractBlock | typeof MultiplyBlock | typeof MinBlock | typeof MaxBlock, a: number, b: number) => {
      const block = new Block("op");
      value("a", a).output.connectTo(block.left);
      value("b", b).output.connectTo(block.right);
      return boundOutput(block.output);
    };
    expect(pair(AddBlock, 1, 2)).toEqual({ lo: [3], hi: [3] });
    expect(pair(SubtractBlock, 1, 2)).toEqual({ lo: [-1], hi: [-1] });
    expect(pair(MultiplyBlock, -3, 2)).toEqual({ lo: [-6], hi: [-6] });
    expect(pair(MinBlock, -3, 2)).toEqual({ lo: [-3], hi: [-3] });
    expect(pair(MaxBlock, -3, 2)).toEqual({ lo: [2], hi: [2] });
    const scale = new ScaleBlock("scale");
    value("v", new Vector2(1, -2)).output.connectTo(scale.input);
    value("f", 3).output.connectTo(scale.factor);
    expect(boundOutput(scale.output)).toEqual({ lo: [3, -6], hi: [3, -6] });
    const negateBlock = new NegateBlock("negate");
    value("v", 2).output.connectTo(negateBlock.value);
    expect(boundOutput(negateBlock.output)).toEqual({ lo: [-2], hi: [-2] });
    const oneMinusBlock = new OneMinusBlock("oneMinus");
    value("v", 0.25).output.connectTo(oneMinusBlock.input);
    expect(boundOutput(oneMinusBlock.output)).toEqual({ lo: [0.75], hi: [0.75] });
    const time = new GameTimeInputBlock("time");
    const clampBlock = new ClampBlock("saturate");
    time.output.connectTo(clampBlock.value);
    expect(boundOutput(clampBlock.output)).toEqual({ lo: [0], hi: [1] });
    const lerpBlock = new LerpBlock("lerp");
    value("a", 1).output.connectTo(lerpBlock.left);
    value("b", 3).output.connectTo(lerpBlock.right);
    clampBlock.output.connectTo(lerpBlock.gradient);
    expect(boundOutput(lerpBlock.output)).toEqual({ lo: [1], hi: [3] });
    const trig = (operation: TrigonometryBlockOperations, source: NodeMaterialConnectionPoint) => {
      const block = new TrigonometryBlock("trig");
      block.operation = operation;
      source.connectTo(block.input);
      return boundOutput(block.output);
    };
    expect(trig(TrigonometryBlockOperations.Sin, new GameTimeInputBlock("t").output)).toEqual({ lo: [-1], hi: [1] });
    expect(trig(TrigonometryBlockOperations.Cos, new GameTimeInputBlock("t").output)).toEqual({ lo: [-1], hi: [1] });
    expect(trig(TrigonometryBlockOperations.Abs, value("v", -2).output)).toEqual({ lo: [2], hi: [2] });
    // A rule-less operation of the same block.
    expect(trig(TrigonometryBlockOperations.Tan, value("v", 0.5).output)).toBeNull();
  });

  it("follows vector merges and splits, with their swizzles", () => {
    const merge = new VectorMergerBlock("merge");
    value("x", 1).output.connectTo(merge.x);
    value("y", 2).output.connectTo(merge.y);
    expect(boundOutput(merge.xyOut)).toEqual({ lo: [1, 2], hi: [1, 2] });
    expect(boundOutput(merge.xyzw)).toEqual({ lo: [1, 2, 0, 0], hi: [1, 2, 0, 0] });
    merge.xSwizzle = "y"; merge.ySwizzle = "x";
    expect(boundOutput(merge.xyOut)).toEqual({ lo: [2, 1], hi: [2, 1] });
    const split = new VectorSplitterBlock("split");
    value("v", new Vector3(4, 5, 6)).output.connectTo(split.xyzIn);
    expect(boundOutput(split.y)).toEqual({ lo: [5], hi: [5] });
    expect(boundOutput(split.xyOut)).toEqual({ lo: [4, 5], hi: [4, 5] });
    // Split's zw exists only for a four-component source.
    expect(boundOutput(split.zw)).toBeNull();
  });

  it("refuses a block with no rule, and an Offset that is unbounded", () => {
    const divide = new DivideBlock("divide");
    value("a", 1).output.connectTo(divide.left);
    value("b", 2).output.connectTo(divide.right);
    const merge = new VectorMergerBlock("merge");
    divide.output.connectTo(merge.x);
    expect(reachOf(merge.xyOut)).toBeNull();
    const timed = new VectorMergerBlock("timed");
    new GameTimeInputBlock("time").output.connectTo(timed.x);
    expect(reachOf(timed.xyOut)).toBeNull();
    const uv = new InputBlock("uv", undefined, Types.Vector2);
    uv.setAsAttribute("uv");
    expect(reachOf(uv.output)).toBeNull();
  });
});
