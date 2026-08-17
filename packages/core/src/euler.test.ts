import { describe, expect, it } from "vitest";
import {
  eulerDegreesToQuaternion,
  lookAtRotation,
  quaternionToEulerDegrees,
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
