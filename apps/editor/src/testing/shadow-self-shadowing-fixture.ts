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
  expected: "lit" | "contact" | "penumbra";
  x: number;
  y: number;
  idealBlockedWeight?: number;
};

/** Ordinary directional PCF only; cascade selection/blending is not modeled. */
export type ShadowPcfProjection = {
  kind: "directional-single-pcf";
  view: readonly number[];
  projection: readonly number[];
  width: number;
  height: number;
  quality?: "low" | "medium" | "high";
};

/** Intersect an image pixel center with one axis-aligned fixture face. */
function pixelOnFace(
  x: number,
  y: number,
  width: number,
  height: number,
  viewport: { x: number; y: number; width: number; height: number },
  m: readonly number[],
  normal: ShadowTriple,
  facePoint: ShadowTriple,
): ShadowTriple | null {
  const axis = normal.findIndex((value) => Math.abs(value) > 0.5);
  if (axis < 0) return null;
  const a = (axis + 1) % 3;
  const b = (axis + 2) % 3;
  const u = (((x + 0.5) / width - viewport.x) / viewport.width) * 2 - 1;
  const v = 1 - (((y + 0.5) / height - viewport.y) / viewport.height) * 2;
  const horizontal = [0, 1, 2].map((j) => m[j * 4]! - u * m[j * 4 + 3]!);
  const vertical = [0, 1, 2].map((j) => m[j * 4 + 1]! - v * m[j * 4 + 3]!);
  const e = u * m[15]! - m[12]! - horizontal[axis]! * facePoint[axis]!;
  const f = v * m[15]! - m[13]! - vertical[axis]! * facePoint[axis]!;
  const determinant =
    horizontal[a]! * vertical[b]! - horizontal[b]! * vertical[a]!;
  if (Math.abs(determinant) < 1e-12) return null;
  const point: ShadowTriple = [...facePoint];
  point[a] = (e * vertical[b]! - horizontal[b]! * f) / determinant;
  point[b] = (horizontal[a]! * f - e * vertical[a]!) / determinant;
  const w = point[0] * m[3]! + point[1] * m[7]! + point[2] * m[11]! + m[15]!;
  return w > 0 && point.every(Number.isFinite) ? point : null;
}

function pcfFootprint(
  filter: ShadowPcfProjection | undefined,
  toLight: ShadowTriple,
  boxes: readonly ShadowBox[],
) {
  if (!filter) return undefined;
  if (
    filter.kind !== "directional-single-pcf" ||
    !Number.isInteger(filter.width) ||
    filter.width <= 0 ||
    !Number.isInteger(filter.height) ||
    filter.height <= 0 ||
    filter.view.length !== 16 ||
    filter.projection.length !== 16 ||
    ![...filter.view, ...filter.projection].every(Number.isFinite) ||
    [3, 7, 11].some(
      (index) =>
        Math.abs(filter.projection[index]!) > 1e-8 ||
        Math.abs(filter.view[index]!) > 1e-8,
    ) ||
    Math.abs(filter.view[15]! - 1) > 1e-8 ||
    Math.abs(filter.projection[15]! - 1) > 1e-8
  )
    throw new Error(
      "PCF oracle requires the actual orthographic single-map projection",
    );
  const transform = (point: readonly number[], matrix: readonly number[]) =>
    [0, 1, 2, 3].map(
      (i) =>
        point[0]! * matrix[i]! +
        point[1]! * matrix[i + 4]! +
        point[2]! * matrix[i + 8]! +
        matrix[i + 12]!,
    );
  const project = (point: ShadowTriple) => {
    const clip = transform(transform(point, filter.view), filter.projection);
    return clip.map((value) => value / clip[3]!);
  };
  const origin = project([0, 0, 0]);
  const basis = (
    [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ] as ShadowTriple[]
  ).map((point) =>
    project(point).map((value, index) => value - origin[index]!),
  );
  return (point: ShadowTriple, normal: ShadowTriple, ownSurface: string) => {
    const axis = normal.findIndex((value) => Math.abs(value) > 0.5);
    if (axis < 0) return undefined;
    const a = (axis + 1) % 3;
    const b = (axis + 2) % 3;
    const determinant =
      basis[a]![0]! * basis[b]![1]! - basis[b]![0]! * basis[a]![1]!;
    if (Math.abs(determinant) < 1e-12) return undefined;
    const clip = project(point);
    const u = clip[0]! * 0.5 + 0.5;
    const v = clip[1]! * 0.5 + 0.5;
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
    const x = u * filter.width - 0.5;
    const y = v * filter.height - 0.5;
    const ix = Math.floor(x),
      iy = Math.floor(y);
    const fx = x - ix,
      fy = y - iy;
    let blocked = 0;
    // Expanded separable tent weights of Babylon's optimized bilinear taps.
    // Low has two texels per axis; Medium and High have four and six. These
    // weights describe ideal geometric visibility, independently of our bias.
    const weights = (phase: number): readonly (readonly [number, number])[] => {
      if (filter.quality === "high")
        return [[-2, (1 - phase) / 12], [-1, (3 - 2 * phase) / 12],
          [0, (4 - phase) / 12], [1, (3 + phase) / 12],
          [2, (1 + 2 * phase) / 12], [3, phase / 12]];
      if (filter.quality === "medium")
        return [[-1, (1 - phase) / 4], [0, (2 - phase) / 4],
          [1, (1 + phase) / 4], [2, phase / 4]];
      return [[0, 1 - phase], [1, phase]];
    };
    // Intersect each center ray with the receiver plane, then independently ask
    // whether authored box geometry occludes it. No rendered depths or shader
    // bias are used: this models ideal filtered coverage, including penumbra.
    for (const [dx, wx] of weights(fx))
      for (const [dy, wy] of weights(fy)) {
        const weight = wx * wy;
        const tx = Math.max(0, Math.min(filter.width - 1, ix + dx));
        const ty = Math.max(0, Math.min(filter.height - 1, iy + dy));
        const e =
          ((tx + 0.5) / filter.width) * 2 -
          1 -
          origin[0]! -
          basis[axis]![0]! * point[axis]!;
        const f =
          ((ty + 0.5) / filter.height) * 2 -
          1 -
          origin[1]! -
          basis[axis]![1]! * point[axis]!;
        const receiver: ShadowTriple = [...point];
        receiver[a] = (e * basis[b]![1]! - basis[b]![0]! * f) / determinant;
        receiver[b] = (basis[a]![0]! * f - e * basis[a]![1]!) / determinant;
        if (blocker(receiver, toLight, Infinity, boxes, ownSurface))
          blocked += weight;
      }
    return Math.max(0, Math.min(1, blocked));
  };
}

