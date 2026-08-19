import { describe, expect, it } from "vitest";
import {
  combineRotators,
  eulerDegreesToQuaternion,
  inverseRotator,
  lookAtRotation,
  lookAtRotator,
  quatRotateVector,
  quatToRotator,
  quaternionToEulerDegrees,
  rotatorForward,
  rotatorRight,
  rotatorToQuat,
  rotatorUp,
  normalizeQuat,
} from "./euler";

const SQRT_HALF = Math.SQRT1_2;

function close(
  actual: readonly number[],
  expected: readonly number[],
  digits = 5,
): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) {
    expect(actual[i]).toBeCloseTo(expected[i]!, digits);
  }
}

describe("eulerDegreesToQuaternion", () => {
  it("maps identity Euler to identity quaternion", () => {
    close(eulerDegreesToQuaternion([0, 0, 0]), [0, 0, 0, 1]);
  });

  it("maps 90 degrees around Y to a yaw quaternion", () => {
    close(eulerDegreesToQuaternion([0, 90, 0]), [0, SQRT_HALF, 0, SQRT_HALF]);
  });
});

describe("lookAtRotation", () => {
  it("looks along +Z from a point on -Z", () => {
    close(lookAtRotation([0, 0, -8], [0, 0, 0]), [0, 0, 0, 1]);
  });

  it("pitches down when looking at the origin from the default editor orbit", () => {
    const radius = 8;
    const alpha = -Math.PI / 2;
    const beta = Math.PI / 2.5;
    const from: [number, number, number] = [
      radius * Math.cos(alpha) * Math.sin(beta),
      radius * Math.cos(beta),
      radius * Math.sin(alpha) * Math.sin(beta),
    ];
    const euler = quaternionToEulerDegrees(lookAtRotation(from, [0, 0, 0]));
    expect(euler[0]).toBeCloseTo(18, 0);
    expect(euler[1]).toBeCloseTo(0, 1);
    expect(euler[2]).toBeCloseTo(0, 1);
  });
});

describe("quaternionToEulerDegrees", () => {
  it("maps identity quaternion to zero Euler", () => {
    close(quaternionToEulerDegrees([0, 0, 0, 1]), [0, 0, 0]);
  });

  it("round-trips authored Euler degrees", () => {
    const authored: [number, number, number] = [10, 20, 30];
    const quat = eulerDegreesToQuaternion(authored);
    close(quaternionToEulerDegrees(quat), authored, 4);
  });
});

describe("rotator object helpers", () => {
  it("round-trips rotator objects through quaternions", () => {
    const rotator = { pitch: 10, yaw: 20, roll: 30 };
    const back = quatToRotator(rotatorToQuat(rotator));
    expect(back.pitch).toBeCloseTo(10, 4);
    expect(back.yaw).toBeCloseTo(20, 4);
    expect(back.roll).toBeCloseTo(30, 4);
  });

  it("combines a 90 yaw with identity as 90 yaw", () => {
    const combined = combineRotators(
      { pitch: 0, yaw: 90, roll: 0 },
      { pitch: 0, yaw: 0, roll: 0 },
    );
    expect(combined.yaw).toBeCloseTo(90, 4);
  });

  it("inverts a yaw so combining returns identity", () => {
    const yaw = { pitch: 0, yaw: 45, roll: 0 };
    const identity = combineRotators(yaw, inverseRotator(yaw));
    expect(identity.pitch).toBeCloseTo(0, 4);
    expect(identity.yaw).toBeCloseTo(0, 4);
    expect(identity.roll).toBeCloseTo(0, 4);
  });

  it("rotates Babylon forward +Z by 90 yaw toward +X", () => {
    const forward = rotatorForward({ pitch: 0, yaw: 90, roll: 0 });
    expect(forward.x).toBeCloseTo(1, 4);
    expect(forward.y).toBeCloseTo(0, 4);
    expect(forward.z).toBeCloseTo(0, 4);
    const right = rotatorRight({ pitch: 0, yaw: 0, roll: 0 });
    expect(right.x).toBeCloseTo(1, 4);
    const up = rotatorUp({ pitch: 0, yaw: 0, roll: 0 });
    expect(up.y).toBeCloseTo(1, 4);
  });

  it("looks at a point along +Z as identity rotator", () => {
    const rotator = lookAtRotator(
      { x: 0, y: 0, z: -8 },
      { x: 0, y: 0, z: 0 },
    );
    expect(rotator.pitch).toBeCloseTo(0, 4);
    expect(rotator.yaw).toBeCloseTo(0, 4);
    expect(rotator.roll).toBeCloseTo(0, 4);
  });

  it("rotates a vector by a quaternion", () => {
    const q = rotatorToQuat({ pitch: 0, yaw: 90, roll: 0 });
    const rotated = quatRotateVector(q, { x: 0, y: 0, z: 1 });
    expect(rotated.x).toBeCloseTo(1, 4);
    expect(rotated.y).toBeCloseTo(0, 4);
    expect(rotated.z).toBeCloseTo(0, 4);
  });

  it("normalizes a quaternion to unit length", () => {
    const normalized = normalizeQuat({ x: 0, y: 0, z: 0, w: 2 });
    expect(normalized.x).toBeCloseTo(0, 4);
    expect(normalized.y).toBeCloseTo(0, 4);
    expect(normalized.z).toBeCloseTo(0, 4);
    expect(normalized.w).toBeCloseTo(1, 4);
  });
});
