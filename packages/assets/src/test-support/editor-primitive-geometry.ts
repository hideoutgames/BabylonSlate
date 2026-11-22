/**
 * Indexed triangle meshes for the EditorPrimitives engine plugin, built in glTF space: right-handed, +Y up, the
 * front facing +Z, counter-clockwise outward winding and UV (0, 0) at a face's top left. Babylon's glTF loader
 * reflects X on load, so every shape is symmetric about X or only depends on Z for its orientation.
 */
export type Vec3 = readonly [number, number, number];

export interface PrimitiveMesh {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

/** A point on a surface of revolution's profile: `radius` from the Y axis at height `y`, normal `(nr, ny)` in that plane. */
interface ProfilePoint {
  y: number;
  radius: number;
  nr: number;
  ny: number;
  /** Texture V at this point, 0 at the profile's start. */
  v: number;
}

/** Below this triangle area (squared, doubled) a triangle is a pole or seam sliver and is left out. */
const MIN_DOUBLE_AREA_SQ = 1e-18;

/** Rounded so the committed bytes do not depend on the last bits of a platform's `Math.sin`. */
function round(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6;
  return rounded === 0 ? 0 : rounded;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(a: Vec3): Vec3 {
  const length = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / length, a[1] / length, a[2] / length];
}

class MeshWriter {
  readonly mesh: PrimitiveMesh = { positions: [], normals: [], uvs: [], indices: [] };

  vertex(position: Vec3, normal: Vec3, uv: readonly [number, number]): number {
    this.mesh.positions.push(round(position[0]), round(position[1]), round(position[2]));
    this.mesh.normals.push(round(normal[0]), round(normal[1]), round(normal[2]));
    this.mesh.uvs.push(round(uv[0]), round(uv[1]));
    return this.mesh.positions.length / 3 - 1;
  }

  private position(index: number): Vec3 {
    const p = this.mesh.positions;
    return [p[index * 3]!, p[index * 3 + 1]!, p[index * 3 + 2]!];
  }

  private normal(index: number): Vec3 {
    const n = this.mesh.normals;
    return [n[index * 3]!, n[index * 3 + 1]!, n[index * 3 + 2]!];
  }

  /** Adds the triangle wound so its face points the way its vertex normals do; slivers are skipped. */
  triangle(a: number, b: number, c: number): void {
    const pa = this.position(a);
    const face = cross(sub(this.position(b), pa), sub(this.position(c), pa));
    if (dot(face, face) < MIN_DOUBLE_AREA_SQ) return;
    const normal = this.normal(a);
    const nb = this.normal(b);
    const nc = this.normal(c);
    const summed: Vec3 = [normal[0] + nb[0] + nc[0], normal[1] + nb[1] + nc[1], normal[2] + nb[2] + nc[2]];
    if (dot(face, summed) >= 0) this.mesh.indices.push(a, b, c);
    else this.mesh.indices.push(a, c, b);
  }

