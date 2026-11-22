import { afterEach, describe, expect, it, vi } from "vitest";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Plane } from "@babylonjs/core/Maths/math.plane";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import {
  CLUSTER_COUNT,
  CLUSTER_HEADER_FLOATS,
  CLUSTER_SLICES,
  CLUSTER_TILES_X,
  CLUSTER_TILES_Y,
  buildLightClusters,
  spotClusterSphere,
  type ClusterLight,
} from "./light-clusters";

const disposers: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (disposers.length) disposers.pop()!();
});

function view(orthographic = false) {
  const engine = new NullEngine({ renderWidth: 320, renderHeight: 200, textureSize: 256, deterministicLockstep: false, lockstepMaxSteps: 1 });
  const scene = new Scene(engine);
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  const camera = new FreeCamera("camera", new Vector3(2, 9, -14), scene);
  camera.setTarget(new Vector3(0, 0, 6));
  camera.minZ = 0.1;
  camera.maxZ = 200;
  if (orthographic) {
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    camera.orthoLeft = -16; camera.orthoRight = 16; camera.orthoBottom = -10; camera.orthoTop = 10;
  }
  scene.activeCamera = camera;
  camera.getViewMatrix(true);
  camera.getProjectionMatrix(true);
  return camera;
}

/** A deterministic sequence in [0, 1). */
function random(seed: number) {
  let state = seed;
  return () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** The cluster masks a shader reads at world position (x, y, z): every light outside the clusters' view. */
function masksAt(words: Uint32Array, header: Float32Array, x: number, y: number, z: number): [number, number] {
  const m = header;
  const clipX = x * m[0]! + y * m[4]! + z * m[8]! + m[12]!;
  const clipY = x * m[1]! + y * m[5]! + z * m[9]! + m[13]!;
  const clipW = x * m[3]! + y * m[7]! + z * m[11]! + m[15]!;
  const depth = x * m[16]! + y * m[17]! + z * m[18]! + m[19]!;
  const [near, logScale, enabled] = [m[20]!, m[21]!, m[22]!];
  if (enabled < 0.5 || clipW <= 0 || depth < near) return [0xffffffff, 0xffffffff];
  const ndcX = clipX / clipW, ndcY = clipY / clipW;
  if (Math.abs(ndcX) > 1 || Math.abs(ndcY) > 1) return [0xffffffff, 0xffffffff];
  const tx = Math.min(CLUSTER_TILES_X - 1, Math.max(0, Math.floor((ndcX * 0.5 + 0.5) * CLUSTER_TILES_X)));
  const ty = Math.min(CLUSTER_TILES_Y - 1, Math.max(0, Math.floor((ndcY * 0.5 + 0.5) * CLUSTER_TILES_Y)));
  const slice = Math.min(CLUSTER_SLICES - 1, Math.max(0, Math.floor(Math.log(depth / near) * logScale)));
  const cluster = (slice * CLUSTER_TILES_Y + ty) * CLUSTER_TILES_X + tx;
  return [words[cluster * 2]!, words[cluster * 2 + 1]!];
}

function build(camera: Camera, lights: ClusterLight[], view = camera.getViewMatrix()) {
  const masks = new Uint32Array(CLUSTER_COUNT * 2);
  const header = new Float32Array(CLUSTER_HEADER_FLOATS);
  buildLightClusters(masks, header, lights,
    { view, projection: camera.getProjectionMatrix(), near: camera.minZ, far: camera.maxZ }, Vector3.Zero());
  return { masks, header };
}

/** A point or spot light's record: a sphere, no plane. */
function sphere(kind: "point" | "spot", index: number, x: number, y: number, z: number, radius: number): ClusterLight {
  return { kind, index, x, y, z, radius, nx: 0, ny: 0, nz: 0 };
}

const f = Math.fround;
/** The shader's cluster lookup at (x, y, z) in float32, as the GPU rounds it: the cluster's word 1, or every light. */
function rectMaskAt32(words: Uint32Array, m: Float32Array, x: number, y: number, z: number): number {
  const dot = (a: number, b: number, c: number, d: number) => f(f(f(f(f(x * a) + f(y * b)) + f(z * c))) + d);
  const clipX = dot(m[0]!, m[4]!, m[8]!, m[12]!), clipY = dot(m[1]!, m[5]!, m[9]!, m[13]!), clipW = dot(m[3]!, m[7]!, m[11]!, m[15]!);
  const depth = dot(m[16]!, m[17]!, m[18]!, m[19]!);
  const [near, logScale, enabled] = [m[20]!, m[21]!, m[22]!];
  if (enabled < 0.5 || clipW <= 0 || depth < near) return 0xffffffff;
  const ndcX = f(clipX / clipW), ndcY = f(clipY / clipW);
  if (Math.abs(ndcX) > 1 || Math.abs(ndcY) > 1) return 0xffffffff;
  const tx = Math.min(CLUSTER_TILES_X - 1, Math.max(0, Math.floor(f(f(f(ndcX * 0.5) + 0.5) * CLUSTER_TILES_X))));
  const ty = Math.min(CLUSTER_TILES_Y - 1, Math.max(0, Math.floor(f(f(f(ndcY * 0.5) + 0.5) * CLUSTER_TILES_Y))));
  const slice = Math.min(CLUSTER_SLICES - 1, Math.max(0, Math.floor(f(f(Math.log(f(depth / near))) * logScale))));
  return words[((slice * CLUSTER_TILES_Y + ty) * CLUSTER_TILES_X + tx) * 2 + 1]!;
}

type Rect = { center: number[]; width: number[]; height: number[] };
/**
 * Whether the shader evaluates rect `rect` at (x, y, z), in float32: `hapticLtcEvaluate` returns exactly zero where
 * dot(cross(c1 - c0, c3 - c0), P - c0) < 0, and only there is the light's contribution zero whatever the surface.
 */
function rectEvaluated32(rect: Rect, x: number, y: number, z: number): boolean {
  const [c, w, h] = [rect.center.map(f), rect.width.map(f), rect.height.map(f)];
  const c0 = [0, 1, 2].map((k) => f(f(c[k]! + w[k]!) - h[k]!));
  const c1 = [0, 1, 2].map((k) => f(f(c[k]! - w[k]!) - h[k]!));
  const c3 = [0, 1, 2].map((k) => f(f(c[k]! + w[k]!) + h[k]!));
  const e1 = [0, 1, 2].map((k) => f(c1[k]! - c0[k]!));
  const e3 = [0, 1, 2].map((k) => f(c3[k]! - c0[k]!));
  const n = [f(f(e1[1]! * e3[2]!) - f(e1[2]! * e3[1]!)), f(f(e1[2]! * e3[0]!) - f(e1[0]! * e3[2]!)), f(f(e1[0]! * e3[1]!) - f(e1[1]! * e3[0]!))];
  const d = [f(f(x) - c0[0]!), f(f(y) - c0[1]!), f(f(z) - c0[2]!)];
  return f(f(f(n[0]! * d[0]!) + f(n[1]! * d[1]!)) + f(n[2]! * d[2]!)) >= 0;
}

/** Rect `index`'s cluster record, as the light block writes it: its float32 centre and cross(height, width). */
function rectRecord(index: number, rect: Rect): ClusterLight {
  const [w, h] = [rect.width, rect.height];
  const [x, y, z] = rect.center.map(f) as [number, number, number];
  return {
    kind: "rect", index, x, y, z, radius: Infinity,
    nx: h[1]! * w[2]! - h[2]! * w[1]!, ny: h[2]! * w[0]! - h[0]! * w[2]!, nz: h[0]! * w[1]! - h[1]! * w[0]!,
  };
}

/**
 * The rect light marking as it was before the cluster corners were shared: every cluster's eight corners computed and
 * tested on their own, each with its own square root. The masks a build writes must match it bit for bit.
 */
function referenceRectMasks(camera: Camera, lights: ClusterLight[], viewMatrix: Matrix): Uint32Array {
  const masks = new Uint32Array(CLUSTER_COUNT * 2);
  const relative = viewMatrix.clone();
  const inverse = relative.clone().invert();
  const p = camera.getProjectionMatrix().m;
  const near = Math.max(camera.minZ, 1e-4);
  const far = Math.max(near * 2, Math.min(camera.maxZ > 0 ? camera.maxZ : 500, 500));
  const logScale = CLUSTER_SLICES / Math.log(far / near);
  const perspective = p[11] !== 0;
  const standard = perspective
    ? p[11] === 1 && p[15] === 0 && p[1] === 0 && p[3] === 0 && p[4] === 0 && p[7] === 0 && p[12] === 0 && p[13] === 0
    : p[15] === 1 && p[1] === 0 && p[3] === 0 && p[4] === 0 && p[7] === 0 && p[8] === 0 && p[9] === 0;
  const depths = Array.from({ length: CLUSTER_SLICES }, (_, s) => near * Math.exp(s / logScale));
  const edges = (count: number, scale: number, shift: number) => Array.from({ length: count * 2 }, (_, at) =>
    at % 2 === 0 ? (((at / 2) / count) * 2 - 1 - shift) / scale : ((((at - 1) / 2 + 1) / count) * 2 - 1 - shift) / scale);
  const edgesX = edges(CLUSTER_TILES_X, p[0]!, perspective ? p[8]! : p[12]!);
  const edgesY = edges(CLUSTER_TILES_Y, p[5]!, perspective ? p[9]! : p[13]!);
  for (const light of lights) {
    const inv = inverse.m;
    const { nx, ny, nz } = light;
    const ax = inv[0]! * nx + inv[1]! * ny + inv[2]! * nz;
    const ay = inv[4]! * nx + inv[5]! * ny + inv[6]! * nz;
    const az = inv[8]! * nx + inv[9]! * ny + inv[10]! * nz;
    const b = inv[12]! * nx + inv[13]! * ny + inv[14]! * nz - (nx * light.x + ny * light.y + nz * light.z);
    const tolerance = 1e-4 * Math.sqrt(ax * ax + ay * ay + az * az);
    const center = Vector3.TransformCoordinatesFromFloatsToRef(light.x, light.y, light.z, relative, new Vector3());
    const v = relative.m;
    const reach = 1 + center.length() + Math.sqrt(v[12]! * v[12]! + v[13]! * v[13]! + v[14]! * v[14]!);
    const flag = (1 << (16 + light.index)) >>> 0;
    for (let s = 0; s < CLUSTER_SLICES; s++) {
      const last = s === CLUSTER_SLICES - 1;
      const z0 = depths[s]!, z1 = last ? z0 : depths[s + 1]!;
      for (let ty = 0; ty < CLUSTER_TILES_Y; ty++)
        for (let tx = 0; tx < CLUSTER_TILES_X; tx++) {
          let behind = standard && tolerance > 0;
          for (let corner = 0; behind && corner < 8; corner++) {
            const ex = edgesX[tx * 2 + (corner & 1)]!, ey = edgesY[ty * 2 + ((corner >> 1) & 1)]!;
            const z = corner & 4 ? z1 : z0;
            if (corner & 4 && last) {
              const dx = perspective ? ex : 0, dy = perspective ? ey : 0;
              behind = ax * dx + ay * dy + az + tolerance * Math.sqrt(dx * dx + dy * dy + 1) < 0;
            } else {
              const x = perspective ? ex * z : ex, y = perspective ? ey * z : ey;
              behind = ax * x + ay * y + az * z + b + tolerance * (reach + Math.sqrt(x * x + y * y + z * z)) < 0;
            }
          }
          if (behind) continue;
          const cluster = (s * CLUSTER_TILES_Y + ty) * CLUSTER_TILES_X + tx;
          masks[cluster * 2 + 1] = (masks[cluster * 2 + 1]! | flag) >>> 0;
        }
    }
  }
  return masks;
}

describe("light clusters", () => {
  it.each([["perspective", false, false], ["orthographic", true, false], ["mirrored perspective", false, true]] as const)(
    "marks rect lights in exactly the clusters each corner's own test marked, testing each shared corner once, under a %s view",
    (_name, orthographic, mirrored) => {
      // The breaks: a shared corner standing for the wrong cluster corner (a dropped or extra light in some cluster),
      // and the corners' lengths computed again per cluster and light (15,360 square roots per rect light).
      const camera = view(orthographic);
      const viewMatrix = mirrored
        ? Matrix.ReflectionToRef(Plane.FromPositionAndNormal(new Vector3(0, -0.5, 0), new Vector3(0, 1, 0)), new Matrix()).multiply(camera.getViewMatrix())
        : camera.getViewMatrix();
      const next = random(orthographic ? 23 : mirrored ? 29 : 17);
      let partial = 0;
      for (let round = 0; round < 6; round++) {
        const rects: ClusterLight[] = [];
        for (let index = 0; index < 4; index++) {
          const rect = { center: [next() * 40 - 20, next() * 8 - 1, next() * 40 - 10], width: [next() * 4 - 2, next() * 4 - 2, next() * 4 - 2], height: [next() * 4 - 2, next() * 4 - 2, next() * 4 - 2] };
          rects.push(rectRecord(index, rect));
        }
        // A light facing straight along the view, and one at the camera: planes through the clusters' corners.
        if (round === 0) rects[3] = { kind: "rect", index: 3, x: 2, y: 9, z: -14, radius: Infinity, nx: 0, ny: 0, nz: 1 };
        const sqrt = vi.spyOn(Math, "sqrt");
        const { masks } = build(camera, rects, viewMatrix);
        const roots = sqrt.mock.calls.length;
        sqrt.mockRestore();
        expect(roots).toBeLessThan((CLUSTER_TILES_X + 1) * (CLUSTER_TILES_Y + 1) * (CLUSTER_SLICES + 1) + 4 * 8);
        expect(masks).toEqual(referenceRectMasks(camera, rects, viewMatrix));
        for (let cluster = 0; cluster < CLUSTER_COUNT; cluster++) if (masks[cluster * 2 + 1] !== 0 && masks[cluster * 2 + 1] !== 0xf0000) partial++;
      }
      // The lights drop some clusters and keep others: the comparison covers both outcomes.
      expect(partial).toBeGreaterThan(100);
    });

  it("bounds a spot light by its cone, holding every point it lights and less than its range's sphere", () => {
    // The breaks: a cone sphere that misses part of the cone (a lit position in a cluster without the light), or one
    // no tighter than the range's sphere about the apex.
    const next = random(31);
    const out = { x: 0, y: 0, z: 0, radius: 0 };
    for (const degrees of [5, 30, 44.9, 45, 45.1, 60, 89, 90, 120]) {
      const cosHalf = Math.fround(Math.cos((degrees * Math.PI) / 180));
      const direction = new Vector3(next() - 0.5, next() - 0.5, next() - 0.5).normalize();
      const apex = new Vector3(next() * 10, next() * 10, next() * 10);
      const range = 2 + next() * 20;
      spotClusterSphere(apex.x, apex.y, apex.z, direction, range, cosHalf, out);
      if (degrees > 90) expect(out).toEqual({ x: apex.x, y: apex.y, z: apex.z, radius: range });
      else expect(out.radius).toBeLessThan(range * (degrees > 45 ? Math.sin((degrees * Math.PI) / 180) + 1e-3 : 0.72));
      for (let sample = 0; sample < 4000; sample++) {
        // Points of the lit sector, its rim and cap included (the cap lies on the range's sphere: lit just inside it).
        const offset = new Vector3(next() - 0.5, next() - 0.5, next() - 0.5).normalize().scale(range * Math.sqrt(sample % 4 === 0 ? 1 : next()));
        if (Vector3.Dot(direction, offset.normalizeToNew()) <= cosHalf) continue;
        const point = apex.add(offset);
        expect(Math.hypot(point.x - out.x, point.y - out.y, point.z - out.z), `${degrees}° spot`).toBeLessThanOrEqual(out.radius + 1e-9);
      }
    }
    // A spot with no bound on its range keeps the apex sphere.
    spotClusterSphere(1, 2, 3, new Vector3(0, 0, 1), Number.MAX_VALUE, Math.cos(0.4), out);
    expect(out).toEqual({ x: 1, y: 2, z: 3, radius: Number.MAX_VALUE });
  });

  it.each([["perspective", false], ["orthographic", true]] as const)(
    "list every light whose range holds a position in view, under a %s camera", (_name, orthographic) => {
      const camera = view(orthographic);
      const next = random(7);
      const lights: ClusterLight[] = [];
      for (let index = 0; index < 32; index++)
        lights.push(sphere("point", index, next() * 40 - 20, next() * 4, next() * 40 - 10, 1 + next() * 6));
      for (let index = 0; index < 16; index++)
        lights.push(sphere("spot", index, next() * 40 - 20, next() * 6, next() * 40 - 10, 2 + next() * 10));
      const { masks, header } = build(camera, lights);
      let checked = 0, listed = 0, reaching = 0;
      for (let sample = 0; sample < 4000; sample++) {
        const x = next() * 44 - 22, y = next() * 8 - 1, z = next() * 44 - 12;
        const [points, spots] = masksAt(masks, header, x, y, z);
        if (points === 0xffffffff && spots === 0xffffffff) continue;
        checked++;
        for (const light of lights) {
          const bit = light.kind === "point" ? (points >>> light.index) & 1 : (spots >>> light.index) & 1;
          listed += bit;
          const inside = (light.x - x) ** 2 + (light.y - y) ** 2 + (light.z - z) ** 2 < light.radius ** 2;
          if (inside) {
            reaching++;
            expect(bit, `${light.kind} ${light.index} reaches (${x}, ${y}, ${z})`).toBe(1);
          }
        }
      }
      expect(checked).toBeGreaterThan(1000);
      // Conservative, but far from listing every light everywhere.
      expect(listed).toBeGreaterThanOrEqual(reaching);
      expect(listed).toBeLessThan(checked * lights.length * 0.5);
    });

  it("lists no light behind the camera", () => {
    const camera = view();
    const { masks } = build(camera, [sphere("point", 3, 2, 9, -40, 4)]);
    for (let cluster = 0; cluster < CLUSTER_COUNT; cluster++) expect(masks[cluster * 2]).toBe(0);
  });

  it.each([["perspective", false, false], ["orthographic", true, false], ["mirrored perspective", false, true]] as const)(
    "list a rect light wherever the shader evaluates it, under a %s view", (_name, orthographic, mirrored) => {
      // The break: a cluster dropping a rect light at a position in front of its emitting side, where the shader lights
      // it. A rect light in every cluster passes that, and fails the share of drops below.
      const camera = view(orthographic);
      const viewMatrix = mirrored
        ? Matrix.ReflectionToRef(Plane.FromPositionAndNormal(new Vector3(0, -0.5, 0), new Vector3(0, 1, 0)), new Matrix()).multiply(camera.getViewMatrix())
        : camera.getViewMatrix();
      const next = random(orthographic ? 11 : mirrored ? 13 : 5);
      let checked = 0, evaluated = 0, listed = 0, nearPlane = 0;
      for (let round = 0; round < 12; round++) {
        const rects: Rect[] = [];
        for (let index = 0; index < 4; index++) {
          const width = [next() * 4 - 2, next() * 4 - 2, next() * 4 - 2];
          const height = [next() * 4 - 2, next() * 4 - 2, next() * 4 - 2];
          rects.push({ center: [next() * 40 - 20, next() * 8 - 1, next() * 40 - 10], width, height });
        }
        const { masks, header } = build(camera, rects.map((rect, index) => rectRecord(index, rect)), viewMatrix);
        for (let sample = 0; sample < 1500; sample++) {
          let x = next() * 44 - 22, y = next() * 10 - 2, z = next() * 50 - 12;
          // A third far away, in the last slice, which has no far end.
          if (sample % 3 === 1) [x, y, z] = [x * 12, y * 12, z * 12 + 100];
          if (sample % 3 === 0) {
            // A position just off a rect's plane, on either side, where float32 rounding decides the side.
            const rect = rects[sample % 4]!;
            const [w, h] = [rect.width, rect.height];
            const n = [h[1]! * w[2]! - h[2]! * w[1]!, h[2]! * w[0]! - h[0]! * w[2]!, h[0]! * w[1]! - h[1]! * w[0]!];
            const length = Math.hypot(n[0]!, n[1]!, n[2]!);
            const [a, b, t] = [next() * 20 - 10, next() * 20 - 10, (next() - 0.5) * 1e-4];
            [x, y, z] = [0, 1, 2].map((k) => rect.center[k]! + a * w[k]! + b * h[k]! + (t * n[k]!) / length) as [number, number, number];
            nearPlane++;
          }
          const mask = rectMaskAt32(masks, header, x, y, z);
          if (mask === 0xffffffff) continue;
          for (let index = 0; index < 4; index++) {
            checked++;
            const bit = (mask >>> (16 + index)) & 1;
            listed += bit;
            if (rectEvaluated32(rects[index]!, x, y, z)) {
              evaluated++;
              expect(bit, `rect ${index} lights (${x}, ${y}, ${z})`).toBe(1);
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(20000);
      expect(nearPlane).toBeGreaterThan(5000);
      // Conservative, but most positions behind a rect drop it.
      expect(checked - listed).toBeGreaterThan((checked - evaluated) * 0.6);
    });

  it("computes the slices' depths once per build, however many clusters its lights test", () => {
    // The break: a slice's depth computed (Math.exp) for every cluster tested against every light, thousands per build.
    const camera = view();
    const lights: ClusterLight[] = [];
    for (let index = 0; index < 32; index++) lights.push(sphere("point", index, (index % 8) * 4 - 14, 1, Math.floor(index / 8) * 6, 8));
    for (let index = 0; index < 16; index++) lights.push(sphere("spot", index, (index % 4) * 6 - 9, 2, Math.floor(index / 4) * 8, 10));
    const exp = vi.spyOn(Math, "exp");
    const { masks } = build(camera, lights);
    expect(masks.some((word) => word !== 0)).toBe(true);
    expect(exp.mock.calls.length).toBeLessThanOrEqual(CLUSTER_SLICES);
  });

  it("disables the lookup without a view, so every light draws", () => {
    const masks = new Uint32Array(CLUSTER_COUNT * 2);
    const header = new Float32Array(CLUSTER_HEADER_FLOATS).fill(1);
    buildLightClusters(masks, header, [sphere("point", 0, 0, 0, 0, 1)], null, Vector3.Zero());
    expect(header[22]).toBe(0);
  });
});
