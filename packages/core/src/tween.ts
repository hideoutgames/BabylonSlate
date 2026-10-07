import type { RotatorObject } from "./euler";
import type { Quat, Transform, Vec3 } from "./math-rng";

export const ENGINE_TWEEN_SPACE_ENUM_ID = "engine:TweenSpace";
export const TWEEN_SPACES = ["local", "world"] as const;
export type TweenTransformSpace = (typeof TWEEN_SPACES)[number];
export const TWEEN_SPACE_LABELS: Record<TweenTransformSpace, string> = { local: "Local", world: "World" };

export type TweenValueMap = {
  float: number;
  int: number;
  vec2: { x: number; y: number };
  vec3: Vec3;
  vec4: { x: number; y: number; z: number; w: number };
  rotator: RotatorObject;
  quat: Quat;
  /** The graph Color value uses x/y/z/w for red/green/blue/alpha. */
  color: { x: number; y: number; z: number; w: number };
  transform: Transform;
};
export type TweenValueType = keyof TweenValueMap;
export type TweenValue = TweenValueMap[TweenValueType];

function numericFields<K extends string>(value: unknown, keys: readonly K[]): Record<K, number> | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    if (value.length !== keys.length || keys.some((_, index) => typeof value[index] !== "number" || !Number.isFinite(value[index]))) return null;
    return Object.fromEntries(keys.map((key, index) => [key, value[index]])) as Record<K, number>;
  }
  const source = value as Record<string, unknown>;
  const result = {} as Record<K, number>;
  for (const key of keys) {
    const number = source[key];
    if (typeof number !== "number" || !Number.isFinite(number)) return null;
    result[key] = number;
  }
  return result;
}

function unitQuaternion(value: Quat): Quat | null {
  const length = Math.hypot(value.x, value.y, value.z, value.w);
  if (!Number.isFinite(length) || length === 0) return null;
  return { x: value.x / length, y: value.y / length, z: value.z / length, w: value.w / length };
}

/** Validate and snapshot endpoints so later source edits cannot change a running tween. */
export function cloneTweenValue<T extends TweenValueType>(type: T, value: unknown): TweenValueMap[T] | null;
export function cloneTweenValue(type: TweenValueType, value: unknown): TweenValue | null {
  switch (type) {
    case "float": return typeof value === "number" && Number.isFinite(value) ? value : null;
    case "int": return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
    case "vec2": return numericFields(value, ["x", "y"]);
    case "vec3": return numericFields(value, ["x", "y", "z"]);
    case "vec4": return numericFields(value, ["x", "y", "z", "w"]);
    case "color": return numericFields(Array.isArray(value) && value.length === 3 ? [...value, 1] : value, ["x", "y", "z", "w"]);
    case "rotator": return numericFields(value, ["pitch", "yaw", "roll"]);
    case "quat": {
      const quaternion = numericFields(value, ["x", "y", "z", "w"]);
      return quaternion ? unitQuaternion(quaternion) : null;
    }
    case "transform": {
      if (!value || typeof value !== "object") return null;
      const source = value as Record<string, unknown>;
      const position = cloneTweenValue("vec3", source.position);
      const rotation = cloneTweenValue("quat", source.rotation);
      const scale = cloneTweenValue("vec3", source.scale);
      return position && rotation && scale ? { position, rotation, scale } : null;
    }
  }
  return null;
}

function lerp(a: number, b: number, alpha: number): number {
  const value = a * (1 - alpha) + b * alpha;
  if (!Number.isFinite(value)) throw new RangeError("Tween interpolation exceeded the finite numeric range.");
  return value;
}

function lerpFields<K extends string>(a: Record<K, number>, b: Record<K, number>, keys: readonly K[], alpha: number): Record<K, number> {
  const result = {} as Record<K, number>;
  for (const key of keys) result[key] = lerp(a[key], b[key], alpha);
  return result;
}

/** Shortest-path unit-quaternion interpolation, including easing overshoot. */
function interpolateQuaternion(a: Quat, b: Quat, alpha: number): Quat {
  const left = unitQuaternion(a)!;
  let right = unitQuaternion(b)!;
  let dot = left.x * right.x + left.y * right.y + left.z * right.z + left.w * right.w;
  if (dot < 0) {
    right = { x: -right.x, y: -right.y, z: -right.z, w: -right.w };
    dot = -dot;
  }
  const angle = Math.acos(Math.min(1, dot));
  const sinAngle = Math.sin(angle);
  if (sinAngle < 1e-8) return unitQuaternion(lerpFields(left, right, ["x", "y", "z", "w"], alpha))!;
  const from = Math.sin((1 - alpha) * angle) / sinAngle;
  const to = Math.sin(alpha * angle) / sinAngle;
  const result = unitQuaternion({
    x: left.x * from + right.x * to,
    y: left.y * from + right.y * to,
    z: left.z * from + right.z * to,
    w: left.w * from + right.w * to,
  });
  if (!result) throw new RangeError("Tween rotation interpolation exceeded the finite numeric range.");
  return result;
}

/** Interpolate validated endpoints. Alpha is an eased value and must not be clamped. */
export function interpolateTweenValue<T extends TweenValueType>(type: T, a: TweenValueMap[T], b: TweenValueMap[T], alpha: number): TweenValueMap[T];
export function interpolateTweenValue(type: TweenValueType, a: TweenValue, b: TweenValue, alpha: number): TweenValue {
  if (!Number.isFinite(alpha)) throw new RangeError("Tween alpha must be finite.");
  if (alpha === 0) return cloneTweenValue(type, a)!;
  if (alpha === 1) return cloneTweenValue(type, b)!;
  switch (type) {
    case "float": return lerp(a as number, b as number, alpha);
    case "int": return Math.round(lerp(a as number, b as number, alpha));
    case "vec2": return lerpFields(a as TweenValueMap["vec2"], b as TweenValueMap["vec2"], ["x", "y"], alpha);
    case "vec3": return lerpFields(a as Vec3, b as Vec3, ["x", "y", "z"], alpha);
    case "vec4":
    case "color": return lerpFields(a as Quat, b as Quat, ["x", "y", "z", "w"], alpha);
    case "quat": return interpolateQuaternion(a as Quat, b as Quat, alpha);
    // Rotators interpolate the authored degrees, so 0 -> 360 spins a full turn
    // and 170 -> -170 sweeps 340 degrees. Quaternion channels take the short path.
    case "rotator": return lerpFields(a as RotatorObject, b as RotatorObject, ["pitch", "yaw", "roll"], alpha);
    case "transform": {
      const left = a as Transform;
      const right = b as Transform;
      return {
        position: lerpFields(left.position, right.position, ["x", "y", "z"], alpha),
        rotation: interpolateQuaternion(left.rotation, right.rotation, alpha),
        scale: lerpFields(left.scale, right.scale, ["x", "y", "z"], alpha),
      };
    }
  }
}
