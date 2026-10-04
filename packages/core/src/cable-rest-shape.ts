/** Writable XYZ particle storage (Float32Array, Float64Array or number[]). */
export type CablePointBuffer = { [index: number]: number; readonly length: number };

/** Slack beyond this length/horizontal-span ratio uses two straight legs instead of cosh. */
const CATENARY_RATIO_LIMIT = 50;
/** Horizontal spans below this fraction of the length count as vertically aligned. */
const VERTICAL_SPAN = 1e-4;
/** Horizontal tilt of the fold for vertically aligned pins, so the legs stay distinct. */
const VERTICAL_FOLD_TILT = 0.05;

/**
 * Write the settled pose of a cable into `out` as `segments + 1` XYZ particles
 * spaced evenly along its length. Deterministic and allocation-free; shared by
 * the simulation start, teleport resets and static editor previews.
 *
 * - No pinned end, no acceleration, or taut pins: the straight authored line.
 * - One pinned end: hangs straight from that end along the acceleration.
 * - Two pinned ends with slack: a catenary in the plane of the pins and the
 *   acceleration. Vertically aligned pins or extreme slack fold into two
 *   straight legs meeting at the lowest point, which avoids cosh overflow and
 *   never leaves a collinear "rod" between vertical pins.
 */
export function writeCableRestShape(
  out: CablePointBuffer,
  start: ArrayLike<number>,
  end: ArrayLike<number>,
  length: number,
  acceleration: ArrayLike<number>,
  attachStart: boolean,
  attachEnd: boolean,
  segments: number,
): void {
  const count = Math.max(1, Math.floor(segments));
  const sx = start[0]!, sy = start[1]!, sz = start[2]!;
  const ex = end[0]!, ey = end[1]!, ez = end[2]!;
  const dx = ex - sx, dy = ey - sy, dz = ez - sz;
  const ax = acceleration[0]!, ay = acceleration[1]!, az = acceleration[2]!;
  const magnitude = Math.sqrt(ax * ax + ay * ay + az * az);
  if (!(magnitude > 1e-6) || !(length > 0) || (!attachStart && !attachEnd)) {
    writeLine(out, sx, sy, sz, dx, dy, dz, count);
    return;
  }
  // Unit sag direction (usually down).
  const gx = ax / magnitude, gy = ay / magnitude, gz = az / magnitude;
  const spacing = length / count;
  if (attachStart !== attachEnd) {
    const ox = attachStart ? sx : ex, oy = attachStart ? sy : ey, oz = attachStart ? sz : ez;
    for (let particle = 0; particle <= count; particle++) {
      const distance = (attachStart ? particle : count - particle) * spacing;
      const offset = particle * 3;
      out[offset] = ox + gx * distance;
      out[offset + 1] = oy + gy * distance;
      out[offset + 2] = oz + gz * distance;
    }
    return;
  }
  const separation = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (length <= separation * (1 + 1e-6)) {
    writeLine(out, sx, sy, sz, dx, dy, dz, count);
    return;
  }

  // Plane coordinates: x along the horizontal unit e, y along up (-g).
  const along = dx * gx + dy * gy + dz * gz;
  const rise = -along;
  let hx = dx - along * gx, hy = dy - along * gy, hz = dz - along * gz;
  let span = Math.sqrt(hx * hx + hy * hy + hz * hz);
  const vertical = span < length * VERTICAL_SPAN;
  if (vertical) {
    // Deterministic horizontal axis for vertically aligned pins.
    const rx = Math.abs(gx) < 0.9 ? 1 : 0, rz = rx === 1 ? 0 : 1;
    const dot = rx * gx + rz * gz;
    hx = rx - dot * gx; hy = -dot * gy; hz = rz - dot * gz;
    const size = Math.sqrt(hx * hx + hy * hy + hz * hz);
    hx /= size; hy /= size; hz /= size;
    span = 0;
  } else {
    hx /= span; hy /= span; hz /= span;
  }

  if (vertical || length > span * CATENARY_RATIO_LIMIT) {
    writeFold(out, sx, sy, sz, hx, hy, hz, gx, gy, gz, span, rise, length, count, vertical);
  } else {
    writeCatenary(out, sx, sy, sz, hx, hy, hz, gx, gy, gz, span, rise, length, count);
  }
  out[0] = sx; out[1] = sy; out[2] = sz;
  out[count * 3] = ex; out[count * 3 + 1] = ey; out[count * 3 + 2] = ez;
}

