import { describe, expect, it } from "vitest";
import { deprojectCursorRay } from "./cursor-ray";

describe("deprojectCursorRay", () => {
  it("casts a perspective ray from the camera through canvas center toward +Z", () => {
    const ray = deprojectCursorRay(
      { x: 400, y: 300 },
      { width: 800, height: 600 },
      {
        position: { x: 0, y: 0, z: -10 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        lens: {
          projectionMode: "perspective",
          fieldOfView: 60,
          orthographicSize: 5,
          nearClip: 0.1,
          farClip: 1000,
        },
      },
    );
    expect(ray.direction.x).toBeCloseTo(0);
    expect(ray.direction.y).toBeCloseTo(0);
    expect(ray.direction.z).toBeCloseTo(1);
    expect(ray.origin.z).toBeCloseTo(-9.9);
    expect(ray.end.z).toBeCloseTo(990);
  });

  it("offsets an orthographic ray in XY without changing direction", () => {
    const ray = deprojectCursorRay(
      { x: 800, y: 0 },
      { width: 800, height: 600 },
      {
        position: { x: 0, y: 0, z: -10 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        lens: {
          projectionMode: "orthographic",
          fieldOfView: 60,
          orthographicSize: 5,
          nearClip: 0.1,
          farClip: 100,
        },
      },
    );
    expect(ray.direction).toEqual({ x: 0, y: 0, z: 1 });
    expect(ray.origin.x).toBeCloseTo(5 * (800 / 600));
    expect(ray.origin.y).toBeCloseTo(5);
    expect(ray.origin.z).toBeCloseTo(-9.9);
  });
});
