import { distanceTransform } from "./distance-transform";

/**
 * The contact field's distance passes: Babylon-free, so the main thread (`WaterContactField`) and the contact worker
 * (`water-contact.worker.ts`) run the same code on the same inputs and write the same bytes.
 */

/**
 * Contact layers: RGBA8 channel `k` stores the signed distance to objects at rest height
 * + `WATER_CONTACT_LAYER_OFFSETS[k]` x amplitude. The shader blends the two layers around each
 * fragment's rendered (wave-displaced) height, so foam follows the real waterline without rebakes.
 */
export const WATER_CONTACT_LAYER_OFFSETS: readonly number[] = [-1, -1 / 3, 1 / 3, 1];
const LAYERS = WATER_CONTACT_LAYER_OFFSETS.length;
/** Surfaces above or below a layer count a little more than horizontal ones, so nearness is not contact. */
const VERTICAL_WEIGHT = 1.5;
const INF = 1e20;

export type ContactRect = { minX: number; minZ: number; maxX: number; maxZ: number };
/** Inclusive-exclusive cell window. */
export type ContactWindow = { x0: number; z0: number; x1: number; z1: number };

/** What the distance passes read of one placed object: its cuts through the wave envelope. */
export type ContactPiece = {
  /** XZ bounds of the triangles inside the wave envelope; null when none reach it. */
  bounds: ContactRect | null;
  /** Per layer: x0, z0, x1, z1 cross-section segments at that layer's height. */
  contours: Float64Array[];
  /** Per layer: the cross-section closes, so its interior is known. */
  closed: boolean[];
  /** Triangles within the envelope: world x, height above the local rest height, world z for three corners. */
  triangles: Float64Array;
};

/** A contact texture's cells and the envelope its objects were cut for. */
export type ContactGrid = {
  /** World X/Z of cell (0, 0)'s outer corner. */
  minX: number; minZ: number;
  /** Metres per cell. */
  cell: number;
  width: number; height: number;
  /** Distances are clamped to +/- this many metres. */
  range: number;
  /** The wave envelope (metres either side of rest) the layers are cut at. */
  amplitude: number;
};

/** `fillContactWindow`'s per-window seeds, inside flags and scanline rows, shared and grown on demand. */
let scratchSeed = new Float32Array(0), scratchInside = new Uint8Array(0);
const scratchRows: number[][] = [];

/**
 * Recompute every layer inside `target`, seeding from all pieces within range of it, into `out`: RGBA8 rows
 * `outWidth` cells wide whose first cell is grid cell (`originX`, `originZ`). The whole texture passes origin 0, 0;
 * a window of its own passes its corner.
 */
