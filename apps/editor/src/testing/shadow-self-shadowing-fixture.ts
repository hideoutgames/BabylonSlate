/** Numeric synthetic fixture and independent visibility oracle shared by GPU and host tests. */
export type ShadowTriple = [number, number, number];
export type ShadowBox = {
  name: string;
  center: ShadowTriple;
  size: ShadowTriple;
};
export const SHADOW_CAMERA_POSITION: ShadowTriple = [-5, 4.2, -7];
export const SHADOW_CAMERA_TARGET: ShadowTriple = [0, 1.9, 0];
export const SHADOW_CAMERA_FOV = 0.62;
export const SHADOW_LIGHT_DIRECTION: ShadowTriple = [0.7, -1, 0.5];
export const SHADOW_BOXES: ShadowBox[] = [
  { name: "head", center: [0, 3.55, 0], size: [1.6, 1.1, 1.25] },
  { name: "torso", center: [0, 2.25, 0], size: [1.15, 1.5, 0.7] },
  { name: "left-arm", center: [-0.8, 2.2, 0], size: [0.45, 1.6, 0.7] },
  { name: "right-arm", center: [0.8, 2.2, 0], size: [0.45, 1.6, 0.7] },
  { name: "left-leg", center: [-0.325, 0.75, 0], size: [0.5, 1.5, 0.65] },
  { name: "right-leg", center: [0.325, 0.75, 0], size: [0.5, 1.5, 0.65] },
];

const dot = (a: ShadowTriple, b: ShadowTriple) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const subtract = (a: ShadowTriple, b: ShadowTriple): ShadowTriple => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
const addScaled = (
  a: ShadowTriple,
  b: ShadowTriple,
  s: number,
): ShadowTriple => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export function shadowNormalize(v: ShadowTriple): ShadowTriple {
  const scale = 1 / Math.sqrt(dot(v, v));
  return [v[0] * scale, v[1] * scale, v[2] * scale];
}

function blocker(
  point: ShadowTriple,
  direction: ShadowTriple,
  maxDistance: number,
  boxes: readonly ShadowBox[],
  ownSurface: string,
) {
  let nearest: { name: string; distance: number } | null = null;
  for (const box of boxes) {
    if (box.name === ownSurface) continue;
    let near = -Infinity;
    let far = Infinity;
    for (let axis = 0; axis < 3; axis++) {
      const origin = point[axis]!;
      const ray = direction[axis]!;
      const minimum = box.center[axis]! - box.size[axis]! / 2;
      const maximum = box.center[axis]! + box.size[axis]! / 2;
      if (Math.abs(ray) < 1e-8) {
        if (origin < minimum || origin > maximum) far = -Infinity;
      } else {
        const a = (minimum - origin) / ray;
        const b = (maximum - origin) / ray;
        near = Math.max(near, Math.min(a, b));
        far = Math.min(far, Math.max(a, b));
      }
    }
    // A ground point beneath a foot starts on its closed bottom boundary;
    // overlapping geometry may contain the origin. Both are occluded. Only
    // the explicitly sampled box can be ignored, never all near-zero hits.
    const distance = Math.max(0, near);
    if (
      far > 1e-4 &&
      far >= near &&
      distance < maxDistance &&
      (!nearest || distance < nearest.distance)
    )
      nearest = { name: box.name, distance };
  }
  return nearest;
}

