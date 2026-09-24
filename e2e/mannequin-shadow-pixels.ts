import type { ShadowDiagnostics } from "../packages/render/src/shadow-diagnostics";
import type { mannequinShadowProbe } from "../apps/editor/src/testing/mannequin-shadow-proof";

type V = number[];
export type MannequinGeometry = Awaited<ReturnType<typeof mannequinShadowProbe>>;
const dot = (a: V, b: V) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const sub = (a: V, b: V) => a.map((v, i) => v - b[i]!);
const add = (a: V, b: V, scale: number) => a.map((v, i) => v + scale * b[i]!);
const cross = (a: V, b: V) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const unit = (v: V) => v.map(x => x / Math.hypot(...v));
const solve = (a: V, b: V, c: V, rhs: V) => {
  const determinant = dot(a, cross(b, c));
  if (Math.abs(determinant) < 1e-12) throw new Error("Degenerate pixel/receiver plane");
  return add(add(cross(b, c).map(v => v * rhs[0]!), cross(c, a), rhs[1]!), cross(a, b), rhs[2]!).map(v => v / determinant);
};
const transform = (point: V, matrix: V) => [0, 1, 2, 3].map(i => point[0]! * matrix[i]! + point[1]! * matrix[i + 4]! + point[2]! * matrix[i + 8]! + matrix[i + 12]!);

/** Reuse the imported vertex bytes with each host's actual posed world matrix. */
export function posedMannequin(geometry: MannequinGeometry, state: ShadowDiagnostics): MannequinGeometry {
  return geometry.map(part => {
    const matrix = state.models.find(mesh => mesh.name === part.name)?.worldMatrix as V | undefined;
    if (!matrix) throw new Error(`Missing runtime mannequin part ${part.name}`);
    const a = matrix.slice(0, 3), b = matrix.slice(4, 7), c = matrix.slice(8, 11);
    const determinant = dot(a, cross(b, c));
    return { ...part, vertices: part.vertices.map(vertex => ({
      ...vertex,
      position: transform(vertex.localPosition, matrix).slice(0, 3),
      normal: unit(add(add(cross(b, c).map(v => v * vertex.localNormal[0]!), cross(c, a), vertex.localNormal[1]!), cross(a, b), vertex.localNormal[2]!).map(v => v / determinant)),
    })) };
  });
}