export function fillContactWindow(grid: ContactGrid, pieces: Iterable<ContactPiece>, target: ContactWindow, out: Uint8Array, outWidth: number, originX = 0, originZ = 0): void {
  const { minX, minZ, cell, range, amplitude } = grid;
  const reachCells = Math.ceil(range / cell) + 2;
  const w: ContactWindow = { x0: Math.max(0, target.x0 - reachCells), z0: Math.max(0, target.z0 - reachCells), x1: Math.min(grid.width, target.x1 + reachCells), z1: Math.min(grid.height, target.z1 + reachCells) };
  const cw = w.x1 - w.x0, ch = w.z1 - w.z0;
  // Shared scratch, grown on demand: moving objects rebuild windows many times a second.
  if (scratchSeed.length < cw * ch) { scratchSeed = new Float32Array(cw * ch); scratchInside = new Uint8Array(cw * ch); }
  while (scratchRows.length < ch) scratchRows.push([]);
  const seed = scratchSeed.subarray(0, cw * ch), inside = scratchInside.subarray(0, cw * ch), rows = scratchRows;
  const reach = { minX: minX + w.x0 * cell - range, minZ: minZ + w.z0 * cell - range, maxX: minX + w.x1 * cell + range, maxZ: minZ + w.z1 * cell + range };
  const nearby = Array.from(pieces).filter(({ bounds: b }) => b && b.maxX >= reach.minX && b.minX <= reach.maxX && b.maxZ >= reach.minZ && b.minZ <= reach.maxZ);
  // Cell-centre coordinates: cell (i, j) of the window has its centre at u = i, v = j.
  const u = (x: number) => (x - minX) / cell - 0.5 - w.x0, v = (z: number) => (z - minZ) / cell - 0.5 - w.z0;
  const rangeCells = range / cell, spacing = amplitude * 2 / (LAYERS - 1);
  // Only the target cells are read, and distances beyond the range all encode alike.
  const region = { x0: target.x0 - w.x0, z0: target.z0 - w.z0, x1: target.x1 - w.x0, z1: target.z1 - w.z0, cap: rangeCells * rangeCells };
  for (let k = 0; k < LAYERS; k++) {
    seed.fill(INF); inside.fill(0);
    for (const piece of nearby) {
      const y = WATER_CONTACT_LAYER_OFFSETS[k]! * amplitude;
      const segments = piece.contours[k]!;
      for (let s = 0; s < segments.length; s += 4) {
        seedSegment(seed, cw, ch, u(segments[s]!), v(segments[s + 1]!), u(segments[s + 2]!), v(segments[s + 3]!));
      }
      const t = piece.triangles;
      for (let s = 0; s < t.length; s += 9) {
        const dy0 = t[s + 1]! - y, dy1 = t[s + 4]! - y, dy2 = t[s + 7]! - y;
        if (Math.min(dy0, dy1, dy2) > spacing || Math.max(dy0, dy1, dy2) < -spacing) continue;
        seedTriangle(seed, cw, ch, u(t[s]!), v(t[s + 2]!), dy0, u(t[s + 3]!), v(t[s + 5]!), dy1, u(t[s + 6]!), v(t[s + 8]!), dy2, VERTICAL_WEIGHT / cell, spacing / cell * VERTICAL_WEIGHT);
      }
      if (piece.closed[k]) fillInside(inside, rows, cw, ch, segments, u, v);
    }
    distanceTransform(seed, cw, ch, region);
    // Signed distance over the target (negative inside), rounded where objects' distances meet (`smoothContacts`).
    const tw = target.x1 - target.x0, th = target.z1 - target.z0, signed = contactScratch(tw * th);
    for (let z = 0; z < th; z++) for (let x = 0; x < tw; x++) {
      const i = (z + target.z0 - w.z0) * cw + (x + target.x0 - w.x0);
      const distance = Math.min(rangeCells, Math.sqrt(seed[i]!)) / rangeCells;
      signed[z * tw + x] = inside[i] ? -distance : distance;
    }
    const exact = contactExact(tw * th), floor = contactFloor(tw * th), radius = Math.max(1, Math.round(range / CONTACT_SMOOTH / cell));
    exact.set(signed); floor.set(signed);
    smoothContacts(signed, tw, th, radius);
    // The smallest exact distance under each cell's blur kernel: where any part of an object is that near (a hull, or
    // a face just above or below the layer) the exact distance stands, so waterlines keep their place; the rounding
    // takes over where everything under the kernel is three radii away or more, where creases between objects form.
    minimumFilter(floor, tw, th, radius * 2);
    const near = radius * 3 / rangeCells, far = near * 2;
    for (let z = 0; z < th; z++) for (let x = 0; x < tw; x++) {
      const i = z * tw + x, e = exact[i]!, t = Math.max(0, Math.min(1, (floor[i]! - near) / (far - near)));
      const value = e + (signed[i]! - e) * t * t * (3 - 2 * t);
      out[((z + target.z0 - originZ) * outWidth + x + target.x0 - originX) * 4 + k] = Math.round(Math.max(0, Math.min(1, 0.5 + value * 0.5)) * 255);
    }
  }
}

/**
 * The smoothing radius of the contact distances is the contact range over this (about half the Contact Foam Width):
 * where two objects' distances meet, the hard minimum of a distance transform creases along their bisector, and every
 * contour drawn from it (rings, lines) kinks into a straight crack there. Two box passes of radius r (a tent of
 * radius 2r) round the crease like a smooth minimum where everything under the kernel is far from any object; near
 * objects the exact distance stands, so thin objects keep their waterline (`minimumFilter`).
 */