function writeLine(out: CablePointBuffer, sx: number, sy: number, sz: number, dx: number, dy: number, dz: number, count: number): void {
  for (let particle = 0; particle <= count; particle++) {
    const alpha = particle / count;
    const offset = particle * 3;
    out[offset] = sx + dx * alpha;
    out[offset + 1] = sy + dy * alpha;
    out[offset + 2] = sz + dz * alpha;
  }
}

/** Exact catenary through (0, 0) and (span, rise) with arc length `length`. */
function writeCatenary(
  out: CablePointBuffer, sx: number, sy: number, sz: number,
  hx: number, hy: number, hz: number, gx: number, gy: number, gz: number,
  span: number, rise: number, length: number, count: number,
): void {
  // sinh(z)/z = sqrt(L² - v²)/h, with z = h / 2a. The ratio limit bounds z below ~6.
  const ratio = Math.sqrt(length * length - rise * rise) / span;
  let low = 0, high = 1;
  while (high < 64 && Math.sinh(high) / high < ratio) high *= 2;
  for (let iteration = 0; iteration < 60; iteration++) {
    const middle = (low + high) * 0.5;
    if (Math.sinh(middle) / middle < ratio) low = middle; else high = middle;
  }
  const z = (low + high) * 0.5;
  const a = span / (2 * z);
  // Vertex offset from the start: xm = h/2 - a·atanh(v/L); arc parameter at x = 0.
  const vertex = span * 0.5 - a * Math.atanh(rise / length);
  const q0 = Math.sinh(-vertex / a);
  const root0 = Math.sqrt(1 + q0 * q0);
  const asinh0 = Math.asinh(q0);
  const spacing = length / count;
  for (let particle = 1; particle < count; particle++) {
    const s = particle * spacing;
    const q = q0 + s / a;
    const x = a * (Math.asinh(q) - asinh0);
    // a·(cosh(p) − cosh(p0)) in a form without cancellation for large a.
    const y = s * (2 * q0 + s / a) / (Math.sqrt(1 + q * q) + root0);
    const offset = particle * 3;
    out[offset] = sx + hx * x - gx * y;
    out[offset + 1] = sy + hy * x - gy * y;
    out[offset + 2] = sz + hz * x - gz * y;
  }
}

/** Two straight legs meeting at the lowest point of the ellipse whose foci are the pins. */
function writeFold(
  out: CablePointBuffer, sx: number, sy: number, sz: number,
  hx: number, hy: number, hz: number, gx: number, gy: number, gz: number,
  span: number, rise: number, length: number, count: number, vertical: boolean,
): void {
  const distance = Math.sqrt(span * span + rise * rise);
  const major = length * 0.5;
  const minor = Math.sqrt(Math.max(0, major * major - distance * distance * 0.25));
  const tx = distance > 1e-12 ? span / distance : 0, ty = distance > 1e-12 ? rise / distance : 1;
  const nx = -ty, ny = tx;
  let wx = 0, wy = -1;
  if (vertical) {
    const size = Math.sqrt(1 + VERTICAL_FOLD_TILT * VERTICAL_FOLD_TILT);
    wx = VERTICAL_FOLD_TILT / size; wy = -1 / size;
  }
  const tw = tx * wx + ty * wy, nw = nx * wx + ny * wy;
  const support = Math.sqrt(major * major * tw * tw + minor * minor * nw * nw);
  let bx = span * 0.5, by = rise * 0.5;
  if (support > 1e-12) {
    const cosine = major * tw / support, sine = minor * nw / support;
    bx += major * cosine * tx + minor * sine * nx;
    by += major * cosine * ty + minor * sine * ny;
  }
  const first = Math.sqrt(bx * bx + by * by);
  const second = Math.max(1e-12, Math.sqrt((span - bx) * (span - bx) + (rise - by) * (rise - by)));
  const spacing = length / count;
  for (let particle = 1; particle < count; particle++) {
    const s = particle * spacing;
    let x: number, y: number;
    if (s <= first && first > 1e-12) {
      const t = s / first;
      x = bx * t; y = by * t;
    } else {
      const t = Math.min(1, (s - first) / second);
      x = bx + (span - bx) * t; y = by + (rise - by) * t;
    }
    const offset = particle * 3;
    out[offset] = sx + hx * x - gx * y;
    out[offset + 1] = sy + hy * x - gy * y;
    out[offset + 2] = sz + hz * x - gz * y;
  }
}
