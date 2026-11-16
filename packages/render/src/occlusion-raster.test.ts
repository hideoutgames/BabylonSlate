import { describe, expect, it } from "vitest";
import { OcclusionBuffer } from "./occlusion-raster";

type Vec = [number, number, number];

/** Babylon's left-handed look-at view times its perspective projection (Matrix.m layout), in doubles. */
function viewProjection(eye: Vec, target: Vec, fov: number, aspect: number, near: number, far: number): number[] {
  const z = normalize(sub(target, eye));
  const x = normalize(cross([0, 1, 0], z));
  const y = cross(z, x);
  const view = [
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ];
  const f = 1 / Math.tan(fov / 2);
  const projection = [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far / (far - near), 1,
    0, 0, -near * far / (far - near), 0,
  ];
  const out = new Array<number>(16).fill(0);
  for (let row = 0; row < 4; row++)
    for (let column = 0; column < 4; column++)
      for (let k = 0; k < 4; k++) out[row * 4 + column]! += view[row * 4 + k]! * projection[k * 4 + column]!;
  return out;
}

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec, s: number): Vec => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec): Vec => scale(a, 1 / Math.hypot(...a));

/** A seeded generator, so a failing case reproduces. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Whether the segment from `eye` to `point` crosses triangle (a, b, c) strictly before `point` (Möller–Trumbore). */
function segmentHits(eye: Vec, point: Vec, a: Vec, b: Vec, c: Vec): boolean {
  const direction = sub(point, eye);
  const ab = sub(b, a), ac = sub(c, a);
  const p = cross(direction, ac);
  const determinant = dot(ab, p);
  if (Math.abs(determinant) < 1e-12) return false;
  const inverse = 1 / determinant;
  const s = sub(eye, a);
  const u = dot(s, p) * inverse;
  if (u < 0 || u > 1) return false;
  const q = cross(s, ab);
  const v = dot(direction, q) * inverse;
  if (v < 0 || u + v > 1) return false;
  const t = dot(ac, q) * inverse;
  return t > 0 && t < 1;
}

/** Points over a box's surface: a grid on each face, corners and edges included. */
function boxSamples(min: Vec, max: Vec, steps = 6): Vec[] {
  const points: Vec[] = [];
  for (let axis = 0; axis < 3; axis++) {
    for (const side of [min[axis]!, max[axis]!]) {
      for (let i = 0; i <= steps; i++) {
        for (let j = 0; j <= steps; j++) {
          const point: Vec = [0, 0, 0];
          const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
          point[axis] = side;
          point[u] = min[u]! + (max[u]! - min[u]!) * (i / steps);
          point[v] = min[v]! + (max[v]! - min[v]!) * (j / steps);
          points.push(point);
        }
      }
    }
  }
  return points;
}

/** A box's twelve triangles. */
function boxTriangles(min: Vec, max: Vec): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  for (let corner = 0; corner < 8; corner++)
    positions.push(corner & 1 ? max[0] : min[0], corner & 2 ? max[1] : min[1], corner & 4 ? max[2] : min[2]);
  const faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const indices = faces.flatMap(([a, b, c, d]) => [a!, b!, c!, a!, c!, d!]);
  return { positions, indices };
}

function triangleList(positions: number[], indices: number[]): [Vec, Vec, Vec][] {
  const at = (index: number): Vec => [positions[index * 3]!, positions[index * 3 + 1]!, positions[index * 3 + 2]!];
  const triangles: [Vec, Vec, Vec][] = [];
  for (let corner = 0; corner < indices.length; corner += 3)
    triangles.push([at(indices[corner]!), at(indices[corner + 1]!), at(indices[corner + 2]!)]);
  return triangles;
}

const FOV = 1, ASPECT = 2, NEAR = 0.1, FAR = 1000;