const CONTACT_SMOOTH = 12;
let smoothLine = new Float32Array(0), smoothValues = new Float32Array(0);
let exactValues = new Float32Array(0), floorValues = new Float32Array(0);
function contactFloor(size: number): Float32Array {
  if (floorValues.length < size) floorValues = new Float32Array(size);
  return floorValues.subarray(0, size);
}
function contactExact(size: number): Float32Array {
  if (exactValues.length < size) exactValues = new Float32Array(size);
  return exactValues.subarray(0, size);
}
function contactScratch(size: number): Float32Array {
  if (smoothValues.length < size) smoothValues = new Float32Array(size);
  return smoothValues.subarray(0, size);
}

/** Two separable box blurs of radius `r` over a `width` × `height` grid in place, clamped at its edges. Allocation-free once grown. */
export function smoothContacts(values: Float32Array, width: number, height: number, r: number): void {
  const size = Math.max(width, height);
  if (smoothLine.length < size) smoothLine = new Float32Array(size);
  for (let n = 0; n < 2; n++) { boxPass(values, width, height, width, 1, r); boxPass(values, height, width, 1, width, r); }
}

let minimumQueue = new Int32Array(0);
/**
 * The minimum over a (2r + 1)² window of a `width` × `height` grid in place (separable, clamped at its edges), in time
 * independent of `r`. Allocation-free once grown.
 */
export function minimumFilter(values: Float32Array, width: number, height: number, r: number): void {
  const size = Math.max(width, height);
  if (smoothLine.length < size) smoothLine = new Float32Array(size);
  if (minimumQueue.length < size) minimumQueue = new Int32Array(size);
  minimumPass(values, width, height, width, 1, r);
  minimumPass(values, height, width, 1, width, r);
}

/**
 * One sliding minimum along `lines` lines of `count` values: a queue of indices whose values increase from its head,
 * each entering once and leaving once, so a cell costs the same at any radius (a full rebuild filters up to four
 * million layer cells).
 */
function minimumPass(values: Float32Array, count: number, lines: number, stride: number, step: number, r: number): void {
  const line = smoothLine, queue = minimumQueue;
  for (let l = 0; l < lines; l++) {
    const base = l * stride;
    for (let i = 0; i < count; i++) line[i] = values[base + i * step]!;
    let head = 0, tail = 0, next = 0;
    for (let i = 0; i < count; i++) {
      for (const end = Math.min(count - 1, i + r); next <= end; next++) {
        const value = line[next]!;
        while (tail > head && line[queue[tail - 1]!]! >= value) tail--;
        queue[tail++] = next;
      }
      while (queue[head]! < i - r) head++;
      values[base + i * step] = line[queue[head]!]!;
    }
  }
}

/** One box blur along `lines` lines of `count` values (line l starts at l × `stride`, values `step` apart). */
function boxPass(values: Float32Array, count: number, lines: number, stride: number, step: number, r: number): void {
  const line = smoothLine, last = count - 1, scale = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const base = l * stride;
    for (let i = 0; i < count; i++) line[i] = values[base + i * step]!;
    // Running sum over [i - r, i + r], clamped at the ends.
    let sum = 0;
    for (let j = -r; j <= r; j++) sum += line[j < 0 ? 0 : j > last ? last : j]!;
    for (let i = 0; i < count; i++) {
      values[base + i * step] = sum * scale;
      const add = i + r + 1, drop = i - r;
      sum += line[add > last ? last : add]! - line[drop < 0 ? 0 : drop]!;
    }
  }
}

