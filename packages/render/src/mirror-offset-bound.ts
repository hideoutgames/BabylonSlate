/**
 * A conservative bound on what drives a Mirror Reflection node's Offset, for the Mirror pass's footprint crop
 * (`mirrors.ts`): interval arithmetic, per component, over the compiled Babylon blocks behind the node's Offset input.
 *
 * It reads the compiled blocks rather than the Material plan because they are what the shader runs: a value input's
 * InputBlock holds the value the next draw binds (a parameter edit writes it in place), so the bound asked on a render
 * is the bound of what that render's draws sample. Only blocks with a rule below take part; any other block, a value
 * that is not finite, or an Offset whose bound is not finite gives null, and the pass culls without the crop.
 *
 * Values from attributes (directly or through the surface plumbing's morph targets), system values and animated inputs
 * (time) are finite but unbounded: they take part only
 * through a rule whose output is bounded whatever its finite argument is (sine, cosine, Simplex Perlin noise). The
 * graph's own values are assumed not to overflow single precision.
 */
import { AddBlock } from "@babylonjs/core/Materials/Node/Blocks/addBlock";
import { ClampBlock } from "@babylonjs/core/Materials/Node/Blocks/clampBlock";
import { InputBlock } from "@babylonjs/core/Materials/Node/Blocks/Input/inputBlock";
import { AnimatedInputBlockTypes } from "@babylonjs/core/Materials/Node/Blocks/Input/animatedInputBlockTypes";
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
import { MorphTargetsBlock } from "@babylonjs/core/Materials/Node/Blocks/Vertex/morphTargetsBlock";
import { NodeMaterialBlockConnectionPointTypes as Types } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockConnectionPointTypes";
import type { NodeMaterialConnectionPoint } from "@babylonjs/core/Materials/Node/nodeMaterialBlockConnectionPoint";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";

/** A value's range per component: `lo[i] <= value[i] <= hi[i]`; ±Infinity where a component is unbounded. */
export type Interval = { readonly lo: readonly number[]; readonly hi: readonly number[] };

/**
 * |SimplexPerlin3D(p)| for any finite p. Babylon's function (`SimplexPerlin3DBlock`) sums four corner terms
 * `w³ (ĝ·xᵢ) N`, with ĝ a unit gradient (`inversesqrt(h·h) * h`), w = max(0.5 − |xᵢ|², 0), N = 37.837227241611316 (the
 * shader's FINAL_NORMALIZATION) and xᵢ = x0 − cᵢ: the corners cᵢ are 0, Pi₁ − 1/6, Pi₂ − 1/3 and ½, where Pi₁ and Pi₂
 * follow from g = step(x0.yzx, x0.xyz) alone. So |n| ≤ N · Σ f(|x0 − cᵢ|) with f(r) = r · max(0.5 − r², 0)³, whatever
 * x0 is (rounding included), for the g the shader computed. Bounded over every x0, per g (`mirror-offset-bound.test.ts`
 * proves it by branch and bound, with |f′| ≤ 0.125 bounding the sum inside each cube): g = 000 cannot occur
 * (x < y < z < x); g = 111 only when x0's three components are equal, on the diagonal, where the sum stays below 0.0318,
 * so N · 0.0318 = 1.2032; every other g stays under the bound too. The function itself stays near ±1.
 */
export const SIMPLEX_PERLIN_3D_BOUND = 1.21;
/** Relative and absolute slack on every bound against single-precision and GPU transcendental error. */
const RELATIVE_MARGIN = 1e-3;
const ABSOLUTE_MARGIN = 1e-4;
/** Deeper chains than this are not followed (null). */
const MAX_DEPTH = 64;

const UNKNOWN = null;

function constant(values: readonly number[]): Interval | null {
  for (const value of values) if (!Number.isFinite(value)) return UNKNOWN;
  return { lo: values, hi: values };
}

function unbounded(count: number): Interval {
  return { lo: new Array<number>(count).fill(-Infinity), hi: new Array<number>(count).fill(Infinity) };
}

function uniform(count: number, lo: number, hi: number): Interval {
  return { lo: new Array<number>(count).fill(lo), hi: new Array<number>(count).fill(hi) };
}

/** A sum or difference that meets ±Infinity of both signs is unbounded. */
function finiteOr(value: number, fallback: number): number {
  return Number.isNaN(value) ? fallback : value;
}