describe("OcclusionBuffer", () => {
  it.each([
    ["at the origin", [0, 0, 0] as Vec],
    // 100 km out, where a float32 matrix would be off by centimetres.
    ["far from the origin", [1e5, 20, -1e5] as Vec],
  ])("never calls a box occluded that some ray from the eye reaches, %s (fuzz)", (_, origin) => {
    const next = random(origin[0] === 0 ? 1 : 2);
    const buffer = new OcclusionBuffer(128, 64);
    let occluded = 0, tested = 0;
    for (let scene = 0; scene < 150; scene++) {
      const eye = add(origin, [next() * 4 - 2, next() * 2, next() * 4 - 2]);
      const forward = normalize([next() - 0.5, (next() - 0.5) * 0.4, 1]);
      buffer.begin(viewProjection(eye, add(eye, forward), FOV, ASPECT, NEAR, FAR), NEAR);
      const triangles: [Vec, Vec, Vec][] = [];
      for (let index = 0; index < 6; index++) {
        // Boxes and walls between 1 m and 20 m ahead, some reaching behind the eye.
        const centre = add(eye, add(scale(forward, 1 + next() * 19), [next() * 16 - 8, next() * 6 - 3, next() * 16 - 8]));
        const half: Vec = next() < 0.5 ? [next() * 4, next() * 3, 0.05 + next() * 0.2] : [next() * 3, next() * 3, next() * 3];
        const { positions, indices } = boxTriangles(sub(centre, half), add(centre, half));
        buffer.rasterize(positions, indices);
        triangles.push(...triangleList(positions, indices));
      }
      buffer.finish();
      for (let box = 0; box < 80; box++) {
        const centre = add(eye, add(scale(forward, 2 + next() * 40), [next() * 30 - 15, next() * 10 - 5, next() * 30 - 15]));
        const half: Vec = [0.05 + next() * 2, 0.05 + next() * 2, 0.05 + next() * 2];
        const min = sub(centre, half), max = add(centre, half);
        tested++;
        if (!buffer.occluded(...min, ...max)) continue;
        occluded++;
        for (const point of boxSamples(min, max)) {
          const blocked = triangles.some(([a, b, c]) => segmentHits(eye, point, a, b, c));
          if (!blocked) throw new Error(`A visible point ${point.join(", ")} of box ${min.join(", ")} – ${max.join(", ")} was called occluded (scene ${scene}).`);
        }
      }
    }
    // The test is not vacuous: a fair share of boxes is culled.
    expect(occluded / tested).toBeGreaterThan(0.05);
  });

  const wall = boxTriangles([-5, -5, 5], [5, 5, 5.2]);
  const lookForward = () => viewProjection([0, 0, 0], [0, 0, 1], FOV, ASPECT, NEAR, FAR);

  it("culls a box behind a wall and keeps one beside it or in front of it", () => {
    const buffer = new OcclusionBuffer(128, 64);
    buffer.begin(lookForward(), NEAR);
    buffer.rasterize(wall.positions, wall.indices);
    buffer.finish();
    expect(buffer.occluded(-1, -1, 10, 1, 1, 12)).toBe(true);
    expect(buffer.occluded(8, -1, 10, 10, 1, 12)).toBe(false);
    expect(buffer.occluded(-1, -1, 3, 1, 1, 4)).toBe(false);
    // A box that reaches through the wall toward the eye.
    expect(buffer.occluded(-1, -1, 4.9, 1, 1, 12)).toBe(false);
  });

  it("calls everything visible before finish and after begin", () => {
    const buffer = new OcclusionBuffer(64, 32);
    expect(buffer.occluded(-1, -1, 10, 1, 1, 12)).toBe(false);
    buffer.begin(lookForward(), NEAR);
    buffer.rasterize(wall.positions, wall.indices);
    buffer.finish();
    buffer.begin(lookForward(), NEAR);
    expect(buffer.occluded(-1, -1, 10, 1, 1, 12)).toBe(false);
    buffer.finish();
    expect(buffer.occluded(-1, -1, 10, 1, 1, 12)).toBe(false);
  });

  it("calls a box with a corner at or behind the near plane visible, even inside an occluder's shadow", () => {
    const buffer = new OcclusionBuffer(128, 64);
    buffer.begin(lookForward(), NEAR);
    buffer.rasterize(wall.positions, wall.indices);
    buffer.finish();
    expect(buffer.occluded(-1, -1, -2, 1, 1, 12)).toBe(false);
    expect(buffer.occluded(-1, -1, 0.05, 1, 1, 12)).toBe(false);
    // Wholly behind the camera.
    expect(buffer.occluded(-1, -1, -12, 1, 1, -10)).toBe(false);
  });

  it("clips occluders crossing the near plane and still uses what lies in front", () => {
    const buffer = new OcclusionBuffer(128, 64);
    buffer.begin(lookForward(), NEAR);
    // A floor-to-ceiling slab from behind the camera to 6 m ahead, to the right of the view axis.
    const slab = boxTriangles([0.5, -50, -10], [0.7, 50, 6]);
    buffer.rasterize(slab.positions, slab.indices);
    buffer.finish();
    // Behind the slab, far right of the view: hidden. Left of it: seen.
    expect(buffer.occluded(3, -1, 8, 4, 1, 9)).toBe(true);
    expect(buffer.occluded(-4, -1, 8, -3, 1, 9)).toBe(false);
    // Nothing behind the camera occludes.
    const behind = boxTriangles([-50, -50, -3], [50, 50, -2]);
    buffer.begin(lookForward(), NEAR);
    buffer.rasterize(behind.positions, behind.indices);
    buffer.finish();
    expect(buffer.occluded(-1, -1, 10, 1, 1, 12)).toBe(false);
  });

  it("never lets a receding occluder hide what stands in front of its far part", () => {
    const buffer = new OcclusionBuffer(128, 64);
    buffer.begin(lookForward(), NEAR);
    // A floor 1 m below the eye from 2 m to 100 m ahead: it covers the lower half of the view, 2 m to 100 m deep.
    const floor = boxTriangles([-100, -1.1, 2], [100, -1, 100]);
    buffer.rasterize(floor.positions, floor.indices);
    buffer.finish();
    // A crate on it 6 m ahead covers floor from about 7 m away on screen, yet is in front of it.
    expect(buffer.occluded(-0.2, -0.9, 6, 0.2, -0.8, 6.5)).toBe(false);
  });

  it("does not hide what shows through a gap between two occluders narrower than a texel", () => {
    const buffer = new OcclusionBuffer(128, 64);
    buffer.begin(lookForward(), NEAR);
    // Two walls 5 m ahead with a 1 cm slit between them at x = 0, far under a texel (about 9 cm there).
    for (const [from, to] of [[-5, -0.005], [0.005, 5]] as const) {
      const wall = boxTriangles([from, -5, 5], [to, 5, 5.2]);
      buffer.rasterize(wall.positions, wall.indices);
    }
    buffer.finish();
    expect(buffer.occluded(-1, -1, 10, 1, 1, 12)).toBe(false);
    expect(buffer.occluded(-3, -1, 10, -2, 1, 12)).toBe(true);
  });

  it("calls a box reaching past the buffer's edge visible", () => {
    const buffer = new OcclusionBuffer(128, 64);
    buffer.begin(lookForward(), NEAR);
    const huge = boxTriangles([-500, -500, 5], [500, 500, 5.2]);
    buffer.rasterize(huge.positions, huge.indices);
    buffer.finish();
    expect(buffer.occluded(-1, -1, 10, 1, 1, 12)).toBe(true);
    expect(buffer.occluded(-1, -1, 10, 100, 1, 12)).toBe(false);
  });

  it("skips triangles of the culled winding", () => {
    const triangle = [-5, -5, 5, 0, 5, 5, 5, -5, 5];
    const hidden = [-0.5, -0.5, 10, 0.5, 0.5, 11] as const;
    const results = (["clockwise", "counterClockwise", "both"] as const).map((winding) => {
      const buffer = new OcclusionBuffer(128, 64);
      buffer.begin(lookForward(), NEAR);
      buffer.rasterize(triangle, undefined, undefined, winding);
      buffer.finish();
      return buffer.occluded(...hidden);
    });
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(results[2]).toBe(true);
  });

  it("places occluders with a world transform", () => {
    const buffer = new OcclusionBuffer(128, 64);
    buffer.begin(lookForward(), NEAR);
    const unit = boxTriangles([-1, -1, -0.1], [1, 1, 0.1]);
    // Scale 5 and move 5 m ahead.
    buffer.rasterize(unit.positions, unit.indices, [5, 0, 0, 0, 0, 5, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1]);
    buffer.finish();
    expect(buffer.occluded(-1, -1, 10, 1, 1, 12)).toBe(true);
    expect(buffer.occluded(-1, -1, 4, 1, 1, 12)).toBe(false);
  });
});