  /** `columns` × `rows` cells over a vertex grid indexed `row * (columns + 1) + column`. */
  gridTriangles(first: number, columns: number, rows: number): void {
    const stride = columns + 1;
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const a = first + row * stride + column;
        const b = a + 1;
        const c = b + stride;
        const d = a + stride;
        this.triangle(a, b, c);
        this.triangle(a, c, d);
      }
    }
  }

  /**
   * A flat rectangle seen from outside with `right` and `up` (unit, `right × up` is the normal), split into
   * `columns` × `rows` quads, UV (0, 0) at the top left.
   */
  rectangle(center: Vec3, right: Vec3, up: Vec3, halfWidth: number, halfHeight: number, columns = 1, rows = 1): void {
    const normal = cross(right, up);
    const first = this.mesh.positions.length / 3;
    for (let row = 0; row <= rows; row++) {
      const v = row / rows;
      const along = halfHeight - v * 2 * halfHeight;
      for (let column = 0; column <= columns; column++) {
        const u = column / columns;
        const across = -halfWidth + u * 2 * halfWidth;
        this.vertex(
          [
            center[0] + right[0] * across + up[0] * along,
            center[1] + right[1] * across + up[1] * along,
            center[2] + right[2] * across + up[2] * along,
          ],
          normal,
          [u, v],
        );
      }
    }
    this.gridTriangles(first, columns, rows);
  }

  /**
   * A flat convex polygon with one normal, fanned from its first corner. UVs project onto the face's own right and
   * up axes (world up where the face is not horizontal) and fill 0..1 over the polygon's extent.
   */
  polygon(corners: readonly Vec3[], outward: Vec3): void {
    const normal = normalize(outward);
    const worldUp: Vec3 = Math.abs(normal[1]) > 0.999 ? [0, 0, -Math.sign(normal[1])] : [0, 1, 0];
    const right = normalize(cross(worldUp, normal));
    const up = cross(normal, right);
    const projected = corners.map((corner) => [dot(corner, right), dot(corner, up)] as const);
    const minU = Math.min(...projected.map(([u]) => u));
    const maxU = Math.max(...projected.map(([u]) => u));
    const minV = Math.min(...projected.map(([, v]) => v));
    const maxV = Math.max(...projected.map(([, v]) => v));
    const first = this.mesh.positions.length / 3;
    corners.forEach((corner, index) => {
      const [u, v] = projected[index]!;
      this.vertex(corner, normal, [(u - minU) / (maxU - minU), (maxV - v) / (maxV - minV)]);
    });
    for (let index = 1; index < corners.length - 1; index++) {
      this.triangle(first, first + index, first + index + 1);
    }
  }

  /**
   * Sweeps a profile around +Y with `segments` columns. U runs once around from the front (+Z), increasing to the
   * right seen from outside, with the seam vertices duplicated; V comes from the profile.
   */
  revolve(profile: readonly ProfilePoint[], segments: number): void {
    const first = this.mesh.positions.length / 3;
    for (const point of profile) {
      for (let segment = 0; segment <= segments; segment++) {
        const u = segment / segments;
        const angle = u * Math.PI * 2;
        const sin = Math.sin(angle);
        const cos = Math.cos(angle);
        this.vertex(
          [point.radius * sin, point.y, point.radius * cos],
          [point.nr * sin, point.ny, point.nr * cos],
          [u, point.v],
        );
      }
    }
    this.gridTriangles(first, segments, profile.length - 1);
  }

  /** A flat disc at height `y` facing up (+Y) or down (-Y), fanned from its centre; UV maps it as a top or bottom view. */
  disc(y: number, radius: number, segments: number, facing: 1 | -1): void {
    const normal: Vec3 = [0, facing, 0];
    const center = this.vertex([0, y, 0], normal, [0.5, 0.5]);
    for (let segment = 0; segment < segments; segment++) {
      const angle = (segment / segments) * Math.PI * 2;
      const x = radius * Math.sin(angle);
      const z = radius * Math.cos(angle);
      // Seen from above, -Z is the top of the texture; seen from below, +Z is.
      this.vertex([x, y, z], normal, [0.5 + x / (2 * radius), 0.5 + (facing * z) / (2 * radius)]);
    }
    for (let segment = 0; segment < segments; segment++) {
      this.triangle(center, center + 1 + segment, center + 1 + ((segment + 1) % segments));
    }
  }
}

/** Profile points of a circular arc around `(0, centerY)` from polar angle `from` to `to` (0 is straight up). */
function arc(centerY: number, radius: number, from: number, to: number, steps: number, startV: number, endV: number): ProfilePoint[] {
  const points: ProfilePoint[] = [];
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    const angle = from + (to - from) * t;
    const nr = Math.sin(angle);
    const ny = Math.cos(angle);
    points.push({ y: centerY + radius * ny, radius: radius * nr, nr, ny, v: startV + (endV - startV) * t });
  }
  return points;
}

/** Round shapes go once around in this many columns. */
export const PRIMITIVE_ROUND_SEGMENTS = 32;
/** Rows from pole to pole of the Sphere, and from pole to equator of the Capsule's and Hemisphere's caps. */
export const PRIMITIVE_SPHERE_RINGS = 16;
/** Quads along each side of the Subdivided Plane. */
export const SUBDIVIDED_PLANE_QUADS = 64;