/** Componentwise `f` over two operands, a single component broadcast as GLSL does; null on other width mismatches. */
function pair(a: Interval, b: Interval, f: (alo: number, ahi: number, blo: number, bhi: number) => [number, number]): Interval | null {
  const width = a.lo.length === b.lo.length || b.lo.length === 1 ? a.lo.length : a.lo.length === 1 ? b.lo.length : -1;
  if (width < 0) return UNKNOWN;
  const lo: number[] = [], hi: number[] = [];
  for (let i = 0; i < width; i++) {
    const ai = a.lo.length === 1 ? 0 : i, bi = b.lo.length === 1 ? 0 : i;
    const [l, h] = f(a.lo[ai]!, a.hi[ai]!, b.lo[bi]!, b.hi[bi]!);
    lo.push(l); hi.push(h);
  }
  return { lo, hi };
}

function map(a: Interval, f: (lo: number, hi: number) => [number, number]): Interval {
  const lo: number[] = [], hi: number[] = [];
  for (let i = 0; i < a.lo.length; i++) {
    const [l, h] = f(a.lo[i]!, a.hi[i]!);
    lo.push(l); hi.push(h);
  }
  return { lo, hi };
}

/** x·y with 0·∞ = 0: every value is finite, so a factor that is exactly 0 makes the product 0. */
function product(x: number, y: number): number {
  return x === 0 || y === 0 ? 0 : x * y;
}

export const add = (a: Interval, b: Interval) =>
  pair(a, b, (alo, ahi, blo, bhi) => [finiteOr(alo + blo, -Infinity), finiteOr(ahi + bhi, Infinity)]);
export const subtract = (a: Interval, b: Interval) =>
  pair(a, b, (alo, ahi, blo, bhi) => [finiteOr(alo - bhi, -Infinity), finiteOr(ahi - blo, Infinity)]);
export const multiply = (a: Interval, b: Interval) => pair(a, b, (alo, ahi, blo, bhi) => {
  const p = [product(alo, blo), product(alo, bhi), product(ahi, blo), product(ahi, bhi)];
  return [Math.min(...p), Math.max(...p)];
});
export const minimum = (a: Interval, b: Interval) => pair(a, b, (alo, ahi, blo, bhi) => [Math.min(alo, blo), Math.min(ahi, bhi)]);
export const maximum = (a: Interval, b: Interval) => pair(a, b, (alo, ahi, blo, bhi) => [Math.max(alo, blo), Math.max(ahi, bhi)]);
export const negate = (a: Interval) => map(a, (lo, hi) => [-hi, -lo]);
export const oneMinus = (a: Interval) => map(a, (lo, hi) => [1 - hi, 1 - lo]);
export const absolute = (a: Interval) =>
  map(a, (lo, hi) => (lo >= 0 ? [lo, hi] : hi <= 0 ? [-hi, -lo] : [0, Math.max(-lo, hi)]));
/** clamp(x, min, max) for min <= max (GLSL leaves min > max undefined: null). */
export function clamp(a: Interval, min: number, max: number): Interval | null {
  if (!(Number.isFinite(min) && Number.isFinite(max) && min <= max)) return UNKNOWN;
  return map(a, (lo, hi) => [Math.min(Math.max(lo, min), max), Math.min(Math.max(hi, min), max)]);
}
/** mix(a, b, t) = a + (b − a)·t; a factor that is not bounded leaves the result unbounded. */
export function lerp(a: Interval, b: Interval, t: Interval): Interval | null {
  const span = subtract(b, a);
  const scaled = span && multiply(span, t);
  return scaled && add(a, scaled);
}
/** sin or cos of any finite argument. */
export const periodic = (a: Interval) => uniform(a.lo.length, -1, 1);

const AXES = "xyzw";

/** The bound on what `point` (an output) carries, or null when no rule covers it. */
function output(point: NodeMaterialConnectionPoint, memo: Map<NodeMaterialConnectionPoint, Interval | null>, depth: number): Interval | null {
  if (memo.has(point)) return memo.get(point)!;
  memo.set(point, UNKNOWN);
  const result = depth > MAX_DEPTH ? UNKNOWN : evaluate(point, memo, depth + 1);
  memo.set(point, result);
  return result;
}

/** What an input of a block receives; null when it is not connected or not covered. */
function input(point: NodeMaterialConnectionPoint, memo: Map<NodeMaterialConnectionPoint, Interval | null>, depth: number): Interval | null {
  const source = point.connectedPoint;
  return source ? output(source, memo, depth) : UNKNOWN;
}