/** Independent triangle/ray geometry oracle; no renderer shadow code is used. */
export function mannequinShadowSamples(geometry: MannequinGeometry, state: ShadowDiagnostics, width: number, height: number) {
  const triangles = geometry.flatMap(part => {
    const result = [];
    const indices = part.indices.length ? part.indices : part.vertices.map((_, i) => i);
    for (let i = 0; i < indices.length; i += 3) {
      const vertices = indices.slice(i, i + 3).map(index => part.vertices[index]!);
      result.push({ name: part.name, a: vertices[0]!.position, b: vertices[1]!.position, c: vertices[2]!.position, normal: vertices[0]!.normal });
    }
    return result;
  });
  const hit = (origin: V, direction: V, limit = Infinity) => {
    for (const tri of triangles) {
      const e1 = sub(tri.b, tri.a), e2 = sub(tri.c, tri.a);
      const p = cross(direction, e2), determinant = dot(e1, p);
      if (Math.abs(determinant) < 1e-10) continue;
      const relative = sub(origin, tri.a), u = dot(relative, p) / determinant;
      if (u < 0 || u > 1) continue;
      const q = cross(relative, e1), v = dot(direction, q) / determinant;
      if (v < 0 || u + v > 1) continue;
      const distance = dot(e2, q) / determinant;
      if (distance > 1e-5 && distance < limit - 1e-5) return true;
    }
    return false;
  };
  const sun = state.lights.find(light => light.type === "DirectionalLight")!;
  const toLight = unit(sun.worldDirection!.map(v => -v!));
  const camera = state.camera!.position as V;
  const matrix = state.camera!.viewProjection as V;
  const texel = sun.generator!.lastDrawBias[0]!.worldTexelSize;
  // Low is one hardware bilinear PCF tap. At this model scale the four
  // contributing texels can span an entire limb, so sparse world offsets are
  // not a valid lit/contact oracle. Intersect their exact centers with the face.
  const low = sun.generator!.cascades === 1 && sun.generator!.filter === "pcf" && sun.generator!.filteringQuality === 2;
  const shadowProjection = sun.generator!.projections[0]!;
  const shadowClip = (point: V) => transform(transform(point, shadowProjection.view as V), shadowProjection.matrix as V);
  const points = new Map<string, { x: number; y: number; region: string; worldPosition: number[]; expected: "lit" | "contact" | "edge" }>();
  for (const tri of triangles) {
    const incidence = dot(tri.normal, toLight);
    if (incidence <= 0.02 || dot(tri.normal, sub(camera, tri.a)) <= 0) continue;
    const tangent = unit(sub(tri.b, tri.a));
    const bitangent = unit(cross(tri.normal, tangent));
    // Classify interiors conservatively against the current filter footprint.
    // Boundary samples remain in the helper-on/off pixel comparison below.
    const radius = 2 * texel / incidence;
    for (let i = 0; i < 14; i++) for (let j = 0; j < 14 - i; j++) {
      const point = add(add(tri.a, sub(tri.b, tri.a), (i + 0.3) / 14), sub(tri.c, tri.a), (j + 0.3) / 14);
      const towardCamera = sub(camera, point);
      if (hit(point, unit(towardCamera), Math.hypot(...towardCamera))) continue;
      const w = point[0]! * matrix[3]! + point[1]! * matrix[7]! + point[2]! * matrix[11]! + matrix[15]!;
      const px = (point[0]! * matrix[0]! + point[1]! * matrix[4]! + point[2]! * matrix[8]! + matrix[12]!) / w;
      const py = (point[0]! * matrix[1]! + point[1]! * matrix[5]! + point[2]! * matrix[9]! + matrix[13]!) / w;
      const x = Math.floor((px * 0.5 + 0.5) * width), y = Math.floor((0.5 - py * 0.5) * height);
      if (w <= 0 || x < 0 || y < 0 || x >= width || y >= height) continue;
      // Classify the center of the pixel we actually read, not the nearby
      // barycentric seed (which can lie on another face or a foreground guide).
      const cx = (x + 0.5) / width * 2 - 1, cy = 1 - (y + 0.5) / height * 2;
      const center = solve(
        [matrix[0]! - cx * matrix[3]!, matrix[4]! - cx * matrix[7]!, matrix[8]! - cx * matrix[11]!],
        [matrix[1]! - cy * matrix[3]!, matrix[5]! - cy * matrix[7]!, matrix[9]! - cy * matrix[11]!],
        tri.normal, [cx * matrix[15]! - matrix[12]!, cy * matrix[15]! - matrix[13]!, dot(tri.normal, point)],
      );
      const toCamera = sub(camera, center);
      if (hit(center, unit(toCamera), Math.hypot(...toCamera))) continue;
      let blocked = 0;
      if (low) {
        const clip = shadowClip(center), a = sub(shadowClip(add(center, tangent, 1)), clip), b = sub(shadowClip(add(center, bitangent, 1)), clip);
        const map = sun.generator!.map!;
        const sx = (clip[0]! * 0.5 + 0.5) * map.width - 0.5, sy = (clip[1]! * 0.5 + 0.5) * map.height - 0.5;
        const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
        const determinant = a[0]! * b[1]! - a[1]! * b[0]!;
        for (const dx of [0, 1]) for (const dy of [0, 1]) {
          const u = (ix + dx + 0.5) / map.width * 2 - 1 - clip[0]!;
          const v = (iy + dy + 0.5) / map.height * 2 - 1 - clip[1]!;
          const receiver = add(add(center, tangent, (u * b[1]! - v * b[0]!) / determinant), bitangent, (a[0]! * v - a[1]! * u) / determinant);
          if (hit(receiver, toLight)) blocked += (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
        }
      } else {
        for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1])
          if (hit(add(add(center, tangent, radius * dx), bitangent, radius * dy), toLight)) blocked += 1 / 9;
      }
      points.set(`${x}:${y}`, { x, y, region: tri.name, worldPosition: center, expected: blocked < 1e-6 ? "lit" : blocked > 1 - 1e-6 ? "contact" : "edge" });
    }
  }
  return [...points.values()];
}

export function mannequinShadowMetrics(points: ReturnType<typeof mannequinShadowSamples>, authored: number[], modelOnly: number[], directOnly: number[], visible: boolean[] = points.map(() => true)) {
  const regions: Record<string, { samples: number; changed: number; lit: number; falseDark: number; contacts: number; retained: number; edges: number; changedEdges: number }> = {};
  points.forEach((point, index) => {
    const region = regions[point.region] ??= { samples: 0, changed: 0, lit: 0, falseDark: 0, contacts: 0, retained: 0, edges: 0, changedEdges: 0 };
    const at = index * 3;
    const reference = directOnly.slice(at, at + 3).reduce((a, b) => a + b, 0) / 3;
    const actual = authored.slice(at, at + 3).reduce((a, b) => a + b, 0) / 3;
    const difference = [0, 1, 2].some(channel => Math.abs(authored[at + channel]! - modelOnly[at + channel]!) > 3);
    region.samples++;
    if (difference) region.changed++;
    if (point.expected === "edge") { region.edges++; if (difference) region.changedEdges++; }
    if (!visible[index] || reference < 25) return; // Foreground helpers and authored black texture pixels contain no surface shadow signal.
    if (point.expected === "lit") { region.lit++; if (actual < reference * 0.85) region.falseDark++; }
    if (point.expected === "contact") { region.contacts++; if (actual < reference * 0.7) region.retained++; }
  });
  return regions;
}