function filteredExpectation(weight: number): ShadowSurfaceSample["expected"] {
  if (weight <= 1e-6) return "lit";
  // Three quarters of ideal filter support is a stable contact interior.
  // Intermediate support is legitimate penumbra, not a darkness failure.
  return weight >= 0.75 ? "contact" : "penumbra";
}
/** Matches Babylon's viewport projection, with top-left pixel coordinates. */
export function shadowSurfaceSamples(
  camera: ShadowTriple,
  viewProjection: readonly number[],
  toLight: ShadowTriple,
  width: number,
  height: number,
  viewport = { x: 0, y: 0, width: 1, height: 1 },
  boxes: readonly ShadowBox[] = SHADOW_BOXES,
  filter?: ShadowPcfProjection,
): ShadowSurfaceSample[] {
  const result: ShadowSurfaceSample[] = [];
  const footprint = pcfFootprint(filter, toLight, boxes);
  // Wider filters leave smaller fully lit/contact interiors. Sample those
  // interiors more densely while retaining unique native pixels and thresholds.
  const step = filter?.quality && filter.quality !== "low" ? 0.04 : 0.08;
  const pixels = new Set<string>();
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
    let hit = blocker(point, toLight, Infinity, boxes, region);
    if (!footprint)
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
    let idealBlockedWeight: number | undefined;
    if (footprint) {
      const center = pixelOnFace(
        x,
        y,
        width,
        height,
        viewport,
        m,
        normal,
        point,
      );
      if (!center) return;
      const box = boxes.find((candidate) => candidate.name === region);
      if (
        box &&
        center.some(
          (value, axis) =>
            value < box.center[axis]! - box.size[axis]! / 2 - 1e-6 ||
            value > box.center[axis]! + box.size[axis]! / 2 + 1e-6,
        )
      )
        return;
      const direction = subtract(camera, center);
      if (
        dot(normal, direction) <= 0 ||
        blocker(
          center,
          shadowNormalize(direction),
          Math.sqrt(dot(direction, direction)),
          boxes,
          region,
        )
      )
        return;
      hit = blocker(center, toLight, Infinity, boxes, region);
      idealBlockedWeight = footprint(center, normal, region);
      if (idealBlockedWeight === undefined) return;
      const key = `${region}:${x}:${y}`;
      if (pixels.has(key)) return;
      pixels.add(key);
    }
    if (hit && hit.distance > 1.2) return;
    result.push({
      region:
        region === "ground" && hit?.name === "thin-slab"
          ? "thin-contact-ground"
          : region,
      expected:
        idealBlockedWeight === undefined
          ? hit
            ? "contact"
            : "lit"
          : filteredExpectation(idealBlockedWeight),
      x,
      y,
      ...(idealBlockedWeight === undefined ? {} : { idealBlockedWeight }),
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
        for (let u = -0.4; u <= 0.401; u += step)
          for (let v = -0.4; v <= 0.401; v += step) {
            const point: ShadowTriple = [...box.center];
            point[axis] = box.center[axis]! + (side * box.size[axis]!) / 2;
            point[a] = box.center[a]! + u * box.size[a]!;
            point[b] = box.center[b]! + v * box.size[b]!;
            add(point, normal, ta, tb, box.name);
          }
      }
    }
  }
  for (let x = -1.8; x <= 1.8; x += step)
    for (let z = -1.2; z <= 1.8; z += step)
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
    {
      lit: number;
      falseDark: number;
      contact: number;
      retainedContact: number;
      penumbra: number;
    }
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
      penumbra: 0,
    });
    if (sample.expected === "penumbra") {
      value.penumbra++;
      continue;
    }
    const ratio = shadowed[offset + 1]! / before;
    if (sample.expected === "lit") {
      value.lit++;
      // Known lit points should match the shadow-off reference. A 3% intensity
      // allowance covers small quantization/presentation differences while
      // detecting the visible low-contrast teeth that a contact cutoff misses.
      if (ratio < 0.97) value.falseDark++;
    } else {
      value.contact++;
      // Retained contacts require a separate, stronger shadow signal.
      if (ratio < 0.85) value.retainedContact++;
    }
  }
  return result;
}