/** 1 × 1 × 1, centred, each face its own four vertices. */
export function cubeMesh(): PrimitiveMesh {
  const writer = new MeshWriter();
  const h = 0.5;
  writer.rectangle([0, 0, h], [1, 0, 0], [0, 1, 0], h, h);
  writer.rectangle([0, 0, -h], [-1, 0, 0], [0, 1, 0], h, h);
  writer.rectangle([h, 0, 0], [0, 0, -1], [0, 1, 0], h, h);
  writer.rectangle([-h, 0, 0], [0, 0, 1], [0, 1, 0], h, h);
  writer.rectangle([0, h, 0], [1, 0, 0], [0, 0, -1], h, h);
  writer.rectangle([0, -h, 0], [1, 0, 0], [0, 0, 1], h, h);
  return writer.mesh;
}

/** UV sphere, diameter 1, centred. */
export function sphereMesh(): PrimitiveMesh {
  const writer = new MeshWriter();
  writer.revolve(arc(0, 0.5, 0, Math.PI, PRIMITIVE_SPHERE_RINGS, 0, 1), PRIMITIVE_ROUND_SEGMENTS);
  return writer.mesh;
}

/** The upper half of a diameter 1 sphere centred on the origin, closed by a flat base at y = 0. */
export function hemisphereMesh(): PrimitiveMesh {
  const writer = new MeshWriter();
  writer.revolve(arc(0, 0.5, 0, Math.PI / 2, PRIMITIVE_SPHERE_RINGS / 2, 0, 1), PRIMITIVE_ROUND_SEGMENTS);
  writer.disc(0, 0.5, PRIMITIVE_ROUND_SEGMENTS, -1);
  return writer.mesh;
}

/** Diameter 1, height 1, centred, with flat caps. */
export function cylinderMesh(): PrimitiveMesh {
  const writer = new MeshWriter();
  writer.revolve(
    [
      { y: 0.5, radius: 0.5, nr: 1, ny: 0, v: 0 },
      { y: -0.5, radius: 0.5, nr: 1, ny: 0, v: 1 },
    ],
    PRIMITIVE_ROUND_SEGMENTS,
  );
  writer.disc(0.5, 0.5, PRIMITIVE_ROUND_SEGMENTS, 1);
  writer.disc(-0.5, 0.5, PRIMITIVE_ROUND_SEGMENTS, -1);
  return writer.mesh;
}

/** Base diameter 1, height 1, centred, apex up. */
export function coneMesh(): PrimitiveMesh {
  const writer = new MeshWriter();
  const radius = 0.5;
  const height = 1;
  const slant = Math.hypot(radius, height);
  const nr = height / slant;
  const ny = radius / slant;
  writer.revolve(
    [
      { y: 0.5, radius: 0, nr, ny, v: 0 },
      { y: -0.5, radius, nr, ny, v: 1 },
    ],
    PRIMITIVE_ROUND_SEGMENTS,
  );
  writer.disc(-0.5, radius, PRIMITIVE_ROUND_SEGMENTS, -1);
  return writer.mesh;
}

/** Diameter 1, height 2, centred: a height 1 cylinder between two hemispheres. */
export function capsuleMesh(): PrimitiveMesh {
  const writer = new MeshWriter();
  const radius = 0.5;
  const halfLength = 0.5;
  const capArc = (Math.PI / 2) * radius;
  const total = 2 * capArc + 2 * halfLength;
  const rings = PRIMITIVE_SPHERE_RINGS / 2;
  writer.revolve(
    [
      ...arc(halfLength, radius, 0, Math.PI / 2, rings, 0, capArc / total),
      ...arc(-halfLength, radius, Math.PI / 2, Math.PI, rings, (capArc + 2 * halfLength) / total, 1),
    ],
    PRIMITIVE_ROUND_SEGMENTS,
  );
  return writer.mesh;
}

/** Ring lying flat, outer diameter 1, tube diameter 0.3, centred. */
export function torusMesh(): PrimitiveMesh {
  const writer = new MeshWriter();
  const ringRadius = 0.35;
  const tubeRadius = 0.15;
  const rows = 12;
  const profile: ProfilePoint[] = [];
  for (let row = 0; row <= rows; row++) {
    const v = row / rows;
    // From the outer equator, over the top, through the hole and back underneath.
    const angle = v * Math.PI * 2;
    const nr = Math.cos(angle);
    const ny = Math.sin(angle);
    profile.push({ y: tubeRadius * ny, radius: ringRadius + tubeRadius * nr, nr, ny, v });
  }
  writer.revolve(profile, PRIMITIVE_ROUND_SEGMENTS);
  return writer.mesh;
}