export type ShadowSurfaceSample = {
  region: string;
  expected: "lit" | "contact";
  x: number;
  y: number;
};
/** Matches Babylon's viewport projection, with top-left pixel coordinates. */
export function shadowSurfaceSamples(
  camera: ShadowTriple,
  viewProjection: readonly number[],
  toLight: ShadowTriple,
  width: number,
  height: number,
  viewport = { x: 0, y: 0, width: 1, height: 1 },
  boxes: readonly ShadowBox[] = SHADOW_BOXES,
): ShadowSurfaceSample[] {
  const result: ShadowSurfaceSample[] = [];
  const add = (
    point: ShadowTriple,
    normal: ShadowTriple,
    tangentA: ShadowTriple,
    tangentB: ShadowTriple,
    region: string,
  ) => {
    if (dot(normal, toLight) < 0.2) return;
    const toCamera = subtract(camera, point);
    if (
      dot(normal, toCamera) <= 0 ||
      blocker(
        point,
        shadowNormalize(toCamera),
        Math.sqrt(dot(toCamera, toCamera)),
        boxes,
        region,
      )
    )
      return;
    const hit = blocker(point, toLight, Infinity, boxes, region);
    for (const tangent of [tangentA, tangentB])
      for (const sign of [-1, 1])
        if (
          Boolean(
            blocker(
              addScaled(point, tangent, 0.12 * sign),
              toLight,
              Infinity,
              boxes,
              region,
            ),
          ) !== Boolean(hit)
        )
          return;
    if (hit && hit.distance > 1.2) return;
    const m = viewProjection;
    const w = point[0] * m[3]! + point[1] * m[7]! + point[2] * m[11]! + m[15]!;
    if (!(w > 0)) return;
    const clipX =
      (point[0] * m[0]! + point[1] * m[4]! + point[2] * m[8]! + m[12]!) / w;
    const clipY =
      (point[0] * m[1]! + point[1] * m[5]! + point[2] * m[9]! + m[13]!) / w;
    const x = Math.round(
      (viewport.x + ((1 + clipX) * viewport.width) / 2) * width,
    );
    const y = Math.round(
      (viewport.y + ((1 - clipY) * viewport.height) / 2) * height,
    );
    if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) return;
    result.push({
      region:
        region === "ground" && hit?.name === "thin-slab"
          ? "thin-contact-ground"
          : region,
      expected: hit ? "contact" : "lit",
      x,
      y,
    });
  };
  for (const box of boxes) {
    for (const axis of [0, 1, 2]) {
      const a = (axis + 1) % 3,
        b = (axis + 2) % 3;
      for (const side of [-1, 1]) {
        const normal: ShadowTriple = [0, 0, 0],
          ta: ShadowTriple = [0, 0, 0],
          tb: ShadowTriple = [0, 0, 0];
        normal[axis] = side;
        ta[a] = 1;
        tb[b] = 1;
        for (let u = -0.4; u <= 0.401; u += 0.08)
          for (let v = -0.4; v <= 0.401; v += 0.08) {
            const point: ShadowTriple = [...box.center];
            point[axis] = box.center[axis]! + (side * box.size[axis]!) / 2;
            point[a] = box.center[a]! + u * box.size[a]!;
            point[b] = box.center[b]! + v * box.size[b]!;
            add(point, normal, ta, tb, box.name);
          }
      }
    }
  }
  for (let x = -1.8; x <= 1.8; x += 0.08)
    for (let z = -1.2; z <= 1.8; z += 0.08)
      add([x, 0, z], [0, 1, 0], [1, 0, 0], [0, 0, 1], "ground");
  return result;
}

export function shadowRegions(
  reference: readonly number[],
  shadowed: readonly number[],
  points: readonly ShadowSurfaceSample[],
  width: number,
) {
  const result: Record<
    string,
    { lit: number; falseDark: number; contact: number; retainedContact: number }
  > = {};
  for (const sample of points) {
    const offset = (sample.y * width + sample.x) * 4;
    const before = reference[offset + 1]!;
    if (before < 40) continue;
    const value = (result[sample.region] ??= {
      lit: 0,
      falseDark: 0,
      contact: 0,
      retainedContact: 0,
    });
    const ratio = shadowed[offset + 1]! / before;
    if (sample.expected === "lit") {
      value.lit++;
      if (ratio < 0.85) value.falseDark++;
    } else {
      value.contact++;
      if (ratio < 0.85) value.retainedContact++;
    }
  }
  return result;
}