/**
 * The buffer as it was before its pyramid became lazy and its clear partial: every frame cleared the whole buffer and
 * reduced every pyramid level. The current buffer must answer every test from exactly the same depths.
 */
class ReferenceOcclusionBuffer {
  readonly levels: Float32Array[] = [];
  readonly levelWidths: number[] = [];
  readonly levelHeights: number[] = [];
  private readonly occluder: Float32Array;
  private readonly rowMax: Float32Array;
  private occluderLeft = 0;
  private occluderRight = -1;
  private occluderTop = 0;
  private occluderBottom = -1;
  private readonly matrix = new Float64Array(16);
  private near = 0.1;
  private readonly clipped = new Float64Array(16 * 4);
  private readonly screen = new Float64Array(4 * 3);
  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.occluder = new Float32Array(width * height).fill(Infinity);
    this.rowMax = new Float32Array(width * height);
    for (let w = width, h = height; ; w = Math.max(1, Math.ceil(w / 2)), h = Math.max(1, Math.ceil(h / 2))) {
      this.levels.push(new Float32Array(w * h));
      this.levelWidths.push(w);
      this.levelHeights.push(h);
      if (w === 1 && h === 1) break;
    }
  }

  begin(viewProjection: ArrayLike<number>, near: number): void {
    for (let index = 0; index < 16; index++) this.matrix[index] = viewProjection[index]!;
    this.near = Math.max(near, 1e-6);
    this.levels[0]!.fill(Infinity);
  }

  rasterize(positions: ArrayLike<number>, indices?: ArrayLike<number>, transform?: ArrayLike<number>, winding: Winding = "both"): void {
    const count = indices ? indices.length : positions.length / 3;
    for (let corner = 0; corner + 2 < count; corner += 3) {
      const a = indices ? indices[corner]! : corner, b = indices ? indices[corner + 1]! : corner + 1, c = indices ? indices[corner + 2]! : corner + 2;
      this.triangle(positions, a, b, c, transform, winding);
    }
    this.mergeOccluder();
  }

  finish(): void {
    for (let level = 1; level < this.levels.length; level++) {
      const source = this.levels[level - 1]!, target = this.levels[level]!;
      const sw = this.levelWidths[level - 1]!, sh = this.levelHeights[level - 1]!, tw = this.levelWidths[level]!, th = this.levelHeights[level]!;
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
          let depth = 0;
          for (let dy = 0; dy < 2; dy++) {
            const row = Math.min(y * 2 + dy, sh - 1);
            for (let dx = 0; dx < 2; dx++) {
              const value = source[row * sw + Math.min(x * 2 + dx, sw - 1)]!;
              if (value > depth) depth = value;
            }
          }
          target[y * tw + x] = depth;
        }
      }
    }
  }

  /** The texels the test of box [min, max] reads, as [level, x, y], and its nearest depth; null where it reads none. */
  reads(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): { nearest: number; texels: [number, number, number][] } | null {
    const m = this.matrix;
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity, nearest = Infinity;
    for (let corner = 0; corner < 8; corner++) {
      const x = corner & 1 ? maxX : minX, y = corner & 2 ? maxY : minY, z = corner & 4 ? maxZ : minZ;
      const w = x * m[3]! + y * m[7]! + z * m[11]! + m[15]!;
      if (!(w > this.near)) return null;
      const sx = ((x * m[0]! + y * m[4]! + z * m[8]! + m[12]!) / w * 0.5 + 0.5) * this.width;
      const sy = (0.5 - (x * m[1]! + y * m[5]! + z * m[9]! + m[13]!) / w * 0.5) * this.height;
      if (sx < left) left = sx;
      if (sx > right) right = sx;
      if (sy < top) top = sy;
      if (sy > bottom) bottom = sy;
      if (w < nearest) nearest = w;
    }
    const x0 = Math.floor(left - 0.5) - 1, x1 = Math.ceil(right - 0.5) + 1;
    const y0 = Math.floor(top - 0.5) - 1, y1 = Math.ceil(bottom - 0.5) + 1;
    if (x0 < 0 || y0 < 0 || x1 >= this.width || y1 >= this.height) return null;
    let level = 0;
    while (level + 1 < this.levels.length && ((x1 >> level) - (x0 >> level) >= 8 || (y1 >> level) - (y0 >> level) >= 8)) level++;
    const texels: [number, number, number][] = [];
    for (let y = y0 >> level; y <= y1 >> level; y++) for (let x = x0 >> level; x <= x1 >> level; x++) texels.push([level, x, y]);
    return { nearest, texels };
  }

  occluded(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, epsilon = 1e-3): boolean {
    const read = this.reads(minX, minY, minZ, maxX, maxY, maxZ);
    if (!read) return false;
    const limit = read.nearest - epsilon;
    return read.texels.every(([level, x, y]) => this.levels[level]![y * this.levelWidths[level]! + x]! < limit);
  }

  private mergeOccluder(): void {
    const { width, height, occluder, rowMax } = this;
    const base = this.levels[0]!;
    const top = this.occluderTop, bottom = this.occluderBottom, left = this.occluderLeft, right = this.occluderRight;
    for (let y = top; y <= bottom; y++) {
      const row = y * width;
      for (let x = left; x <= right; x++) {
        const centre = occluder[row + x]!;
        const before = x > 0 ? occluder[row + x - 1]! : Infinity;
        const after = x + 1 < width ? occluder[row + x + 1]! : Infinity;
        rowMax[row + x] = Math.max(before, centre, after);
      }
    }
    for (let y = top; y <= bottom; y++) {
      if (y === 0 || y + 1 === height || y === top || y === bottom) continue;
      const row = y * width;
      for (let x = left; x <= right; x++) {
        const depth = Math.max(rowMax[row - width + x]!, rowMax[row + x]!, rowMax[row + width + x]!);
        if (depth < base[row + x]!) base[row + x] = depth;
      }
    }
    for (let y = this.occluderTop; y <= this.occluderBottom; y++)
      occluder.fill(Infinity, y * width + this.occluderLeft, y * width + this.occluderRight + 1);
    this.occluderLeft = this.occluderTop = 0;
    this.occluderRight = this.occluderBottom = -1;
  }

  private triangle(positions: ArrayLike<number>, a: number, b: number, c: number, transform: ArrayLike<number> | undefined, winding: Winding): void {
    const m = this.matrix, out = this.clipped;
    for (let corner = 0; corner < 3; corner++) {
      const index = (corner === 0 ? a : corner === 1 ? b : c) * 3;
      let x = positions[index]!, y = positions[index + 1]!, z = positions[index + 2]!;
      if (transform) {
        const t = transform;
        const wx = x * t[0]! + y * t[4]! + z * t[8]! + t[12]!;
        const wy = x * t[1]! + y * t[5]! + z * t[9]! + t[13]!;
        const wz = x * t[2]! + y * t[6]! + z * t[10]! + t[14]!;
        x = wx; y = wy; z = wz;
      }
      out[corner * 3] = x * m[0]! + y * m[4]! + z * m[8]! + m[12]!;
      out[corner * 3 + 1] = x * m[1]! + y * m[5]! + z * m[9]! + m[13]!;
      out[corner * 3 + 2] = x * m[3]! + y * m[7]! + z * m[11]! + m[15]!;
    }
    const near = this.near, screen = this.screen;
    let vertices = 0, farthest = 0;
    for (let corner = 0; corner < 3; corner++) {
      const next = (corner + 1) % 3;
      const cx = out[corner * 3]!, cy = out[corner * 3 + 1]!, cw = out[corner * 3 + 2]!;
      const nx = out[next * 3]!, ny = out[next * 3 + 1]!, nw = out[next * 3 + 2]!;
      const inside = cw >= near, nextInside = nw >= near;
      if (inside) vertices = this.emit(screen, vertices, cx, cy, cw);
      if (inside !== nextInside) {
        const t = (near - cw) / (nw - cw);
        vertices = this.emit(screen, vertices, cx + (nx - cx) * t, cy + (ny - cy) * t, near);
      }
    }
    if (vertices < 3) return;
    for (let vertex = 0; vertex < vertices; vertex++) if (screen[vertex * 3 + 2]! > farthest) farthest = screen[vertex * 3 + 2]!;
    for (let vertex = 1; vertex + 1 < vertices; vertex++) this.fill(0, vertex, vertex + 1, farthest, winding);
  }

  private emit(screen: Float64Array, count: number, x: number, y: number, w: number): number {
    screen[count * 3] = (x / w * 0.5 + 0.5) * this.width;
    screen[count * 3 + 1] = (0.5 - y / w * 0.5) * this.height;
    screen[count * 3 + 2] = w;
    return count + 1;
  }

  private fill(a: number, b: number, c: number, depth: number, winding: Winding): void {
    const s = this.screen;
    const ax = s[a * 3]!, ay = s[a * 3 + 1]!, bx = s[b * 3]!, by = s[b * 3 + 1]!, cx = s[c * 3]!, cy = s[c * 3 + 1]!;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area === 0 || !Number.isFinite(area)) return;
    if (winding === "clockwise" && area < 0) return;
    if (winding === "counterClockwise" && area > 0) return;
    const sign = area > 0 ? 1 : -1;
    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5)), x1 = Math.min(this.width - 1, Math.floor(Math.max(ax, bx, cx) - 0.5));
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5)), y1 = Math.min(this.height - 1, Math.floor(Math.max(ay, by, cy) - 0.5));
    const occluder = this.occluder, width = this.width;
    if (x0 > x1 || y0 > y1) return;
    if (this.occluderRight < this.occluderLeft) {
      this.occluderLeft = x0; this.occluderRight = x1; this.occluderTop = y0; this.occluderBottom = y1;
    } else {
      this.occluderLeft = Math.min(this.occluderLeft, x0); this.occluderRight = Math.max(this.occluderRight, x1);
      this.occluderTop = Math.min(this.occluderTop, y0); this.occluderBottom = Math.max(this.occluderBottom, y1);
    }
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      let from = x0, to = x1;
      for (let edge = 0; edge < 3 && from <= to; edge++) {
        let ex = edge === 0 ? ax : edge === 1 ? bx : cx, ey = edge === 0 ? ay : edge === 1 ? by : cy;
        let fx = edge === 0 ? bx : edge === 1 ? cx : ax, fy = edge === 0 ? by : edge === 1 ? cy : ay;
        let side = sign;
        if (ey > fy || (ey === fy && ex > fx)) {
          [ex, ey, fx, fy] = [fx, fy, ex, ey];
          side = -side;
        }
        if (fy === ey) {
          if (side * (fx - ex) * (py - ey) < 0) to = from - 1;
          continue;
        }
        const crossing = ex + ((fx - ex) * (py - ey)) / (fy - ey) - 0.5;
        if (side < 0) from = Math.max(from, Math.ceil(crossing));
        else to = Math.min(to, Math.floor(crossing));
      }
      const row = y * width;
      for (let x = from; x <= to; x++) if (depth < occluder[row + x]!) occluder[row + x] = depth;
    }
  }
}

