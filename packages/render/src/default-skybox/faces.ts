/** Geometric daylight cubemap faces (engine primitive, not authored art). */

import type { SkyboxFaceKey } from "@babylonslate/core";

/** Power-of-two face resolution for the runtime default cubemap. */
export const DEFAULT_SKYBOX_FACE_SIZE = 64;

const ZENITH: [number, number, number] = [0.55, 0.78, 0.95];
const HORIZON: [number, number, number] = [0.72, 0.82, 0.92];
const GROUND: [number, number, number] = [0.28, 0.32, 0.26];
const NADIR: [number, number, number] = [0.1, 0.12, 0.11];
const SUN: [number, number, number] = [1, 0.93, 0.72];

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mix3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * RGBA8 face in Babylon CubeTexture order (px, py, pz, nx, ny, nz).
 * Side faces put sky at v=0 (image top) and ground at v=1.
 */
export function generateDefaultSkyboxFaceRgba(
  face: SkyboxFaceKey,
  size = DEFAULT_SKYBOX_FACE_SIZE,
): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      let color: [number, number, number];
      if (face === "py") {
        const radial = clamp01(Math.hypot(u - 0.5, v - 0.5) * 2);
        color = mix3(ZENITH, HORIZON, radial);
        const sun = Math.exp(-((u - 0.72) ** 2 + (v - 0.38) ** 2) * 18);
        color = mix3(color, SUN, clamp01(sun));
      } else if (face === "ny") {
        const radial = clamp01(Math.hypot(u - 0.5, v - 0.5) * 2);
        color = mix3(NADIR, GROUND, radial);
      } else {
        color =
          v < 0.5
            ? mix3(ZENITH, HORIZON, v * 2)
            : mix3(HORIZON, GROUND, (v - 0.5) * 2);
      }
      const i = (y * size + x) * 4;
      data[i] = Math.round(color[0] * 255);
      data[i + 1] = Math.round(color[1] * 255);
      data[i + 2] = Math.round(color[2] * 255);
      data[i + 3] = 255;
    }
  }
  return data;
}
