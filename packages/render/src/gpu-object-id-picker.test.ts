import { Matrix, Vector3 } from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import { pickPixelProjection } from "./gpu-object-id-picker";

const WIDTH = 240;
const HEIGHT = 160;

/** Top-down `scene.pick` pixel coordinates of a projected point. */
function canvasPixel(ndc: Vector3) {
  return { x: ((ndc.x + 1) / 2) * WIDTH, y: ((1 - ndc.y) / 2) * HEIGHT };
}

describe("pickPixelProjection", () => {
  const projections = {
    perspective: Matrix.PerspectiveFovLH(0.8, WIDTH / HEIGHT, 0.1, 100),
    orthographic: Matrix.OrthoOffCenterLH(-3, 3, -2, 2, 0.1, 30),
  };

  for (const [mode, projection] of Object.entries(projections)) {
    it(`maps only the tapped ${mode} pixel onto the 1×1 target with unchanged depth`, () => {
      // View-space points near the corners and edges of the frame, off pixel boundaries.
      const points = [
        new Vector3(-2.951, 1.971, 7), new Vector3(2.961, -1.983, 7.5),
        new Vector3(2.903, 1.953, 7.2), new Vector3(-2.968, -0.41, 6.8), new Vector3(0.31, -1.991, 7),
      ];
      for (const point of points) {
        const ndc = Vector3.TransformCoordinates(point, projection);
        const pixel = canvasPixel(ndc);
        const px = Math.floor(pixel.x);
        const py = Math.floor(pixel.y);
        expect(px).toBeGreaterThanOrEqual(0);
        expect(px).toBeLessThan(WIDTH);
        expect(py).toBeGreaterThanOrEqual(0);
        expect(py).toBeLessThan(HEIGHT);

        const picked = Vector3.TransformCoordinates(point, pickPixelProjection(projection, px, py, WIDTH, HEIGHT));
        // Position within the tapped pixel becomes position within the target.
        expect(picked.x).toBeCloseTo(2 * (pixel.x - px - 0.5), 4);
        expect(picked.y).toBeCloseTo(-2 * (pixel.y - py - 0.5), 4);
        expect(Math.abs(picked.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(picked.y)).toBeLessThanOrEqual(1);
        expect(picked.z).toBeCloseTo(ndc.z, 6);

        // Neighbouring pixels fall outside the target.
        const right = Vector3.TransformCoordinates(point, pickPixelProjection(projection, px - 1, py, WIDTH, HEIGHT));
        const below = Vector3.TransformCoordinates(point, pickPixelProjection(projection, px, py - 1, WIDTH, HEIGHT));
        expect(right.x).toBeGreaterThan(1);
        expect(below.y).toBeLessThan(-1);
      }
    });
  }
});
