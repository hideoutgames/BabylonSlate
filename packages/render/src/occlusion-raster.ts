/**
 * A CPU occlusion buffer, free of Babylon: occluder triangles are rasterised into a small view-depth buffer, which a
 * world box is then tested against. It is conservative: a box it calls occluded is hidden behind the occluders from
 * every point of the view (never a false "occluded"); some hidden boxes are called visible.
 *
 * - Depth is linear view depth, the clip-space w of Babylon's perspective projection (the distance along the view
 *   axis). Each texel keeps the minimum, over the triangles covering its centre, of each triangle's farthest depth: a
 *   triangle stands in for the whole slab behind its nearest point only where it is certainly in front.
 * - Each occluder (one `rasterize` call) is rasterised on its own and its coverage eroded by one texel (a 3 × 3 depth
 *   max) before it joins the buffer: a texel then counts only where one occluder covers all of it, so an edge between
 *   texel centres, or a gap between two occluders narrower than a texel, never claims the area beside it. This holds
 *   for an occluder whose screen shape is convex (a box, a wall, a convex hull); a concave one can claim a sliver of a
 *   notch, so concave occluders are split into convex parts.
 * - A max-reduced mip pyramid answers a box's test from at most 2 × 2 texels.
 * - Triangles are clipped against the near plane (w ≥ near); a box with any corner at or behind it is visible.
 * - Matrices are Babylon's layout (`Matrix.m`: clip = (x, y, z, 1) · M, translation in m[12..14]), read in doubles,
 *   so a camera far from the origin keeps its precision. Nothing allocates per frame.
 */

/** Which triangle winding, in screen space, faces the camera; "both" keeps every triangle. */
export type OcclusionWinding = "clockwise" | "counterClockwise" | "both";

export class OcclusionBuffer {
  readonly width: number;
  readonly height: number;
  /** Mip levels: level 0 is the buffer, each next one the max of 2 × 2 texels of the one before. */
  private readonly levels: Float32Array[] = [];
  private readonly levelWidths: number[] = [];
  private readonly levelHeights: number[] = [];
  /** The occluder being rasterised, before its erosion, and the texel rectangle it has written. */
  private readonly occluder: Float32Array;
  private occluderLeft = 0;
  private occluderRight = -1;
  private occluderTop = 0;
  private occluderBottom = -1;
  private readonly matrix = new Float64Array(16);
  private near = 0.1;
  private ready = false;
  // Scratch for one clipped triangle: up to four vertices of (screen x, screen y, w).
  private readonly clipped = new Float64Array(16 * 4);
  private readonly screen = new Float64Array(4 * 3);

  constructor(width = 256, height = 128) {
    if (!(width >= 1 && height >= 1)) throw new Error("An occlusion buffer needs a positive size.");
    this.width = width;
    this.height = height;
    this.occluder = new Float32Array(width * height).fill(Infinity);
    for (let w = width, h = height; ; w = Math.max(1, Math.ceil(w / 2)), h = Math.max(1, Math.ceil(h / 2))) {
      this.levels.push(new Float32Array(w * h));
      this.levelWidths.push(w);
      this.levelHeights.push(h);
      if (w === 1 && h === 1) break;
    }
  }

  /**
   * Starts a frame for the view-projection `viewProjection` (Babylon's layout, 16 numbers) and its near plane distance:
   * the buffer clears to nothing occluding.
   */
  begin(viewProjection: ArrayLike<number>, near: number): void {
    for (let index = 0; index < 16; index++) this.matrix[index] = viewProjection[index]!;
    this.near = Math.max(near, 1e-6);
    this.levels[0]!.fill(Infinity);
    this.ready = false;
  }

  /**
   * Rasterises one convex occluder's triangles: `positions` holds world x, y, z per vertex, `indices` three vertices per triangle
   * (every three positions when omitted). `transform`, when given, places the positions in the world first (Babylon's
   * layout). Triangles facing away by `winding` are skipped; a closed mesh's back faces never lower its front's depth.
   */
  rasterize(positions: ArrayLike<number>, indices?: ArrayLike<number>, transform?: ArrayLike<number>,
    winding: OcclusionWinding = "both"): void {
    const count = indices ? indices.length : positions.length / 3;
    for (let corner = 0; corner + 2 < count; corner += 3) {
      const a = indices ? indices[corner]! : corner, b = indices ? indices[corner + 1]! : corner + 1, c = indices ? indices[corner + 2]! : corner + 2;
      this.triangle(positions, a, b, c, transform, winding);
    }
    this.mergeOccluder();
  }