type Winding = "clockwise" | "counterClockwise" | "both";

describe("OcclusionBuffer against the full-rebuild reference", () => {
  type Box = { min: Vec; max: Vec };
  interface Frame {
    viewProjection: number[];
    occluders: { positions: number[]; indices: number[]; transform?: number[]; winding: Winding }[];
    tests: Box[];
  }

  /** The current buffer's depth at a pyramid texel, as a test reads it (reduced on demand). */
  const texelOf = (buffer: OcclusionBuffer, level: number, x: number, y: number) =>
    (buffer as unknown as { texel(level: number, x: number, y: number): number }).texel(level, x, y);

  /**
   * Runs the frames through one current and one reference buffer, frame after frame, and checks that every test answers
   * the same from the same depths at every texel it reads, and that level 0 is the same everywhere.
   */
  function compare(frames: Frame[], width: number, height: number): { culled: number; tested: number; read: number } {
    const buffer = new OcclusionBuffer(width, height), reference = new ReferenceOcclusionBuffer(width, height);
    let culled = 0, tested = 0, read = 0;
    frames.forEach((frame, index) => {
      for (const target of [buffer, reference]) {
        target.begin(frame.viewProjection, NEAR);
        for (const occluder of frame.occluders) target.rasterize(occluder.positions, occluder.indices, occluder.transform, occluder.winding);
        target.finish();
      }
      for (const { min, max } of frame.tests) {
        tested++;
        const expected = reference.occluded(...min, ...max);
        // Asked before the texels are read below, so the answer comes from the buffer's own on-demand reductions.
        expect(buffer.occluded(...min, ...max), `frame ${index}, box ${min} – ${max}`).toBe(expected);
        if (expected) culled++;
        for (const [level, x, y] of reference.reads(...min, ...max)?.texels ?? []) {
          if (level > 0) read++;
          expect(texelOf(buffer, level, x, y), `frame ${index}, level ${level} texel ${x}, ${y}`)
            .toBe(reference.levels[level]![y * reference.levelWidths[level]! + x]!);
        }
      }
      expect(Array.from(buffer.depths().depth), `frame ${index} level 0`).toEqual(Array.from(reference.levels[0]!));
    });
    return { culled, tested, read };
  }

  /** A seeded scene: a camera, boxes and walls around it (some crossing the near plane or off screen), boxes to test. */
  function randomFrame(next: () => number, occluderCount: number): Frame {
    const eye: Vec = [next() * 10 - 5, next() * 3, next() * 10 - 5];
    const forward = normalize([next() - 0.5, (next() - 0.5) * 0.4, next() - 0.5]);
    const occluders: Frame["occluders"] = [];
    for (let index = 0; index < occluderCount; index++) {
      const centre = add(eye, add(scale(forward, next() * 25 - 3), [next() * 24 - 12, next() * 8 - 4, next() * 24 - 12]));
      const half: Vec = next() < 0.5 ? [next() * 4, next() * 3, 0.05 + next() * 0.2] : [next() * 3, next() * 3, next() * 3];
      const { positions, indices } = boxTriangles(sub(centre, half), add(centre, half));
      const winding = (["clockwise", "counterClockwise", "both"] as const)[Math.floor(next() * 3)]!;
      // Some placed by a world transform (a scale and a move), as `ViewOcclusion` draws them.
      const transform = next() < 0.3
        ? [1 + next(), 0, 0, 0, 0, 1 + next(), 0, 0, 0, 0, 1 + next(), 0, next() - 0.5, next() - 0.5, next() - 0.5, 1]
        : undefined;
      occluders.push({ positions, indices, transform, winding });
    }
    const tests: Box[] = [];
    for (let index = 0; index < 40; index++) {
      const centre = add(eye, add(scale(forward, 1 + next() * 40), [next() * 30 - 15, next() * 10 - 5, next() * 30 - 15]));
      // Mostly small boxes, some wide enough to be read at coarse levels.
      const reach = next() < 0.8 ? 1.5 : 12;
      const half: Vec = [0.05 + next() * reach, 0.05 + next() * reach, 0.05 + next() * reach];
      tests.push({ min: sub(centre, half), max: add(centre, half) });
    }
    return { viewProjection: viewProjection(eye, add(eye, forward), FOV, ASPECT, NEAR, FAR), occluders, tests };
  }

  it.each([
    ["256 × 128", 256, 128, 3],
    // Odd sizes, whose pyramid repeats its last row and column.
    ["77 × 37", 77, 37, 4],
  ])("answers every test from the same depths over seeded scenes, frame after frame, at %s", (_, width, height, seed) => {
    const next = random(seed);
    // Each frame follows one with other occluders and another camera, so a stale area of the last frame would show.
    const frames = Array.from({ length: 120 }, (_, index) => randomFrame(next, index % 10 === 0 ? 0 : 1 + Math.floor(next() * 8)));
    const { culled, tested, read } = compare(frames, width, height);
    // Not vacuous: boxes are culled and kept, and texels above level 0 are read.
    expect(culled).toBeGreaterThan(tested * 0.05);
    expect(culled).toBeLessThan(tested * 0.95);
    expect(read).toBeGreaterThan(100);
  });

  const lookAhead = () => viewProjection([0, 0, 0], [0, 0, 1], FOV, ASPECT, NEAR, FAR);
  const wallAhead = { ...boxTriangles([-5, -5, 5], [5, 5, 5.2]), winding: "both" as const };
  const behindWall: Box = { min: [-1, -1, 10], max: [1, 1, 12] };

  it("answers the same with no occluder, with occluders wholly off screen, after a frame with no test, and for a box reaching past the edge", () => {
    const offScreen = { ...boxTriangles([40, -1, 5], [42, 1, 6]), winding: "both" as const };
    const behindEye = { ...boxTriangles([-5, -5, -8], [5, 5, -6]), winding: "both" as const };
    const tests: Box[] = [behindWall, { min: [-1, -1, 10], max: [30, 1, 12] }, { min: [40, -1, 10], max: [42, 1, 12] }];
    const { culled } = compare([
      { viewProjection: lookAhead(), occluders: [], tests },
      { viewProjection: lookAhead(), occluders: [offScreen, behindEye], tests },
      { viewProjection: lookAhead(), occluders: [wallAhead], tests: [] },
      { viewProjection: lookAhead(), occluders: [wallAhead], tests },
    ], 128, 64);
    // Only the box wholly behind the wall, in the last frame.
    expect(culled).toBe(1);
  });

  it("forgets the last frame's occluders: a wall drawn in one frame hides nothing in the next", () => {
    const buffer = new OcclusionBuffer(128, 64);
    buffer.begin(lookAhead(), NEAR);
    buffer.rasterize(wallAhead.positions, wallAhead.indices);
    buffer.finish();
    expect(buffer.occluded(...behindWall.min, ...behindWall.max)).toBe(true);
    buffer.begin(lookAhead(), NEAR);
    buffer.finish();
    expect(buffer.occluded(...behindWall.min, ...behindWall.max)).toBe(false);
    expect(buffer.depths().depth.every((depth) => depth === Infinity)).toBe(true);
  });

  it("answers nothing occluded between an occluder and the next finish", () => {
    const buffer = new OcclusionBuffer(128, 64);
    buffer.begin(lookAhead(), NEAR);
    buffer.rasterize(wallAhead.positions, wallAhead.indices);
    buffer.finish();
    buffer.rasterize(wallAhead.positions, wallAhead.indices);
    expect(buffer.occluded(...behindWall.min, ...behindWall.max)).toBe(false);
    buffer.finish();
    expect(buffer.occluded(...behindWall.min, ...behindWall.max)).toBe(true);
  });
});
