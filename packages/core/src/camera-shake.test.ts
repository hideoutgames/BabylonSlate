import { describe, expect, it } from "vitest";
import {
  cameraShakeCurveGuids,
  cameraShakeFinished,
  cameraShakeWeight,
  createDefaultCameraShakePayload,
  normalizeCameraShakePayload,
  perlinNoise1,
  sampleCameraShake,
  worldCameraShakeScale,
  type CameraShakePayload,
} from "./camera-shake";

const constant = <V>(value: V, zero: V) => ({
  Keys: [{ Time: 0, Value: value, Interpolation: "linear", ArriveTangent: zero, LeaveTangent: zero }],
  Before: "constant", After: "constant",
});
const line = (from: number, to: number) => ({
  Keys: [
    { Time: 0, Value: from, Interpolation: "linear", ArriveTangent: 0, LeaveTangent: 0 },
    { Time: 1, Value: to, Interpolation: "linear", ArriveTangent: 0, LeaveTangent: 0 },
  ],
  Before: "constant", After: "constant",
});

/** A shake with every channel off, no blends and no end. */
function quiet(overrides: Partial<CameraShakePayload> = {}): CameraShakePayload {
  return normalizeCameraShakePayload({
    ...createDefaultCameraShakePayload(),
    duration: 0, blendInTime: 0, blendOutTime: 0,
    locationAmplitude: { x: 0, y: 0, z: 0 }, rotationAmplitude: { pitch: 0, yaw: 0, roll: 0 }, fovAmplitude: 0,
    ...overrides,
  });
}
const at = (time: number, stoppingAt: number | null = null) => ({ time, stoppingAt, seed: 7 });

describe("Camera Shake payload", () => {
  it("keeps known fields in range and defaults the rest", () => {
    const payload = normalizeCameraShakePayload({
      pattern: "spiral", duration: -2, blendInTime: "0.5", blendOutTime: Number.NaN,
      locationAmplitude: { x: -1, y: 2, z: "big" }, rotationFrequency: { pitch: 500 },
      intensityCurveGuid: "  curve-1 ", locationCurveGuid: "", extra: true,
    });
    const base = createDefaultCameraShakePayload();
    expect(payload.pattern).toBe("noise");
    expect([payload.duration, payload.blendInTime, payload.blendOutTime]).toEqual([0, 0.5, base.blendOutTime]);
    expect(payload.locationAmplitude).toEqual({ x: 0, y: 2, z: base.locationAmplitude.z });
    expect(payload.rotationFrequency.pitch).toBe(100);
    expect([payload.intensityCurveGuid, payload.locationCurveGuid]).toEqual(["curve-1", null]);
    expect("extra" in payload).toBe(false);
  });

  it("lists the curves a pattern uses", () => {
    const guids = { intensityCurveGuid: "i", locationCurveGuid: "l", rotationCurveGuid: "r", fovCurveGuid: "f" };
    expect(cameraShakeCurveGuids(quiet({ ...guids, pattern: "noise" }))).toEqual(["i"]);
    expect(cameraShakeCurveGuids(quiet({ ...guids, pattern: "curves" }))).toEqual(["i", "l", "r", "f"]);
  });
});

describe("Camera Shake sampling", () => {
  it("draws seeded Perlin noise that is 0 at whole numbers and stays within -1..1", () => {
    expect([perlinNoise1(0, 3), perlinNoise1(4, 3), perlinNoise1(-2, 3)].map(Math.abs)).toEqual([0, 0, 0]);
    const samples = Array.from({ length: 400 }, (_, i) => perlinNoise1(i * 0.37 + 0.11, 3));
    expect(samples.every((value) => value >= -1 && value <= 1)).toBe(true);
    expect(samples.some((value) => Math.abs(value) > 0.2)).toBe(true);
    expect(perlinNoise1(2.4, 3)).toBe(perlinNoise1(2.4, 3));
    expect(perlinNoise1(2.4, 3)).not.toBe(perlinNoise1(2.4, 4));
  });

  it("follows a sine wave per channel, times the scale", () => {
    const shake = quiet({ pattern: "sine", locationAmplitude: { x: 2, y: 0, z: 0 }, locationFrequency: { x: 1, y: 1, z: 1 },
      rotationAmplitude: { pitch: 0, yaw: 0, roll: 10 }, rotationFrequency: { pitch: 1, yaw: 1, roll: 0.5 } });
    const sample = sampleCameraShake(shake, at(0.25), 3);
    expect(sample.x).toBeCloseTo(6, 9);
    // Roll at half a cycle per second is a quarter of the way up at 0.25 s: sin(π/4).
    expect(sample.roll).toBeCloseTo(30 * Math.SQRT1_2, 9);
    expect([sample.y, sample.z, sample.pitch, sample.yaw, sample.fov]).toEqual([0, 0, 0, 0, 0]);
  });

  it("blends in, blends out before Duration ends and after a stop, and follows the Intensity Curve", () => {
    const shake = quiet({ duration: 2, blendInTime: 0.5, blendOutTime: 1 });
    expect(cameraShakeWeight(shake, at(0.25))).toBeCloseTo(0.5, 9);
    expect(cameraShakeWeight(shake, at(0.75))).toBe(1);
    expect(cameraShakeWeight(shake, at(1.5))).toBeCloseTo(0.5, 9);
    expect(cameraShakeWeight(shake, at(0.75, 0.6))).toBeCloseTo(0.85, 9);
    expect(cameraShakeWeight(shake, at(0.75), { intensity: constant(0.4, 0) as never })).toBeCloseTo(0.4, 9);
    expect(cameraShakeFinished(shake, at(1.99))).toBe(false);
    expect(cameraShakeFinished(shake, at(2))).toBe(true);
    expect(cameraShakeFinished(shake, at(1, 0.2))).toBe(false);
    expect(cameraShakeFinished(shake, at(1.2, 0.2))).toBe(true);
    // Until stopped, a shake without a Duration never ends; without a blend out its stop ends it at once.
    const endless = quiet();
    expect(cameraShakeFinished(endless, at(500))).toBe(false);
    expect(cameraShakeWeight(endless, at(3, 3))).toBe(0);
    expect(cameraShakeFinished(endless, at(3, 3))).toBe(true);
  });

  it("reads the Curves pattern's Location, Rotation and Field Of View curves at the shake's seconds", () => {
    const zero = { x: 0, y: 0, z: 0 };
    const shake = quiet({ pattern: "curves" });
    const sample = sampleCameraShake(shake, at(0.5), 2, {
      location: constant({ x: 1, y: 2, z: 3 }, zero) as never,
      rotation: constant({ x: 4, y: 5, z: 6 }, zero) as never,
      fov: line(0, 10) as never,
    });
    expect(sample).toEqual({ x: 2, y: 4, z: 6, pitch: 8, yaw: 10, roll: 12, fov: 10 });
    expect(sampleCameraShake(shake, at(0.5))).toEqual({ x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0, fov: 0 });
  });

  it("fades a world shake from Inner Radius to Outer Radius", () => {
    expect(worldCameraShakeScale(1, 2, 6, 1)).toBe(1);
    expect(worldCameraShakeScale(4, 2, 6, 1)).toBeCloseTo(0.5, 9);
    expect(worldCameraShakeScale(4, 2, 6, 2)).toBeCloseTo(0.25, 9);
    expect(worldCameraShakeScale(6, 2, 6, 1)).toBe(0);
    expect(worldCameraShakeScale(3, 5, 1, 1)).toBe(1);
    expect(worldCameraShakeScale(Number.NaN, 2, 6, 1)).toBe(0);
  });
});
