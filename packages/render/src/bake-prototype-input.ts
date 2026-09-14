/** Deliberately restricted, world-space input for the browser transport proof. */
export type BakePrototypeColor = readonly [number, number, number];

export interface BakePrototypeMesh {
  /** Unindexed triangles with two-sided opaque transport. Winding defines receiver normals. */
  positions: Float32Array;
  /** Supplied atlas coordinates per vertex; absence means occluder/bounce surface only. */
  uv2?: Float32Array;
  material: {
    kind: "diffuse";
    albedo: BakePrototypeColor;
    emission?: BakePrototypeColor;
  };
}

export interface BakePrototypeInput {
  meshes: readonly BakePrototypeMesh[];
  lights: readonly {
    kind: "point";
    position: BakePrototypeColor;
    color: BakePrototypeColor;
    intensity: number;
  }[];
  /** Constant linear environment radiance. */
  environment?: BakePrototypeColor;
  size: number;
  samples: number;
  bounces: number;
  mode: "full" | "direct" | "indirect";
}

export interface BakeReceiverAtlas {
  positions: Float32Array;
  normals: Float32Array;
  coveredTexels: number;
  estimatedWorkingBytes: number;
}

const MAX_TRIANGLES = 512;
const MAX_SIZE = 128;
type Point = readonly [number, number];