/**
 * Additional thin-contact edge oracle, independent of the eroded interior
 * mask. Test-only: pixel centers on y=0 within two authored slab thicknesses of
 * its footprint, excluding the raster silhouette and all camera-hidden ground.
 * This distance is a bound for this fixture, not a renderer bias policy.
 * Analytic negative control at the fixed 384px camera: lifting only the slab
 * caster by 0.4 world units leaves none of these 25 / 36 pixels occluded at the
 * two authored light angles. The existing interior mask permits that gap.
 * These are mask-sensitivity counts, not measured GPU correctness results.
 * When a captured PCF1 projection is provided, only at least 3/4 ideal blocked
 * support is contact; the rest is returned as lit/penumbra metadata.
 */
export function shadowThinContactEdgeSamples(
  camera: ShadowTriple,
  viewProjection: readonly number[],
  toLight: ShadowTriple,
  width: number,
  height: number,
  viewport = { x: 0, y: 0, width: 1, height: 1 },
  boxes: readonly ShadowBox[] = SHADOW_BOXES,
  filter?: ShadowPcfProjection,
): ShadowSurfaceSample[] {
  const thin = boxes.find((box) => box.name === "thin-slab");
  if (!thin || Math.abs(thin.center[1] - thin.size[1] / 2) > 1e-6) return [];
  if (width > 512 || height > 512)
    throw new Error("Bounded fixture resolution exceeded");
  const band = 2 * thin.size[0];
  const m = viewProjection;
  const footprint = pcfFootprint(filter, toLight, boxes);
  const groundAt = (x: number, y: number) =>
    pixelOnFace(x, y, width, height, viewport, m, [0, 1, 0], [0, 0, 0]);
  const visibleGround = (point: ShadowTriple | null) => {
    if (!point) return false;
    const direction = subtract(camera, point);
    return !blocker(
      point,
      shadowNormalize(direction),
      Math.sqrt(dot(direction, direction)),
      boxes,
      "ground",
    );
  };
  const bounds: { x: number; y: number }[] = [];
  for (const sideX of [-1, 1])
    for (const sideZ of [-1, 1]) {
      const x = thin.center[0] + sideX * (thin.size[0] / 2 + band);
      const z = thin.center[2] + sideZ * (thin.size[2] / 2 + band);
      const w = x * m[3]! + z * m[11]! + m[15]!;
      if (!(w > 0)) return [];
      bounds.push({
        x:
          (viewport.x +
            ((1 + (x * m[0]! + z * m[8]! + m[12]!) / w) * viewport.width) / 2) *
          width,
        y:
          (viewport.y +
            ((1 - (x * m[1]! + z * m[9]! + m[13]!) / w) * viewport.height) /
              2) *
          height,
      });
    }
  const minX = Math.max(1, Math.floor(Math.min(...bounds.map((p) => p.x))) - 1);
  const maxX = Math.min(
    width - 2,
    Math.ceil(Math.max(...bounds.map((p) => p.x))) + 1,
  );
  const minY = Math.max(1, Math.floor(Math.min(...bounds.map((p) => p.y))) - 1);
  const maxY = Math.min(
    height - 2,
    Math.ceil(Math.max(...bounds.map((p) => p.y))) + 1,
  );
  const result: ShadowSurfaceSample[] = [];
  for (let y = minY; y <= maxY; y++)
    for (let x = minX; x <= maxX; x++) {
      const point = groundAt(x, y);
      if (!point) continue;
      const dx = Math.max(
        0,
        Math.abs(point[0] - thin.center[0]) - thin.size[0] / 2,
      );
      const dz = Math.max(
        0,
        Math.abs(point[2] - thin.center[2]) - thin.size[2] / 2,
      );
      const distance = Math.hypot(dx, dz);
      if (!(distance > 0 && distance <= band) || !visibleGround(point))
        continue;
      if (
        blocker(point, toLight, Infinity, boxes, "ground")?.name !== thin.name
      )
        continue;
      if (
        [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(([u, v]) => !visibleGround(groundAt(x + u!, y + v!)))
      )
        continue;
      const idealBlockedWeight = footprint?.(point, [0, 1, 0], "ground");
      if (footprint && idealBlockedWeight === undefined) continue;
      result.push({
        region: "thin-contact-edge",
        expected:
          idealBlockedWeight === undefined
            ? "contact"
            : filteredExpectation(idealBlockedWeight),
        x,
        y,
        ...(idealBlockedWeight === undefined ? {} : { idealBlockedWeight }),
      });
    }
  return result;
}