function inputValue(block: InputBlock): Interval | null {
  if (block.isAttribute || block.isSystemValue || block.animationType !== AnimatedInputBlockTypes.None) {
    const width = widthOf(block.output);
    return width ? unbounded(width) : UNKNOWN;
  }
  const value: unknown = block.value;
  let components: number[];
  if (typeof value === "number") components = [value];
  else if (value instanceof Vector2) components = [value.x, value.y];
  else if (value instanceof Vector3) components = [value.x, value.y, value.z];
  else if (value instanceof Vector4) components = [value.x, value.y, value.z, value.w];
  else if (value instanceof Color3) components = [value.r, value.g, value.b];
  else if (value instanceof Color4) components = [value.r, value.g, value.b, value.a];
  else return UNKNOWN;
  const exact = constant(components);
  if (!exact || !block.convertToLinearSpace) return exact;
  // A colour converted to linear space binds its linear value: the hull of both holds it.
  const linear = (value instanceof Color4 ? value.toLinearSpace() : value instanceof Color3 ? value.toLinearSpace() : null);
  if (!linear) return UNKNOWN;
  const converted = constant(linear instanceof Color4 ? [linear.r, linear.g, linear.b, linear.a] : [linear.r, linear.g, linear.b]);
  return converted && { lo: exact.lo.map((v, i) => Math.min(v, converted.lo[i]!)), hi: exact.hi.map((v, i) => Math.max(v, converted.hi[i]!)) };
}

/** Components a typed connection point carries (0 when its type is not a plain scalar or vector). */
function widthOf(point: NodeMaterialConnectionPoint): number {
  switch (point.type) {
    case Types.Float: return 1;
    case Types.Vector2: return 2;
    case Types.Vector3: case Types.Color3: return 3;
    case Types.Vector4: case Types.Color4: return 4;
    default: return 0;
  }
}

function pick(value: Interval, axes: string): Interval | null {
  const lo: number[] = [], hi: number[] = [];
  for (const axis of axes) {
    const index = AXES.indexOf(axis);
    if (index < 0 || index >= value.lo.length) return UNKNOWN;
    lo.push(value.lo[index]!); hi.push(value.hi[index]!);
  }
  return { lo, hi };
}

function concat(...parts: (Interval | null)[]): Interval | null {
  const lo: number[] = [], hi: number[] = [];
  for (const part of parts) {
    if (!part) return UNKNOWN;
    lo.push(...part.lo); hi.push(...part.hi);
  }
  return { lo, hi };
}

/** An exact width, or null. */
function sized(value: Interval | null, width: number): Interval | null {
  return value && value.lo.length === width ? value : UNKNOWN;
}

const ZERO: Interval = { lo: [0], hi: [0] };

function evaluate(point: NodeMaterialConnectionPoint, memo: Map<NodeMaterialConnectionPoint, Interval | null>, depth: number): Interval | null {
  const block = point.ownerBlock;
  const read = (target: NodeMaterialConnectionPoint) => input(target, memo, depth);
  if (block instanceof InputBlock) return inputValue(block);
  if (block instanceof MorphTargetsBlock) {
    // A mesh's attributes plus its morph targets' weighted deltas (the surface plumbing's UV and position): finite, unbounded.
    const width = widthOf(point);
    return width ? unbounded(width) : UNKNOWN;
  }
  if (block instanceof AddBlock || block instanceof SubtractBlock || block instanceof MultiplyBlock ||
    block instanceof MinBlock || block instanceof MaxBlock) {
    const left = read(block.left), right = read(block.right);
    if (!left || !right) return UNKNOWN;
    if (block instanceof AddBlock) return add(left, right);
    if (block instanceof SubtractBlock) return subtract(left, right);
    if (block instanceof MultiplyBlock) return multiply(left, right);
    return block instanceof MinBlock ? minimum(left, right) : maximum(left, right);
  }
  if (block instanceof ScaleBlock) {
    const value = read(block.input), factor = sized(read(block.factor), 1);
    return value && factor && multiply(value, factor);
  }
  if (block instanceof NegateBlock) {
    const value = read(block.value);
    return value && negate(value);
  }
  if (block instanceof OneMinusBlock) {
    const value = read(block.input);
    return value && oneMinus(value);
  }
  if (block instanceof ClampBlock) {
    const value = read(block.value);
    return value && clamp(value, block.minimum, block.maximum);
  }
  if (block instanceof LerpBlock) {
    const a = read(block.left), b = read(block.right), t = read(block.gradient);
    return a && b && t && lerp(a, b, t);
  }
  if (block instanceof TrigonometryBlock) {
    const value = read(block.input);
    if (!value) return UNKNOWN;
    if (block.operation === TrigonometryBlockOperations.Sin || block.operation === TrigonometryBlockOperations.Cos) return periodic(value);
    if (block.operation === TrigonometryBlockOperations.Abs) return absolute(value);
    return UNKNOWN;
  }
  if (block instanceof SimplexPerlin3DBlock) {
    // The argument only has to be one the rules cover (finite); its range does not matter.
    if (!sized(read(block.seed), 3)) return UNKNOWN;
    return uniform(1, -SIMPLEX_PERLIN_3D_BOUND, SIMPLEX_PERLIN_3D_BOUND);
  }
  if (block instanceof VectorMergerBlock) return merged(block, point, read);
  if (block instanceof VectorSplitterBlock) return split(block, point, read);
  return UNKNOWN;
}