  /** Builds the pyramid; call after the last occluder and before the first test. */
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
    this.ready = true;
  }

  /**
   * Whether the world box [min, max] lies wholly behind the occluders: its screen rectangle, grown by a texel, is covered
   * at a depth nearer than its nearest corner by more than `epsilon`. A box with a corner at or behind the near plane,
   * or reaching past the buffer's edge, is visible.
   */
  occluded(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, epsilon = 1e-3): boolean {
    if (!this.ready) return false;
    const m = this.matrix;
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity, nearest = Infinity;
    for (let corner = 0; corner < 8; corner++) {
      const x = corner & 1 ? maxX : minX, y = corner & 2 ? maxY : minY, z = corner & 4 ? maxZ : minZ;
      const w = x * m[3]! + y * m[7]! + z * m[11]! + m[15]!;
      if (!(w > this.near)) return false;
      const sx = ((x * m[0]! + y * m[4]! + z * m[8]! + m[12]!) / w * 0.5 + 0.5) * this.width;
      const sy = (0.5 - (x * m[1]! + y * m[5]! + z * m[9]! + m[13]!) / w * 0.5) * this.height;
      if (sx < left) left = sx;
      if (sx > right) right = sx;
      if (sy < top) top = sy;
      if (sy > bottom) bottom = sy;
      if (w < nearest) nearest = w;
    }
    // The texels whose centres the rectangle can reach, grown by one.
    const x0 = Math.floor(left - 0.5) - 1, x1 = Math.ceil(right - 0.5) + 1;
    const y0 = Math.floor(top - 0.5) - 1, y1 = Math.ceil(bottom - 0.5) + 1;
    if (x0 < 0 || y0 < 0 || x1 >= this.width || y1 >= this.height) return false;
    let level = 0;
    while (level + 1 < this.levels.length && ((x1 >> level) - (x0 >> level) > 1 || (y1 >> level) - (y0 >> level) > 1)) level++;
    const data = this.levels[level]!, levelWidth = this.levelWidths[level]!;
    const limit = nearest - epsilon;
    for (let y = y0 >> level; y <= y1 >> level; y++)
      for (let x = x0 >> level; x <= x1 >> level; x++)
        if (!(data[y * levelWidth + x]! < limit)) return false;
    return true;
  }

  /** Erodes the occluder just rasterised into the buffer, nearer depth winning, and clears it for the next. */
  private mergeOccluder(): void {
    const { width, height, occluder } = this;
    const base = this.levels[0]!;
    // Erosion only shrinks coverage: texels outside the written rectangle stay uncovered.
    for (let y = this.occluderTop; y <= this.occluderBottom; y++) {
      for (let x = this.occluderLeft; x <= this.occluderRight; x++) {
        let depth = 0;
        for (let dy = -1; dy <= 1 && depth !== Infinity; dy++) {
          const row = y + dy;
          // Outside the buffer nothing is known to occlude.
          if (row < 0 || row >= height) { depth = Infinity; break; }
          for (let dx = -1; dx <= 1; dx++) {
            const column = x + dx;
            const value = column < 0 || column >= width ? Infinity : occluder[row * width + column]!;
            if (value > depth) depth = value;
          }
        }
        const index = y * width + x;
        if (depth < base[index]!) base[index] = depth;
      }
    }
    for (let y = this.occluderTop; y <= this.occluderBottom; y++)
      occluder.fill(Infinity, y * width + this.occluderLeft, y * width + this.occluderRight + 1);
    this.occluderLeft = this.occluderTop = 0;
    this.occluderRight = this.occluderBottom = -1;
  }

  /** The depth at texel (x, y) of level 0, for diagnostics and tests. */
  depthAt(x: number, y: number): number {
    return this.levels[0]![y * this.width + x]!;
  }

  private triangle(positions: ArrayLike<number>, a: number, b: number, c: number, transform: ArrayLike<number> | undefined,
    winding: OcclusionWinding): void {
    const m = this.matrix, out = this.clipped;
    // Clip-space x, y, w of the three corners (z is not needed: depth is w).
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
    // Clip against w ≥ near (Sutherland–Hodgman on one plane): up to four vertices.
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

  /** Writes `depth` into the texels whose centres lie inside screen triangle (a, b, c), where nearer. */
  private fill(a: number, b: number, c: number, depth: number, winding: OcclusionWinding): void {
    const s = this.screen;
    const ax = s[a * 3]!, ay = s[a * 3 + 1]!, bx = s[b * 3]!, by = s[b * 3 + 1]!, cx = s[c * 3]!, cy = s[c * 3 + 1]!;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area === 0 || !Number.isFinite(area)) return;
    // Screen y points down: a positive area is clockwise on screen.
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
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        // Inside (or on an edge of) the triangle by its three edge functions.
        if (sign * ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) < 0) continue;
        if (sign * ((cx - bx) * (py - by) - (cy - by) * (px - bx)) < 0) continue;
        if (sign * ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) < 0) continue;
        const index = y * width + x;
        if (depth < occluder[index]!) occluder[index] = depth;
      }
    }
  }
}