/** Open pipe: outer diameter 1, inner diameter 0.5, height 1, centred. */
export function tubeMesh(): PrimitiveMesh {
  const writer = new MeshWriter();
  const outer = 0.5;
  const inner = 0.25;
  writer.revolve(
    [
      { y: 0.5, radius: outer, nr: 1, ny: 0, v: 0 },
      { y: -0.5, radius: outer, nr: 1, ny: 0, v: 1 },
    ],
    PRIMITIVE_ROUND_SEGMENTS,
  );
  writer.revolve(
    [
      { y: 0.5, radius: inner, nr: -1, ny: 0, v: 0 },
      { y: -0.5, radius: inner, nr: -1, ny: 0, v: 1 },
    ],
    PRIMITIVE_ROUND_SEGMENTS,
  );
  writer.revolve(
    [
      { y: 0.5, radius: inner, nr: 0, ny: 1, v: 0 },
      { y: 0.5, radius: outer, nr: 0, ny: 1, v: 1 },
    ],
    PRIMITIVE_ROUND_SEGMENTS,
  );
  writer.revolve(
    [
      { y: -0.5, radius: inner, nr: 0, ny: -1, v: 0 },
      { y: -0.5, radius: outer, nr: 0, ny: -1, v: 1 },
    ],
    PRIMITIVE_ROUND_SEGMENTS,
  );
  return writer.mesh;
}

/** Square base 1 × 1, height 1, centred, apex up; flat shaded. */
export function pyramidMesh(): PrimitiveMesh {
  const writer = new MeshWriter();
  const apex: Vec3 = [0, 0.5, 0];
  const frontLeft: Vec3 = [-0.5, -0.5, 0.5];
  const frontRight: Vec3 = [0.5, -0.5, 0.5];
  const backRight: Vec3 = [0.5, -0.5, -0.5];
  const backLeft: Vec3 = [-0.5, -0.5, -0.5];
  writer.polygon([apex, frontLeft, frontRight], [0, 0.5, 1]);
  writer.polygon([apex, frontRight, backRight], [1, 0.5, 0]);
  writer.polygon([apex, backRight, backLeft], [0, 0.5, -1]);
  writer.polygon([apex, backLeft, frontLeft], [-1, 0.5, 0]);
  writer.polygon([frontLeft, backLeft, backRight, frontRight], [0, -1, 0]);
  return writer.mesh;
}

/** 1 × 1 × 1 ramp, centred, rising towards +Z (an actor's forward); flat shaded. */
export function wedgeMesh(): PrimitiveMesh {
  const writer = new MeshWriter();
  const h = 0.5;
  const lowLeft: Vec3 = [-h, -h, -h];
  const lowRight: Vec3 = [h, -h, -h];
  const highBottomLeft: Vec3 = [-h, -h, h];
  const highBottomRight: Vec3 = [h, -h, h];
  const highTopLeft: Vec3 = [-h, h, h];
  const highTopRight: Vec3 = [h, h, h];
  writer.polygon([lowLeft, lowRight, highTopRight, highTopLeft], [0, 1, -1]);
  writer.polygon([highBottomLeft, highBottomRight, highTopRight, highTopLeft], [0, 0, 1]);
  writer.polygon([lowLeft, lowRight, highBottomRight, highBottomLeft], [0, -1, 0]);
  writer.polygon([lowRight, highBottomRight, highTopRight], [1, 0, 0]);
  writer.polygon([lowLeft, highBottomLeft, highTopLeft], [-1, 0, 0]);
  return writer.mesh;
}

/** 1 × 1 at y = 0 facing up, `quads` × `quads` quads. */
export function planeMesh(quads = 1): PrimitiveMesh {
  const writer = new MeshWriter();
  writer.rectangle([0, 0, 0], [1, 0, 0], [0, 0, -1], 0.5, 0.5, quads, quads);
  return writer.mesh;
}

/** Diameter 1 at y = 0 facing up. */
export function discMesh(): PrimitiveMesh {
  const writer = new MeshWriter();
  writer.disc(0, 0.5, PRIMITIVE_ROUND_SEGMENTS, 1);
  return writer.mesh;
}