/** Exact squared distances (cell units) from nearby cell centres to a cross-section segment. */
function seedSegment(seed: Float32Array, width: number, height: number, u0: number, v0: number, u1: number, v1: number): void {
  const du = u1 - u0, dv = v1 - v0, length2 = du * du + dv * dv;
  const alongU = Math.abs(du) >= Math.abs(dv);
  const [a0, a1] = alongU ? [Math.min(u0, u1), Math.max(u0, u1)] : [Math.min(v0, v1), Math.max(v0, v1)];
  const first = Math.max(0, Math.floor(a0) - 1), last = Math.min((alongU ? width : height) - 1, Math.ceil(a1) + 1);
  for (let major = first; major <= last; major++) {
    // The segment's cross coordinate at this column (or row), clamped to its extent.
    const t = alongU ? (du === 0 ? 0 : (major - u0) / du) : (dv === 0 ? 0 : (major - v0) / dv);
    const c = t <= 0 ? (alongU ? v0 : u0) : t >= 1 ? (alongU ? v1 : u1) : (alongU ? v0 + dv * t : u0 + du * t);
    const lo = Math.max(0, Math.ceil(c - 1.5)), hi = Math.min((alongU ? height : width) - 1, Math.floor(c + 1.5));
    for (let minor = lo; minor <= hi; minor++) {
      const i = alongU ? major : minor, j = alongU ? minor : major;
      const s = length2 > 0 ? Math.max(0, Math.min(1, ((i - u0) * du + (j - v0) * dv) / length2)) : 0;
      const x = i - u0 - du * s, y = j - v0 - dv * s, h2 = x * x + y * y;
      if (h2 <= 1) {
        const index = j * width + i;
        if (h2 < seed[index]!) seed[index] = h2;
      }
    }
  }
}

/**
 * Surfaces between layers: each covered cell centre gets the weighted vertical gap to the
 * triangle, so the distance transform yields an anisotropic 3D distance at the layer's height.
 */
function seedTriangle(seed: Float32Array, width: number, height: number,
  u0: number, v0: number, y0: number, u1: number, v1: number, y1: number, u2: number, v2: number, y2: number, weight: number, limit: number): void {
  const area = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
  if (Math.abs(area) < 1e-9) return;
  const iMin = Math.max(0, Math.ceil(Math.min(u0, u1, u2))), iMax = Math.min(width - 1, Math.floor(Math.max(u0, u1, u2)));
  const jMin = Math.max(0, Math.ceil(Math.min(v0, v1, v2))), jMax = Math.min(height - 1, Math.floor(Math.max(v0, v1, v2)));
  for (let j = jMin; j <= jMax; j++) for (let i = iMin; i <= iMax; i++) {
    const b1 = ((i - u0) * (v2 - v0) - (u2 - u0) * (j - v0)) / area;
    const b2 = ((u1 - u0) * (j - v0) - (i - u0) * (v1 - v0)) / area;
    if (b1 < 0 || b2 < 0 || b1 + b2 > 1) continue;
    const gap = Math.abs(y0 + (y1 - y0) * b1 + (y2 - y0) * b2) * weight;
    if (gap > limit) continue;
    const index = j * width + i;
    if (gap * gap < seed[index]!) seed[index] = gap * gap;
  }
}

/** Even-odd scanline fill of a closed cross-section at cell centres. */
function fillInside(inside: Uint8Array, rows: number[][], width: number, height: number, segments: Float64Array, u: (x: number) => number, v: (z: number) => number): void {
  let used = false;
  for (let s = 0; s < segments.length; s += 4) {
    const u0 = u(segments[s]!), v0 = v(segments[s + 1]!), u1 = u(segments[s + 2]!), v1 = v(segments[s + 3]!);
    const first = Math.max(0, Math.ceil(Math.min(v0, v1))), last = Math.min(height - 1, Math.floor(Math.max(v0, v1)));
    for (let j = first; j <= last; j++) {
      if ((v0 <= j) === (v1 <= j)) continue;
      rows[j]!.push(u0 + (u1 - u0) * (j - v0) / (v1 - v0));
      used = true;
    }
  }
  if (!used) return;
  for (let j = 0; j < height; j++) {
    const row = rows[j]!;
    // An odd count means a gap the endpoint check could not see; leave that row unsigned.
    if (row.length < 2 || row.length % 2 === 1) { row.length = 0; continue; }
    row.sort((a, b) => a - b);
    for (let p = 0; p + 1 < row.length; p += 2) {
      const from = Math.max(0, Math.ceil(row[p]!)), to = Math.min(width - 1, Math.floor(row[p + 1]!));
      for (let i = from; i <= to; i++) inside[j * width + i] = 1;
    }
    row.length = 0;
  }
}
