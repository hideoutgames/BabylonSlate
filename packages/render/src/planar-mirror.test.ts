import { Matrix, Vector3 } from "@babylonjs/core";
import { expect, it } from "vitest";
import { PlanarMirrorMath, type MirrorPlane } from "./planar-mirror";

/** Where an eye sees `object` in the mirror plane: the ray from the eye to the object's reflection meets the plane. */
function seenAt(eye: Vector3, object: Vector3, plane: MirrorPlane): Vector3 {
  const n = new Vector3(plane.nx, plane.ny, plane.nz);
  const reflected = object.subtract(n.scale(2 * (Vector3.Dot(n, object) + plane.d)));
  const from = Vector3.Dot(n, eye) + plane.d, to = Vector3.Dot(n, reflected) + plane.d;
  return Vector3.Lerp(eye, reflected, from / (from - to));
}

function mirrored(eye: Vector3, target: Vector3, plane: MirrorPlane, depth: { reverse: boolean; half: boolean }) {
  const view = Matrix.LookAtLH(eye, target, Vector3.Up());
  const near = 0.1, far = 100;
  const projection = Matrix.PerspectiveFovLH(0.9, 16 / 9, depth.reverse ? far : near, depth.reverse ? near : far, depth.half, 0, depth.reverse);
  const math = new PlanarMirrorMath();
  const mirrorView = new Matrix(), oblique = new Matrix(), scratch = new Matrix(), viewProjection = new Matrix();
  const drawn = math.mirror(view, eye, plane, projection, depth.reverse, depth.half, mirrorView, oblique);
  math.relativeViewProjection(Vector3.Zero(), oblique, scratch, viewProjection);
  return { drawn, math, viewProjection, mainViewProjection: view.multiply(projection) };
}

const unit = (x: number, y: number, z: number) => new Vector3(x, y, z).normalize();

it.each([
  { range: "full-range", half: false, reverse: false, near: -1, far: 1 },
  { range: "half-range (WebGPU)", half: true, reverse: false, near: 0, far: 1 },
  { range: "reverse full-range", half: false, reverse: true, near: 1, far: -1 },
  { range: "reverse half-range", half: true, reverse: true, near: 1, far: 0 },
])("reflects a wall mirror's view so each surface point reads what it reflects, for $range depth", ({ half, reverse, near, far }) => {
  // The wall z = 5 with its reflective side toward −Z: n = (0, 0, −1), d = 5.
  const plane = { nx: 0, ny: 0, nz: -1, d: 5 };
  const eye = new Vector3(1, 2, -5);
  const { drawn, math, viewProjection, mainViewProjection } = mirrored(eye, new Vector3(1, 2, 5), plane, { reverse, half });
  expect(drawn).toBe(true);
  // The mirror camera sits at the eye reflected through the wall.
  expect([...math.eye]).toEqual([1, 2, 15]);
  // An object at Q = (0, 1, −3) is seen where the ray to its reflection (0, 1, 13) meets the wall: (4/9, 13/9, 5).
  const q = new Vector3(0, 1, -3), p = new Vector3(4 / 9, 13 / 9, 5);
  expect(seenAt(eye, q, plane).subtract(p).length()).toBeLessThan(1e-12);
  const object = Vector3.TransformCoordinates(q, viewProjection), surface = Vector3.TransformCoordinates(p, viewProjection);
  expect(object.x).toBeCloseTo(surface.x, 6);
  expect(object.y).toBeCloseTo(surface.y, 6);
  // The wall is the near plane: its points sit at this convention's near depth, the object within range, and
  // anything behind the wall is clipped away.
  const inRange = (z: number) => (z - near) * (z - far) <= 1e-9;
  expect(surface.z).toBeCloseTo(near, 5);
  expect(inRange(object.z)).toBe(true);
  expect(inRange(Vector3.TransformCoordinates(new Vector3(1, 2, 7), viewProjection).z)).toBe(false);
  // The rigid mirror flips the image horizontally: surface points land at the view's x mirrored.
  const seen = Vector3.TransformCoordinates(p, mainViewProjection);
  expect(surface.x).toBeCloseTo(-seen.x, 6);
  expect(surface.y).toBeCloseTo(seen.y, 6);
});

it("mirrors across a tilted plane and keeps the mirror camera rigid", () => {
  // A mirror leaning back, through (0, 1, 4), reflective side toward the eye.
  const n = unit(0, 0.5, -1);
  const plane = { nx: n.x, ny: n.y, nz: n.z, d: -Vector3.Dot(n, new Vector3(0, 1, 4)) };
  const eye = new Vector3(-1, 1.5, -2);
  const { drawn, math, viewProjection } = mirrored(eye, new Vector3(0, 1, 4), plane, { reverse: false, half: false });
  expect(drawn).toBe(true);
  // The reflected eye is as far behind the plane as the eye is in front of it.
  const reflectedEye = Vector3.FromArray([...math.eye]);
  expect(Vector3.Dot(n, reflectedEye) + plane.d).toBeCloseTo(-(Vector3.Dot(n, eye) + plane.d), 9);
  expect(reflectedEye.add(eye).scale(0.5).subtract(eye).normalize().subtract(n.negate()).length()).toBeLessThan(1e-9);
  // A rotation, not a reflection: winding and back-face culling are unchanged.
  const q = math.rotation;
  const determinant = q[0]! * (q[4]! * q[8]! - q[5]! * q[7]!) - q[1]! * (q[3]! * q[8]! - q[5]! * q[6]!) + q[2]! * (q[3]! * q[7]! - q[4]! * q[6]!);
  expect(determinant).toBeCloseTo(1, 6);
  for (const object of [new Vector3(0.5, 0.8, 1), new Vector3(-2, 2.5, 0)]) {
    const p = seenAt(eye, object, plane);
    const a = Vector3.TransformCoordinates(object, viewProjection), b = Vector3.TransformCoordinates(p, viewProjection);
    expect(a.x).toBeCloseTo(b.x, 6);
    expect(a.y).toBeCloseTo(b.y, 6);
    expect(b.z).toBeCloseTo(-1, 5);
  }
});

it("refuses to mirror an eye on or behind the plane", () => {
  const plane = { nx: 0, ny: 0, nz: -1, d: 5 };
  for (const eye of [new Vector3(0, 1, 5), new Vector3(0, 1, 8)]) {
    expect(mirrored(eye, new Vector3(0, 1, 20), plane, { reverse: false, half: false }).drawn).toBe(false);
  }
});