/** Babylon's VectorMergerBlock build, per output: the value it assembles, then the block's swizzle. */
function merged(block: VectorMergerBlock, point: NodeMaterialConnectionPoint, read: (point: NodeMaterialConnectionPoint) => Interval | null): Interval | null {
  const scalar = (target: NodeMaterialConnectionPoint) => (target.isConnected ? sized(read(target), 1) : ZERO);
  const width = point === block.xyzw ? 4 : point === block.xyzOut ? 3 : point === block.xyOut || point === block.zwOut ? 2 : 0;
  if (!width) return UNKNOWN;
  let base: Interval | null;
  if (block.xyzwIn.isConnected) {
    if (point === block.zwOut) return UNKNOWN;
    base = sized(read(block.xyzwIn), 4);
  } else if (block.xyzIn.isConnected) {
    if (point === block.zwOut) return UNKNOWN;
    const xyz = sized(read(block.xyzIn), 3);
    base = point === block.xyzw ? concat(xyz, scalar(block.w)) : xyz;
  } else {
    const zw = () => (block.zwIn.isConnected ? sized(read(block.zwIn), 2) : concat(scalar(block.z), scalar(block.w)));
    const xy = block.xyIn.isConnected ? sized(read(block.xyIn), 2) : concat(scalar(block.x), scalar(block.y));
    if (point === block.zwOut) base = zw();
    else if (point === block.xyzw) base = concat(xy, zw());
    else if (point === block.xyzOut) base = concat(xy, scalar(block.z));
    else base = xy;
  }
  const swizzle = (block.xSwizzle + block.ySwizzle + block.zSwizzle + block.wSwizzle).substring(0, width);
  return base && pick(base, swizzle);
}

/** Babylon's VectorSplitterBlock build: the first connected of xyzw, xyz and xy feeds every output. */
function split(block: VectorSplitterBlock, point: NodeMaterialConnectionPoint, read: (point: NodeMaterialConnectionPoint) => Interval | null): Interval | null {
  const source = block.xyzw.isConnected ? sized(read(block.xyzw), 4) : block.xyzIn.isConnected ? sized(read(block.xyzIn), 3)
    : block.xyIn.isConnected ? sized(read(block.xyIn), 2) : UNKNOWN;
  if (!source) return UNKNOWN;
  if (point === block.xyzOut) return source.lo.length === 2 ? concat(source, ZERO) : pick(source, "xyz");
  if (point === block.xyOut) return pick(source, "xy");
  if (point === block.zw) return block.xyzw.isConnected ? pick(source, "zw") : UNKNOWN;
  const axis = point === block.x ? "x" : point === block.y ? "y" : point === block.z ? "z" : point === block.w ? "w" : "";
  return axis ? pick(source, axis) : UNKNOWN;
}

/** The bound on what `point` (a block's output) carries; null when a block behind it has no rule. */
export function boundOutput(point: NodeMaterialConnectionPoint): Interval | null {
  return output(point, new Map(), 0);
}

/**
 * How far, in texture units per axis, an Offset input reaches from zero, widened by the margins: written into `out`.
 * False (leaving `out` unwritten) when it cannot be bounded. An unconnected Offset reaches nowhere.
 */
export function offsetReach(offset: NodeMaterialConnectionPoint, out: { x: number; y: number }): boolean {
  const source = offset.connectedPoint;
  if (!source) { out.x = out.y = 0; return true; }
  const bound = boundOutput(source);
  if (!bound || (bound.lo.length !== 2 && bound.lo.length !== 1)) return false;
  const x = Math.max(Math.abs(bound.lo[0]!), Math.abs(bound.hi[0]!));
  const y = Math.max(Math.abs(bound.lo.at(-1)!), Math.abs(bound.hi.at(-1)!));
  if (!(Number.isFinite(x) && Number.isFinite(y))) return false;
  out.x = x * (1 + RELATIVE_MARGIN) + ABSOLUTE_MARGIN;
  out.y = y * (1 + RELATIVE_MARGIN) + ABSOLUTE_MARGIN;
  return true;
}
