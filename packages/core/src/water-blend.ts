import type { Transform, Vec3 } from "./math-rng";
import { inverseQuat, quatRotateVector, type QuatObject } from "./euler";
import {
  createWaterWaveOutput, emptyWaterSample, evaluateWaterWaves, invertWaterWaves, sampleWaterSurface, waterBankDistance, waterBankFadeLength, waterBankGain,
  waterEulerianGradient, waterHorizontalEnvelope, waterRestBase, waterRiverCentreline, waterWaveDrift, waterWaveQ, waterWaveSet,
  type WaterBodyProperties, type WaterDefinition, type WaterKind, type WaterSample, type WaterWaveGain,
} from "./water";

/**
 * Rest-height difference (metres) up to which neighbours blend fully; they stop blending at twice it, so a river above
 * a waterfall never pulls toward the lake below.
 */
export const waterBlendVerticalTolerance = (distance: number) => Math.max(0.25, distance / 4);

/**
 * Bodies lie over the classes below them: Global Water Volume 0, Ocean 1, Lake 2, River 3, Puddle 4. Inside a higher
 * body the lower one gives way, so a river keeps its current into a lake and a lake keeps its colour inside an ocean.
 */
export function waterBlendClass(kind: WaterKind): number {
  switch (kind) {
    case "global": return 0;
    case "ocean": return 1;
    case "lake": return 2;
    case "river": return 3;
    default: return 4;
  }
}

/** Whether two definitions make the same swell (physics and the vertex waves): every analytic wave field matches. */
export function sameWaterWaves(a: WaterDefinition, b: WaterDefinition): boolean {
  return a === b || (a.waveModel === b.waveModel && a.waveHeight === b.waveHeight && a.waveLength === b.waveLength
    && a.waveSpeed === b.waveSpeed && a.waveDirection === b.waveDirection && a.waveSpread === b.waveSpread
    && a.choppiness === b.choppiness && a.steepness === b.steepness && a.peakSharpness === b.peakSharpness && a.waveSeed === b.waveSeed);
}

/** Whether two definitions colour water alike (Shallow, Deep and Foam Color and Opacity). */
export function sameWaterColors(a: WaterDefinition, b: WaterDefinition): boolean {
  const same = (x: readonly number[], y: readonly number[]) => x[0] === y[0] && x[1] === y[1] && x[2] === y[2];
  return a === b || (same(a.shallowColor, b.shallowColor) && same(a.deepColor, b.deepColor) && same(a.foamColor, b.foamColor) && a.opacity === b.opacity);
}

/** One enabled water body as blending sees it. `revision` changes whenever the caller edits `body` or `definition` in place. */
export interface WaterBlendBody {
  definition: WaterDefinition;
  body: WaterBodyProperties;
  transform: Transform;
  revision?: number;
}

