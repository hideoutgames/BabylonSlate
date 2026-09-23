import type { ShadowDiagnostics } from "../packages/render/src/shadow-diagnostics";
import type { mannequinShadowProbe } from "../apps/editor/src/testing/mannequin-shadow-proof";

type V = number[];
export type MannequinGeometry = Awaited<ReturnType<typeof mannequinShadowProbe>>;
const dot = (a: V, b: V) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const sub = (a: V, b: V) => a.map((v, i) => v - b[i]!);
const add = (a: V, b: V, scale: number) => a.map((v, i) => v + scale * b[i]!);
const cross = (a: V, b: V) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const unit = (v: V) => v.map(x => x / Math.hypot(...v));

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
      let blocked = 0;
      for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1])
        if (hit(add(add(point, tangent, radius * dx), bitangent, radius * dy), toLight)) blocked++;
      points.set(`${x}:${y}`, { x, y, region: tri.name, worldPosition: point, expected: blocked === 0 ? "lit" : blocked === 9 ? "contact" : "edge" });
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