function boundedInteger(value: number, minimum: number, maximum: number, name: string) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer in ${minimum}..${maximum}`);
  }
}

function onlyKeys(value: object, keys: readonly string[], name: string) {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error(`${name} contains an unsupported feature`);
  }
}

function color(value: readonly number[], name: string, maximum: number) {
  if (value.length !== 3 || value.some((v) => !Number.isFinite(v) || v < 0 || v > maximum)) {
    throw new Error(`${name} must contain three finite linear values in 0..${maximum}`);
  }
}

export function validateBakePrototypeInput(input: BakePrototypeInput): number {
  onlyKeys(input, ["meshes", "lights", "environment", "size", "samples", "bounces", "mode"], "Bake input");
  boundedInteger(input.size, 1, MAX_SIZE, "Atlas size");
  boundedInteger(input.samples, 1, 4096, "Samples");
  boundedInteger(input.bounces, 2, 8, "Bounces");
  if (!["full", "direct", "indirect"].includes(input.mode)) throw new Error("Unsupported bake mode");
  boundedInteger(input.meshes.length, 1, 128, "Mesh count");
  boundedInteger(input.lights.length, 0, 16, "Light count");
  let triangles = 0;
  for (const mesh of input.meshes) {
    onlyKeys(mesh, ["positions", "uv2", "material"], "Mesh");
    onlyKeys(mesh.material, ["kind", "albedo", "emission"], "Material");
    if (mesh.material.kind !== "diffuse") throw new Error("Only opaque constant diffuse materials are supported");
    color(mesh.material.albedo, "Albedo", 1);
    if (mesh.material.emission) color(mesh.material.emission, "Emission", 100);
    if (!(mesh.positions instanceof Float32Array) || mesh.positions.length % 9 !== 0 || mesh.positions.length === 0) {
      throw new Error("Positions must be unindexed Float32 triangles");
    }
    triangles += mesh.positions.length / 9;
    if (triangles > MAX_TRIANGLES) throw new Error(`Bake exceeds ${MAX_TRIANGLES} triangles`);
    if (mesh.positions.some((v) => !Number.isFinite(v) || Math.abs(v) > 100)) {
      throw new Error("Prototype positions must be finite and within 100 world units");
    }
    if (mesh.uv2 && (!(mesh.uv2 instanceof Float32Array) || mesh.uv2.length !== mesh.positions.length / 3 * 2
      || mesh.uv2.some((v) => !Number.isFinite(v) || v < 0 || v > 1))) {
      throw new Error("UV2 must supply finite atlas coordinates in 0..1 for every vertex");
    }
  }
  for (const light of input.lights) {
    onlyKeys(light, ["kind", "position", "color", "intensity"], "Light");
    if (light.kind !== "point") throw new Error("Only point lights are supported");
    if (light.position.length !== 3 || light.position.some((v) => !Number.isFinite(v) || Math.abs(v) > 100)) {
      throw new Error("Light position is outside the prototype bounds");
    }
    color(light.color, "Light color", 1);
    if (!Number.isFinite(light.intensity) || light.intensity < 0 || light.intensity > 100) {
      throw new Error("Light intensity must be in 0..100");
    }
  }
  if (input.environment) color(input.environment, "Environment", 100);
  // Conservative admission estimate, not a claim about measured driver allocation.
  return 16 * 1024 * 1024 + input.size ** 2 * 128 + triangles * 4096;
}

function cross(a: Point, b: Point, c: Point) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** Positive-area intersection rejects overlap even when no texel center lands in it. */
function overlap(a: readonly Point[], b: readonly Point[]): boolean {
  let polygon = [...a];
  const sign = Math.sign(cross(b[0], b[1], b[2]));
  for (let edge = 0; edge < 3 && polygon.length; edge++) {
    const start = b[edge], end = b[(edge + 1) % 3];
    const clipped: Point[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const current = polygon[i], next = polygon[(i + 1) % polygon.length];
      const d0 = sign * cross(start, end, current), d1 = sign * cross(start, end, next);
      if (d0 >= 0) clipped.push(current);
      if ((d0 >= 0) !== (d1 >= 0)) {
        const t = d0 / (d0 - d1);
        clipped.push([current[0] + t * (next[0] - current[0]), current[1] + t * (next[1] - current[1])]);
      }
    }
    polygon = clipped;
  }
  let area = 0;
  for (let i = 1; i + 1 < polygon.length; i++) area += Math.abs(cross(polygon[0], polygon[i], polygon[i + 1]));
  return area > 1e-12;
}

/** Checkpoints yield to the host, and must reject on cancellation/deadline. */
export async function rasterizeBakeReceivers(input: BakePrototypeInput, checkpoint: () => Promise<void>): Promise<BakeReceiverAtlas> {
  const estimatedWorkingBytes = validateBakePrototypeInput(input);
  const positions = new Float32Array(input.size ** 2 * 4);
  const normals = new Float32Array(positions.length);
  const previous: Point[][] = [];
  let coveredTexels = 0;
  for (const mesh of input.meshes) {
    for (let offset = 0; offset < mesh.positions.length; offset += 9) {
      await checkpoint();
      const p = mesh.positions;
      const ab = [p[offset + 3] - p[offset], p[offset + 4] - p[offset + 1], p[offset + 5] - p[offset + 2]];
      const ac = [p[offset + 6] - p[offset], p[offset + 7] - p[offset + 1], p[offset + 8] - p[offset + 2]];
      const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      const length = Math.hypot(...n);
      if (length < 1e-8) throw new Error("Degenerate world-space triangle");
      if (!mesh.uv2) continue;
      const uv = mesh.uv2, base = offset / 3 * 2;
      const triangle: Point[] = [[uv[base], uv[base + 1]], [uv[base + 2], uv[base + 3]], [uv[base + 4], uv[base + 5]]];
      const area = cross(triangle[0], triangle[1], triangle[2]);
      if (Math.abs(area) < 1e-12) throw new Error("Degenerate UV2 triangle");
      if (previous.some((other) => overlap(triangle, other))) throw new Error("UV2 atlas triangles overlap");
      previous.push(triangle);
      for (let y = 0; y < input.size; y++) {
        await checkpoint();
        for (let x = 0; x < input.size; x++) {
          const point: Point = [(x + 0.5) / input.size, (y + 0.5) / input.size];
          const a = cross(triangle[1], triangle[2], point) / area;
          const b = cross(triangle[2], triangle[0], point) / area;
          const c = 1 - a - b;
          if (Math.min(a, b, c) < -1e-10) continue;
          const pixel = (y * input.size + x) * 4;
          // Adjacent UV triangles can share a texel-center edge. Positive-area overlaps were rejected above.
          if (positions[pixel + 3]) continue;
          for (let axis = 0; axis < 3; axis++) {
            positions[pixel + axis] = a * p[offset + axis] + b * p[offset + 3 + axis] + c * p[offset + 6 + axis];
            normals[pixel + axis] = n[axis] / length;
          }
          positions[pixel + 3] = normals[pixel + 3] = 1;
          coveredTexels++;
        }
      }
    }
  }
  if (!coveredTexels) throw new Error("UV2 atlas has no covered texel centers");
  return { positions, normals, coveredTexels, estimatedWorkingBytes };
}
