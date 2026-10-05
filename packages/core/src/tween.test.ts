import { describe, expect, it } from "vitest";
import { quatRotateVector } from "./euler";
import { cloneTweenValue, interpolateTweenValue, type TweenValue, type TweenValueType } from "./tween";
import { identityTransform } from "./math-rng";

describe("tween values", () => {
  it("snapshots native property arrays and nested endpoints independently of their source", () => {
    const transform = identityTransform();
    transform.position.x = 5;
    transform.rotation.w = 2;
    const saved = cloneTweenValue("transform", transform)!;
    transform.position.x = 100;
    transform.rotation.w = 0;
    expect(saved).toEqual({ position: { x: 5, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } });
    expect(cloneTweenValue("color", [0.2, 0.4, 0.6])).toEqual({ x: 0.2, y: 0.4, z: 0.6, w: 1 });
    expect(cloneTweenValue("color", [0.2, 0.4, 0.6, 0.5])).toEqual({ x: 0.2, y: 0.4, z: 0.6, w: 0.5 });
    expect(cloneTweenValue("vec3", [1, 2, 3])).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("rejects non-finite or incomplete endpoints before they can corrupt a live property", () => {
    expect(cloneTweenValue("float", Infinity)).toBeNull();
    expect(cloneTweenValue("vec3", [1, 2])).toBeNull();
    expect(cloneTweenValue("vec3", { x: 1, y: 2, z: NaN })).toBeNull();
    expect(cloneTweenValue("color", [1, 1, "red"])).toBeNull();
    expect(cloneTweenValue("quat", { x: 0, y: 0, z: 0, w: 0 })).toBeNull();
    expect(cloneTweenValue("transform", { ...identityTransform(), scale: { x: 1 } })).toBeNull();
    expect(() => interpolateTweenValue("float", -1e308, 1e308, 1.5)).toThrow(RangeError);
    expect(interpolateTweenValue("float", -1e308, 1e308, 0.5)).toBe(0);
  });

  it.each<[TweenValueType, TweenValue, TweenValue, TweenValue]>([
    ["float", 10, 30, 15],
    ["int", 0, 10, 3],
    ["vec2", { x: 0, y: 8 }, { x: 8, y: 0 }, { x: 2, y: 6 }],
    ["vec3", { x: 0, y: 8, z: -8 }, { x: 8, y: 0, z: 8 }, { x: 2, y: 6, z: -4 }],
    ["vec4", { x: 0, y: 8, z: -8, w: 4 }, { x: 8, y: 0, z: 8, w: 12 }, { x: 2, y: 6, z: -4, w: 6 }],
    ["color", { x: 0, y: 1, z: 0, w: 1 }, { x: 1, y: 0, z: 1, w: 0 }, { x: 0.25, y: 0.75, z: 0.25, w: 0.75 }],
  ])("interpolates %s channels and rounds integer samples", (type, a, b, expected) => {
    expect(interpolateTweenValue(type, a, b, 0.25)).toEqual(expected);
  });

  it("takes the short rotation path across 180 degrees without losing exact authored endpoints", () => {
    const a = { pitch: 0, yaw: 170, roll: 0 };
    const b = { pitch: 0, yaw: -170, roll: 0 };
    const midpoint = interpolateTweenValue("rotator", a, b, 0.5);
    expect(Math.abs(midpoint.yaw)).toBeCloseTo(180);
    expect(midpoint.pitch).toBeCloseTo(0);
    expect(midpoint.roll).toBeCloseTo(0);
    expect(interpolateTweenValue("rotator", a, b, 1)).toEqual(b);
  });

  it("keeps rotational easing overshoot and unit length, including equivalent antipodal quaternions", () => {
    const a = { x: 0, y: 0, z: 0, w: 1 };
    const b = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
    const overshoot = interpolateTweenValue("quat", a, b, 1.5);
    const direction = quatRotateVector(overshoot, { x: 0, y: 0, z: 1 });
    expect(direction.x).toBeCloseTo(Math.SQRT1_2);
    expect(direction.z).toBeCloseTo(-Math.SQRT1_2);
    expect(Math.hypot(overshoot.x, overshoot.y, overshoot.z, overshoot.w)).toBeCloseTo(1);
    const antipodal = interpolateTweenValue("quat", b, { x: 0, y: -Math.SQRT1_2, z: 0, w: -Math.SQRT1_2 }, 0.5);
    expect(quatRotateVector(antipodal, { x: 0, y: 0, z: 1 }).x).toBeCloseTo(1);
    expect(interpolateTweenValue("float", 0, 10, -0.25)).toBe(-2.5);
  });

  it("interpolates the whole transform without mixing quaternion and vector semantics", () => {
    const a = identityTransform();
    const b = { position: { x: 8, y: 4, z: -2 }, rotation: { x: 0, y: 1, z: 0, w: 0 }, scale: { x: 3, y: 5, z: 7 } };
    const midpoint = interpolateTweenValue("transform", a, b, 0.5);
    expect(midpoint.position).toEqual({ x: 4, y: 2, z: -1 });
    expect(midpoint.scale).toEqual({ x: 2, y: 3, z: 4 });
    expect(quatRotateVector(midpoint.rotation, { x: 0, y: 0, z: 1 }).x).toBeCloseTo(1);
    expect(midpoint.rotation.w).toBeCloseTo(Math.SQRT1_2);
    midpoint.position.x = 100;
    expect(a.position.x).toBe(0);
    expect(b.position.x).toBe(8);
  });
});
