import { afterEach, describe, expect, it } from "vitest";
import { Camera, FreeCamera, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import {
  CLUSTER_COUNT,
  CLUSTER_HEADER_FLOATS,
  CLUSTER_SLICES,
  CLUSTER_TILES_X,
  CLUSTER_TILES_Y,
  buildLightClusters,
  type ClusterLight,
} from "./light-clusters";

const disposers: (() => void)[] = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); });

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

function build(camera: Camera, lights: ClusterLight[]) {
  const masks = new Uint32Array(CLUSTER_COUNT * 2);
  const header = new Float32Array(CLUSTER_HEADER_FLOATS);
  buildLightClusters(masks, header, lights,
    { view: camera.getViewMatrix(), projection: camera.getProjectionMatrix(), near: camera.minZ, far: camera.maxZ }, Vector3.Zero());
  return { masks, header };
}

describe("light clusters", () => {
  it.each([["perspective", false], ["orthographic", true]] as const)(
    "list every light whose range holds a position in view, under a %s camera", (_name, orthographic) => {
      const camera = view(orthographic);
      const next = random(7);
      const lights: ClusterLight[] = [];
      for (let index = 0; index < 32; index++)
        lights.push({ kind: "point", index, x: next() * 40 - 20, y: next() * 4, z: next() * 40 - 10, radius: 1 + next() * 6 });
      for (let index = 0; index < 16; index++)
        lights.push({ kind: "spot", index, x: next() * 40 - 20, y: next() * 6, z: next() * 40 - 10, radius: 2 + next() * 10 });
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

  it("lists no light behind the camera, and every rect light in every cluster", () => {
    const camera = view();
    const { masks } = build(camera, [
      { kind: "point", index: 3, x: 2, y: 9, z: -40, radius: 4 },
      { kind: "rect", index: 2, x: 0, y: 0, z: 0, radius: Infinity },
    ]);
    for (let cluster = 0; cluster < CLUSTER_COUNT; cluster++) {
      expect(masks[cluster * 2]).toBe(0);
      expect(masks[cluster * 2 + 1]).toBe(1 << (16 + 2));
    }
  });

  it("disables the lookup without a view, so every light draws", () => {
    const masks = new Uint32Array(CLUSTER_COUNT * 2);
    const header = new Float32Array(CLUSTER_HEADER_FLOATS).fill(1);
    buildLightClusters(masks, header, [{ kind: "point", index: 0, x: 0, y: 0, z: 0, radius: 1 }], null, Vector3.Zero());
    expect(header[22]).toBe(0);
  });
});