/** A body's blending inputs, derived once per `WaterBlendIndex.update` that changes anything. */
export interface PreparedWaterBlendBody {
  readonly definition: WaterDefinition;
  readonly body: WaterBodyProperties;
  readonly transform: Transform;
  readonly inverse: QuatObject;
  /** World up in scaled local coordinates; null for a degenerate or edge-on volume (it never blends). */
  readonly ray: Vec3 | null;
  readonly blendClass: number;
  /** World bounds of the rest surface: min X, max X, min Y, max Y, min Z, max Z (infinite for open water). */
  readonly bounds: Float64Array;
  /**
   * Wave Scale the body's own waves are evaluated at when blending: its Wave Scale, or 1 when that is 0, so a calm
   * body can still take a neighbour's waves (`heightScale` and `offsetScale` are relative to it).
   */
  readonly referenceScale: number;
  /** Wave Scale and the Gerstner factor times it, q(s)·s: what blending averages across bodies with the same swell. */
  readonly scale: number;
  readonly offsetAmount: number;
  /** q·s at `referenceScale`; 0 without Gerstner. */
  readonly referenceOffset: number;
  /** Bank fade length at `referenceScale` (0 for Global Water Volume, which has no banks). */
  readonly fadeLength: number;
  /** World Depth (Depth × |scale.y|). */
  readonly depth: number;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Smooth maximum with blend radius `k`: max(a, b) plus up to k/4 where a and b are within k of each other. */
export function waterSmoothMax(a: number, b: number, k: number): number {
  if (a === Infinity || b === Infinity) return Infinity;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k / 4;
}

function prepare(source: WaterBlendBody): PreparedWaterBlendBody {
  const { definition, body, transform } = source;
  const { x: sx, y: sy, z: sz } = transform.scale;
  const inverse = inverseQuat(transform.rotation);
  let ray: Vec3 | null = null;
  if (Math.min(Math.abs(sx), Math.abs(sy), Math.abs(sz)) >= 1e-6) {
    const up = quatRotateVector(inverse, { x: 0, y: 1, z: 0 });
    if (Math.abs(up.y / sy) >= 1e-6) ray = { x: up.x / sx, y: up.y / sy, z: up.z / sz };
  }
  const set = waterWaveSet(definition), scale = body.waveScale, referenceScale = Math.abs(scale) > 1e-6 ? scale : 1;
  return {
    definition, body, transform, inverse, ray, blendClass: waterBlendClass(body.kind), bounds: blendBounds(body, transform),
    referenceScale, scale, offsetAmount: waterWaveQ(set, scale) * scale, referenceOffset: waterWaveQ(set, referenceScale) * referenceScale,
    fadeLength: body.kind === "global" ? 0 : waterBankFadeLength(definition, referenceScale),
    depth: body.depth * Math.abs(sy),
  };
}

/** World bounds of a body's rest surface (`PreparedWaterBlendBody.bounds`). */
function blendBounds(body: WaterBodyProperties, transform: Transform): Float64Array {
  const out = new Float64Array([Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity]);
  const { position, rotation, scale } = transform;
  const corner = (x: number, y: number, z: number) => {
    const p = quatRotateVector(rotation, { x: x * scale.x, y: y * scale.y, z: z * scale.z });
    out[0] = Math.min(out[0]!, position.x + p.x); out[1] = Math.max(out[1]!, position.x + p.x);
    out[2] = Math.min(out[2]!, position.y + p.y); out[3] = Math.max(out[3]!, position.y + p.y);
    out[4] = Math.min(out[4]!, position.z + p.z); out[5] = Math.max(out[5]!, position.z + p.z);
  };
  if (body.kind === "global") {
    // The plane is level only while the volume is: then it has one height, otherwise any.
    const up = quatRotateVector(rotation, { x: 0, y: 1, z: 0 }), level = Math.abs(up.x) < 1e-9 && Math.abs(up.z) < 1e-9;
    out.set([-Infinity, Infinity, level ? position.y : -Infinity, level ? position.y : Infinity, -Infinity, Infinity]);
    return out;
  }
  let minX = -body.width / 2, maxX = body.width / 2, minZ = -body.length / 2, maxZ = body.length / 2, minY = 0, maxY = 0;
  if (body.kind === "river") {
    minX = minZ = minY = Infinity; maxX = maxZ = maxY = -Infinity;
    for (const p of waterRiverCentreline(body)) {
      minX = Math.min(minX, p.x - p.halfWidth); maxX = Math.max(maxX, p.x + p.halfWidth);
      minZ = Math.min(minZ, p.z - p.halfWidth); maxZ = Math.max(maxZ, p.z + p.halfWidth);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
  }
  for (const x of [minX, maxX]) for (const y of [minY, maxY]) for (const z of [minZ, maxZ]) corner(x, y, z);
  return out;
}

/** Horizontal gap between two bounds (0 when they overlap in X/Z). */
function boundsGap(a: Float64Array, b: Float64Array): number {
  const gx = Math.max(0, a[0]! - b[1]!, b[0]! - a[1]!), gz = Math.max(0, a[4]! - b[5]!, b[4]! - a[5]!);
  return Math.hypot(gx, gz);
}

/**
 * The bodies of one world and, per body, the others it blends with: those whose rest surfaces come within the Water
 * Blend Distance horizontally and within twice the vertical tolerance in height. `update` compares its inputs (body and
 * definition identity, each caller revision and transform value, the distance) and rebuilds only when one changed, so
 * per-tick callers pay a comparison, never discovery. Discovery sweeps the bounds sorted along X: open water (infinite
 * bounds) pairs with every vertically compatible body.
 */
export class WaterBlendIndex {
  distance = 0;
  /** Increments with every rebuild. */
  revision = 0;
  bodies: PreparedWaterBlendBody[] = [];
  private lists: number[][] = [];
  /** The previous rebuild's lists (reused as scratch), so a rebuild can tell whether any neighbourhood changed. */
  private spareLists: number[][] = [];
  private keys: unknown[] = [];
  private scratchKeys: unknown[] = [];
  /** Per body: same swell and same colours as each of its neighbours, aligned with `neighbours`. */
  private sameWaves: boolean[][] = [];
  private sameColors: boolean[][] = [];
  /** Per-participant scratch for `evaluateWaterBlend`, sized to the largest neighbour list plus one. */
  scratch = createParticipants(1);

  /**
   * Rebuilds when anything changed; returns whether it did. When only poses changed (the same bodies, definitions,
   * revisions and distance: a body moving every tick), only the moved bodies are prepared again, the neighbour lists
   * are rediscovered in place and the per-neighbour swell and colour matches are recomputed only where a list changed,
   * so a moving body allocates nothing beyond its own prepared inputs.
   */
  update(sources: readonly WaterBlendBody[], distance: number): boolean {
    const keys = this.scratchKeys, previous = this.keys;
    keys.length = 0;
    keys.push(distance, sources.length);
    for (const s of sources) {
      const t = s.transform;
      keys.push(s.body, s.definition, s.revision ?? 0, t.position.x, t.position.y, t.position.z, t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w, t.scale.x, t.scale.y, t.scale.z);
    }
    if (keys.length === previous.length && keys.every((key, i) => Object.is(key, previous[i]))) return false;
    // Only poses moved: every per-body identity (body, definition, revision; slots 0-2 of each 13) matches.
    let posesOnly = keys.length === previous.length && Object.is(keys[0], previous[0]);
    for (let i = 0; posesOnly && i < sources.length; i++) {
      const o = 2 + i * 13;
      posesOnly = keys[o] === previous[o] && keys[o + 1] === previous[o + 1] && keys[o + 2] === previous[o + 2];
    }
    this.keys = keys; this.scratchKeys = previous;
    this.distance = distance;
    this.revision++;
    if (posesOnly) {
      for (let i = 0; i < sources.length; i++) {
        const o = 2 + i * 13;
        for (let k = 3; k < 13; k++) if (!Object.is(keys[o + k], previous[o + k])) { this.bodies[i] = prepare(sources[i]!); break; }
      }
    } else {
      this.bodies = sources.map(prepare);
    }
    // Rediscover into the spare lists, then keep the old matches wherever a neighbourhood stayed the same.
    const old = this.lists, lists = this.spareLists;
    lists.length = this.bodies.length;
    for (let i = 0; i < lists.length; i++) { const list = lists[i]; if (list) list.length = 0; else lists[i] = []; }
    this.lists = lists; this.spareLists = old;
    if (distance > 0) this.discover();
    if (!posesOnly) { this.sameWaves = []; this.sameColors = []; }
    let largest = 1;
    for (let i = 0; i < lists.length; i++) {
      const list = lists[i]!, before = posesOnly ? old[i] : undefined;
      largest = Math.max(largest, list.length + 1);
      if (before && before.length === list.length && before.every((j, n) => j === list[n])) continue;
      this.sameWaves[i] = list.map((j) => sameWaterWaves(this.bodies[i]!.definition, this.bodies[j]!.definition));
      this.sameColors[i] = list.map((j) => sameWaterColors(this.bodies[i]!.definition, this.bodies[j]!.definition));
    }
    if (this.scratch.index.length < largest) this.scratch = createParticipants(largest);
    return true;
  }

  private readonly openScratch: number[] = [];
  private readonly finiteScratch: number[] = [];

  /** Indices of the bodies `index` blends with, ascending. */
  neighbours(index: number): readonly number[] { return this.lists[index] ?? []; }
  /** Whether `index`'s n-th neighbour has the same swell / the same colours. */
  wavesMatch(index: number, n: number): boolean { return this.sameWaves[index]?.[n] ?? false; }
  colorsMatch(index: number, n: number): boolean { return this.sameColors[index]?.[n] ?? false; }

  private discover(): void {
    const { bodies, lists, distance } = this;
    const open = this.openScratch, finite = this.finiteScratch;
    open.length = finite.length = 0;
    const vertical = 2 * waterBlendVerticalTolerance(distance);
    const pair = (i: number, j: number) => {
      const a = bodies[i]!, b = bodies[j]!;
      if (!a.ray || !b.ray) return;
      if (boundsGap(a.bounds, b.bounds) > distance) return;
      if (Math.max(a.bounds[2]! - b.bounds[3]!, b.bounds[2]! - a.bounds[3]!) > vertical) return;
      lists[i]!.push(j); lists[j]!.push(i);
    };
    for (let i = 0; i < bodies.length; i++) (Number.isFinite(bodies[i]!.bounds[0]!) ? finite : open).push(i);
    // Open water pairs with everything (its bounds are infinite).
    for (let a = 0; a < open.length; a++) {
      for (let b = a + 1; b < open.length; b++) pair(open[a]!, open[b]!);
      for (const j of finite) pair(open[a]!, j);
    }
    finite.sort(this.byMinX);
    for (let a = 0; a < finite.length; a++) {
      const i = finite[a]!, reach = bodies[i]!.bounds[1]! + distance;
      for (let b = a + 1; b < finite.length && bodies[finite[b]!]!.bounds[0]! <= reach; b++) pair(i, finite[b]!);
    }
    for (const list of lists) list.sort(ascending);
  }

  private readonly byMinX = (a: number, b: number) => this.bodies[a]!.bounds[0]! - this.bodies[b]!.bounds[0]!;
}

const ascending = (a: number, b: number) => a - b;

/** Per-participant scratch: body index, signed edge distance, rest height, weight terms and current. */
function createParticipants(size: number) {
  return {
    index: new Int32Array(size), edge: new Float64Array(size), height: new Float64Array(size), phi: new Float64Array(size),
    vertical: new Float64Array(size), weight: new Float64Array(size), flowX: new Float64Array(size), flowY: new Float64Array(size),
    flowZ: new Float64Array(size), waves: new Uint8Array(size), colors: new Uint8Array(size),
  };
}

/** The blended surface at one rest point, as one body evaluates it (`evaluateWaterBlend`). */
export interface WaterBlendSample {
  /** The body has water here: its base is found and it lies within the blend reach of its own footprint. */
  found: boolean;
  /**
   * World metres inside the blended shoreline (negative outside): the smooth union of every participant's bank
   * distance, so edges that face another body are no shore, and gaps narrower than the Blend Distance fill.
   */
  union: number;
  /** This body's share of the blended surface (shares sum to 1). */
  weight: number;
  /** This body's share less the largest other share: positive where this body draws and answers queries. */
  margin: number;
  /** World rest heights: the blended surface's and this body's own. */
  restHeight: number;
  ownRestHeight: number;
  /** Swell height and Gerstner offset relative to this body's waves at its `referenceScale`. */
  heightScale: number;
  offsetScale: number;
  /** Share of participants coloured differently from this body, and the strongest of them (-1 when none). */
  foreign: number;
  partner: number;
  /** Blended current (world metres per second). */
  flowX: number;
  flowY: number;
  flowZ: number;
  /** Blended world Depth. */
  depth: number;
  /** Other bodies with a share here. */
  others: number;
}

export const createWaterBlendSample = (): WaterBlendSample => ({
  found: false, union: 0, weight: 1, margin: 1, restHeight: 0, ownRestHeight: 0, heightScale: 1, offsetScale: 1, foreign: 0,
  partner: -1, flowX: 0, flowY: 0, flowZ: 0, depth: 0, others: 0,
});

/** World current of a body at a footprint, as `sampleWaterSurface` reports it. */
function bodyFlow(p: PreparedWaterBlendBody, flowX: number, flowY: number, flowZ: number, out: Float64Array): void {
  const { scale, rotation } = p.transform, speed = p.body.flowSpeed;
  const v = quatRotateVector(rotation, { x: flowX * speed * scale.x, y: flowY * speed * scale.y, z: flowZ * speed * scale.z });
  const length = Math.hypot(v.x, v.z), k = length > 1e-6 ? Math.abs(speed) / length : 1;
  out[0] = v.x * k; out[1] = v.y * k; out[2] = v.z * k;
}

const flowScratch = new Float64Array(3), gradientScratch = new Float64Array(2);

/** Records one participant of `evaluateWaterBlend` in the index's scratch; returns the new count. */
function addParticipant(
  index: WaterBlendIndex, count: number, i: number, edge: number, height: number, vertical: number,
  footprint: { flowX: number; flowY: number; flowZ: number }, waves: boolean, colors: boolean,
): number {
  const p = index.scratch, reach = index.distance / 2;
  p.index[count] = i; p.edge[count] = edge; p.height[count] = height; p.vertical[count] = vertical;
  p.phi[count] = index.distance > 0 ? smoothstep(-reach, reach, edge) * vertical : edge >= 0 ? 1 : 0;
  bodyFlow(index.bodies[i]!, footprint.flowX, footprint.flowY, footprint.flowZ, flowScratch);
  p.flowX[count] = flowScratch[0]!; p.flowY[count] = flowScratch[1]!; p.flowZ[count] = flowScratch[2]!;
  p.waves[count] = waves ? 1 : 0; p.colors[count] = colors ? 1 : 0;
  return count + 1;
}

/**
 * The blended water surface at world X/Z (`x`, `z`; `y` starts the rest-base search of tilted volumes) as body `index`
 * evaluates it. Every body within the Blend Distance R of the point (and within the vertical tolerance V of this body's
 * rest height) takes part:
 * - Coverage φ = smoothstep(−R/2, R/2, bank distance) × the vertical fade (1 → 0 between V and 2V), so a body reaches R/2
 *   beyond its footprint and blends over R across its edge.
 * - Shares: φ times (1 − φ) of every participant of a higher class (`waterBlendClass`), normalised to sum to 1.
 * - The union shoreline is the smooth maximum (radius 2R, in ascending body order) of the bank distances; a body leaving
 *   the blend (vertically, or over the outer half of its reach) fades out of it, so the shoreline never steps.
 * - Rest height, current and Depth average by share. The swell averages Wave Scale and q·s over the participants with
 *   the same swell; where other swells hold a share, both sides calm toward the seam (smoothstep(0.5, 1, same share)),
 *   so differing assets meet flat and continuous.
 * Writes `out` and returns `out.found`. Allocation-free apart from the shared rest-base helpers.
 */
export function evaluateWaterBlend(index: WaterBlendIndex, self: number, x: number, y: number, z: number, out: WaterBlendSample): boolean {
  const bodies = index.bodies, me = bodies[self]!, distance = index.distance;
  out.found = false;
  if (!me.ray) return false;
  const hit = waterRestBase(me.body, me.transform, me.inverse, me.ray, x, y, z);
  if (!hit) return false;
  const p = index.scratch, reach = distance / 2, tolerance = waterBlendVerticalTolerance(distance);
  const ownEdge = me.body.kind === "global" ? Infinity : waterBankDistance(hit.footprint, me.transform, gradientScratch);
  const ownHeight = y + hit.distance;
  let count = addParticipant(index, 0, self, ownEdge, ownHeight, 1, hit.footprint, true, true);
  // A body has no water beyond its reach: nothing to blend there.
  if (!(p.phi[0]! > 0)) return false;
  const list = index.neighbours(self);
  for (let n = 0; n < list.length; n++) {
    const j = list[n]!, other = bodies[j]!, b = other.bounds;
    if (x < b[0]! - reach || x > b[1]! + reach || z < b[4]! - reach || z > b[5]! + reach || !other.ray) continue;
    const base = waterRestBase(other.body, other.transform, other.inverse, other.ray, x, y, z);
    if (!base) continue;
    const edge = other.body.kind === "global" ? Infinity : waterBankDistance(base.footprint, other.transform, gradientScratch);
    if (edge <= -reach) continue;
    const height = y + base.distance, vertical = 1 - smoothstep(tolerance, 2 * tolerance, Math.abs(height - ownHeight));
    if (vertical <= 0) continue;
    count = addParticipant(index, count, j, edge, height, vertical, base.footprint, index.wavesMatch(self, n), index.colorsMatch(self, n));
  }
  // Shares: each participant's coverage under every participant of a higher class.
  let total = 0;
  for (let a = 0; a < count; a++) {
    let raw = p.phi[a]!;
    const cls = bodies[p.index[a]!]!.blendClass;
    for (let b = 0; b < count; b++) if (bodies[p.index[b]!]!.blendClass > cls) raw *= 1 - p.phi[b]!;
    p.weight[a] = raw; total += raw;
  }
  if (!(total > 0)) return false;
  let union = -Infinity, restHeight = 0, flowX = 0, flowY = 0, flowZ = 0, depth = 0, foreign = 0, partner = -1, partnerWeight = 0;
  let sameShare = 0, scale = 0, offset = 0, strongest = 0, strongestIndex = -1, others = 0;
  // The union in ascending body order, so every participant computes the same value.
  let previous = -1;
  for (let step = 0; step < count; step++) {
    let next = -1;
    for (let a = 0; a < count; a++) if (p.index[a]! > previous && (next < 0 || p.index[a]! < p.index[next]!)) next = a;
    previous = p.index[next]!;
    // A body leaving the blend (vertically, or over the outer half of its reach) counts as ever farther from the
    // shoreline it would otherwise share, so the union never steps where it stops taking part.
    const fade = p.vertical[next]! * smoothstep(-distance / 2, -distance / 4, p.edge[next]!);
    const edge = p.edge[next]! - (1 - fade) * 4 * distance;
    union = step === 0 ? edge : waterSmoothMax(union, edge, Math.max(2 * distance, 1e-6));
  }
  for (let a = 0; a < count; a++) {
    const w = p.weight[a]! / total, prepared = bodies[p.index[a]!]!;
    p.weight[a] = w;
    restHeight += w * p.height[a]!; depth += w * prepared.depth;
    flowX += w * p.flowX[a]!; flowY += w * p.flowY[a]!; flowZ += w * p.flowZ[a]!;
    if (p.waves[a]) { sameShare += w; scale += w * prepared.scale; offset += w * prepared.offsetAmount; }
    if (!p.colors[a]) { foreign += w; if (w > partnerWeight) { partnerWeight = w; partner = p.index[a]!; } }
    if (a > 0) {
      if (w > 0) others++;
      // Ties go to the higher class, then to the lower index.
      const better = w > strongest || (w === strongest && strongestIndex >= 0 && outranks(bodies, p.index[a]!, strongestIndex));
      if (strongestIndex < 0 || better) { strongest = w; strongestIndex = p.index[a]!; }
    }
  }
  const own = p.weight[0]!;
  let margin = strongestIndex < 0 ? 1 : own - strongest;
  if (margin === 0) margin = outranks(bodies, self, strongestIndex) ? 1e-9 : -1e-9;
  const calm = sameShare >= 1 - 1e-12 ? 1 : smoothstep(0.5, 1, sameShare);
  const meanScale = sameShare > 0 ? scale / sameShare : 0, meanOffset = sameShare > 0 ? offset / sameShare : 0;
  out.found = true;
  out.union = union; out.weight = own; out.margin = margin;
  out.restHeight = restHeight; out.ownRestHeight = ownHeight;
  out.heightScale = calm * meanScale / me.referenceScale;
  out.offsetScale = me.referenceOffset > 0 ? calm * meanOffset / me.referenceOffset : 0;
  out.foreign = foreign; out.partner = partner;
  out.flowX = flowX; out.flowY = flowY; out.flowZ = flowZ; out.depth = depth; out.others = others;
  return true;
}

function outranks(bodies: readonly PreparedWaterBlendBody[], a: number, b: number): boolean {
  const ca = bodies[a]!.blendClass, cb = bodies[b]!.blendClass;
  return ca !== cb ? ca > cb : a < b;
}

/**
 * The Gerstner offset's gain on the blended surface at a rest point (`WaterWaveGain`): the bank fade of the union
 * shoreline over the blended fade length, times `offsetScale`. Its rest-space gradient is a central difference, taken
 * only with `gradient` (the inversion's Newton steps go without it, which costs a few more steps at most).
 */
class BlendGain implements WaterWaveGain {
  index: WaterBlendIndex | null = null;
  self = 0;
  y = 0;
  gradient = true;
  private readonly point = createWaterBlendSample();
  private readonly fade = new Float64Array(2);
  private value(x0: number, z0: number): number {
    const index = this.index!, me = index.bodies[this.self]!, s = this.point;
    if (!evaluateWaterBlend(index, this.self, x0, this.y, z0, s)) return 0;
    waterBankGain(s.union, me.fadeLength * s.offsetScale, this.fade);
    return this.fade[0]! * s.offsetScale;
  }
  sample(x0: number, z0: number, out: Float64Array): void {
    const h = BLEND_DERIVATIVE_STEP;
    out[0] = this.value(x0, z0);
    if (!this.gradient) { out[1] = 0; out[2] = 0; return; }
    out[1] = (this.value(x0 + h, z0) - this.value(x0 - h, z0)) / (2 * h);
    out[2] = (this.value(x0, z0 + h) - this.value(x0, z0 - h)) / (2 * h);
  }
}

/** Rest-space step (metres) of the central differences blended queries take for slopes and the offset gain. */
export const BLEND_DERIVATIVE_STEP = 0.05;

const blendGain = new BlendGain(), blendSample = createWaterBlendSample(), sideSample = createWaterBlendSample();
const waveScratch = createWaterWaveOutput(), gainOut = new Float64Array(3), slopeScratch = new Float64Array(2), driftScratch = { x: 0, z: 0 }, fadeScratch = new Float64Array(2);

const restSlope = new Float64Array(4);

/** Central difference of the blended rest height and swell scale along (dx, dz), written to `out[at]`, `out[at + 1]`. */
function blendSlope(
  index: WaterBlendIndex, self: number, x0: number, y: number, z0: number, s: WaterBlendSample, dx: number, dz: number, out: Float64Array, at: number,
): void {
  const side = sideSample, h = BLEND_DERIVATIVE_STEP;
  let restHigh = s.restHeight, scaleHigh = s.heightScale, restLow = s.restHeight, scaleLow = s.heightScale, span = 0;
  if (evaluateWaterBlend(index, self, x0 + dx, y, z0 + dz, side)) { restHigh = side.restHeight; scaleHigh = side.heightScale; span += h; }
  if (evaluateWaterBlend(index, self, x0 - dx, y, z0 - dz, side)) { restLow = side.restHeight; scaleLow = side.heightScale; span += h; }
  out[at] = span > 0 ? (restHigh - restLow) / span : 0;
  out[at + 1] = span > 0 ? (scaleHigh - scaleLow) / span : 0;
}

/** Optional detail of a blended query: the offset scale its drift correction carries (1 off the blend). */
export interface WaterBlendQueryInfo { offsetScale: number; fade: number }

/**
 * `sampleWaterSurface` on the blended surface (`evaluateWaterBlend`) for body `self` of `index`. A body with no
 * neighbours, or a point beyond every neighbour's reach (plus the horizontal wave envelope), takes the unblended path
 * unchanged, so blending costs nothing there. Otherwise world X/Z inverts to its rest point under the blended Gerstner
 * offset, and height, slope and velocity follow the blended rest height, current and wave scales (slopes of the blended
 * rest height and swell scale by central differences). With `owned`, only the body with the largest share answers
 * (`margin` ≥ 0), so the world finds exactly one surface at a seam; a query filtered to one water actor passes false.
 * `edgeDistance` is the union shoreline distance.
 */
export function sampleWaterBlend(
  index: WaterBlendIndex, self: number, position: Vec3, time: number, owned = true, info?: WaterBlendQueryInfo,
): WaterSample {
  const me = index.bodies[self]!;
  if (info) { info.offsetScale = 1; info.fade = 1; }
  const list = index.neighbours(self);
  if (!list.length || !me.ray || !(Number.isFinite(time) && Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z)) || !me.body.enabled) {
    return sampleWaterSurface(me.definition, me.body, position, time, me.transform);
  }
  const reach = index.distance / 2 + waterHorizontalEnvelope(me.definition, me.referenceScale) + BLEND_DERIVATIVE_STEP;
  let near = false;
  for (const j of list) {
    const b = index.bodies[j]!.bounds;
    if (position.x >= b[0]! - reach && position.x <= b[1]! + reach && position.z >= b[4]! - reach && position.z <= b[5]! + reach) { near = true; break; }
  }
  if (!near) return sampleWaterSurface(me.definition, me.body, position, time, me.transform);
  const set = waterWaveSet(me.definition), scale = me.referenceScale, gerstner = waterWaveQ(set, scale) > 0, wave = waveScratch;
  blendGain.index = index; blendGain.self = self; blendGain.y = position.y;
  blendGain.gradient = false;
  invertWaterWaves(set, position.x, position.z, time, 0, wave, scale, gerstner ? blendGain : undefined);
  const x0 = wave[11]!, z0 = wave[12]!, s = blendSample;
  if (gerstner) {
    // The rest point's Jacobian with the gain's gradient, for the Eulerian slope.
    blendGain.gradient = true;
    blendGain.sample(x0, z0, gainOut);
    evaluateWaterWaves(set, x0, z0, time, 0, wave, scale, gainOut[0]!, gainOut[1]!, gainOut[2]!);
    wave[11] = x0; wave[12] = z0;
  }
  blendGain.index = null;
  if (!evaluateWaterBlend(index, self, x0, position.y, z0, s) || s.union < 0 || (owned && s.margin < 0)) return emptyWaterSample();
  // Rest-space slopes of the blended rest height and swell scale (central differences into `restSlope`: x, z pairs).
  blendSlope(index, self, x0, position.y, z0, s, BLEND_DERIVATIVE_STEP, 0, restSlope, 0);
  blendSlope(index, self, x0, position.y, z0, s, 0, BLEND_DERIVATIVE_STEP, restSlope, 2);
  const restX = restSlope[0]!, scaleX = restSlope[1]!, restZ = restSlope[2]!, scaleZ = restSlope[3]!;
  const height = wave[0]!;
  const gx = restX + s.heightScale * wave[3]! + height * scaleX, gz = restZ + s.heightScale * wave[4]! + height * scaleZ;
  let ex = gx, ez = gz;
  if (gerstner) { waterEulerianGradient(wave, gx, gz, slopeScratch); ex = slopeScratch[0]!; ez = slopeScratch[1]!; }
  const surface = s.restHeight + s.heightScale * height;
  const velocity = { x: s.flowX, y: s.flowY, z: s.flowZ };
  if (gerstner) {
    waterBankGain(s.union, me.fadeLength * s.offsetScale, fadeScratch);
    const fade = fadeScratch[0]! * fadeScratch[0]! * s.offsetScale * s.offsetScale;
    waterWaveDrift(set, scale, driftScratch, 0, position.x, position.z, time);
    velocity.x += wave[9]! + driftScratch.x * fade; velocity.z += wave[10]! + driftScratch.z * fade;
    velocity.y += s.heightScale * wave[8]! - (ex * wave[9]! + ez * wave[10]!);
    if (info) { info.offsetScale = s.offsetScale; info.fade = fadeScratch[0]!; }
  } else {
    velocity.y += s.heightScale * wave[8]!;
  }
  const magnitude = Math.hypot(ex, 1, ez);
  return {
    found: true, height: surface, depth: surface - position.y,
    normal: { x: -ex / magnitude, y: 1 / magnitude, z: -ez / magnitude },
    velocity, edgeDistance: s.union,
  };
}
