import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPRING_ARM_PROPERTIES,
  parseSpringArmProperties,
  springArmChildOffset,
  stepSpringArmLag,
  type SpringArmPose,
} from "./spring-arm-component";
import { normalizeScene } from "./scene";

const IDENTITY: SpringArmPose["rotation"] = [0, 0, 0, 1];
const YAW_90: SpringArmPose["rotation"] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

function lagged(overrides: Partial<typeof DEFAULT_SPRING_ARM_PROPERTIES>) {
  return { ...DEFAULT_SPRING_ARM_PROPERTIES, enableLocationLag: true, enableRotationLag: true, ...overrides };
}

describe("spring arm component", () => {
  it("bounds authored values and normalizes them on scene load", () => {
    expect(parseSpringArmProperties({ armLength: -3, locationLagSpeed: 0, rotationLagSpeed: 1e9, maxLocationLagDistance: -1, enableLocationLag: "yes" }))
      .toEqual({ ...DEFAULT_SPRING_ARM_PROPERTIES, armLength: 0, locationLagSpeed: 0.1, rotationLagSpeed: 100 });
    const scene = normalizeScene({ actors: [{ id: "hero", components: [
      { id: "arm", classId: "SpringArmComponent", properties: { armLength: 6, enableRotationLag: true, armLengthTypo: 1 } },
    ] }] });
    expect(scene.actors[0]!.components[0]!.properties).toEqual({ ...DEFAULT_SPRING_ARM_PROPERTIES, armLength: 6, enableRotationLag: true });
  });

  it("offsets children to the socket behind a spring arm parent only", () => {
    expect(springArmChildOffset({ classId: "SpringArmComponent", properties: { armLength: 2.5 } })).toEqual([0, 0, -2.5]);
    expect(springArmChildOffset({ classId: "MeshComponent", properties: { armLength: 2.5 } })).toBeNull();
    expect(springArmChildOffset(undefined)).toBeNull();
  });

  it("snaps on the first step and follows exactly when lag is disabled", () => {
    const target: SpringArmPose = { position: [4, 0, 0], rotation: YAW_90 };
    expect(stepSpringArmLag(null, target, 1 / 60, lagged({}))).toEqual(target);
    const previous: SpringArmPose = { position: [0, 0, 0], rotation: IDENTITY };
    expect(stepSpringArmLag(previous, target, 1 / 60, DEFAULT_SPRING_ARM_PROPERTIES)).toEqual(target);
  });

  it("closes the location gap exponentially regardless of frame rate", () => {
    const properties = lagged({ locationLagSpeed: 5, enableRotationLag: false });
    const start: SpringArmPose = { position: [0, 0, 0], rotation: IDENTITY };
    const target: SpringArmPose = { position: [10, 0, 0], rotation: IDENTITY };
    const oneStep = stepSpringArmLag(start, target, 0.05, properties);
    const twoSteps = stepSpringArmLag(stepSpringArmLag(start, target, 0.025, properties), target, 0.025, properties);
    expect(oneStep.position[0]).toBeCloseTo(10 * (1 - Math.exp(-0.25)), 10);
    expect(twoSteps.position[0]).toBeCloseTo(oneStep.position[0], 10);
    expect(stepSpringArmLag(start, target, 0, properties).position).toEqual([0, 0, 0]);
  });

  it("keeps the lagged pivot within the maximum lag distance", () => {
    const properties = lagged({ locationLagSpeed: 1, maxLocationLagDistance: 2, enableRotationLag: false });
    const next = stepSpringArmLag({ position: [0, 0, 0], rotation: IDENTITY }, { position: [0, 0, 10], rotation: IDENTITY }, 1 / 60, properties);
    expect(next.position[0]).toBe(0);
    expect(next.position[2]).toBeCloseTo(8, 10);
  });

  it("slerps rotation partway toward the target and keeps it normalized", () => {
    const properties = lagged({ rotationLagSpeed: Math.log(2) / 0.05, enableLocationLag: false });
    const next = stepSpringArmLag({ position: [0, 0, 0], rotation: IDENTITY }, { position: [1, 2, 3], rotation: YAW_90 }, 0.05, properties);
    expect(next.position).toEqual([1, 2, 3]);
    const yaw = 2 * Math.atan2(next.rotation[1], next.rotation[3]);
    expect(yaw).toBeCloseTo(Math.PI / 4, 6);
    expect(Math.hypot(...next.rotation)).toBeCloseTo(1, 10);
  });
});
