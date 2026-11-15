/**
 * Spring Bones settings, as a Spring Bones node stores them and render simulates them (Kawaii-style): every bone below
 * the Root Bone follows its animated position through a damped spring, collides, keeps its length and is limited,
 * then the chain becomes bone rotations. Lengths are in actor-space units (meters for an unscaled actor), angles in
 * degrees, and forces in units per second squared.
 */

import { ANIM_BONE_AXES, type AnimBoneAxis, type AnimLayerMaskRef } from "./anim-bone-pose";

/** One key of a multiplier along the chain: `t` 0 at the Root Bone, 1 at the tip. */
export interface AnimChainCurveKey {
  t: number;
  value: number;
}

export const ANIM_SPRING_COLLIDER_KINDS = ["sphere", "capsule", "plane"] as const;
export type AnimSpringColliderKind = (typeof ANIM_SPRING_COLLIDER_KINDS)[number];
export const ANIM_SPRING_COLLIDER_LABELS: Record<AnimSpringColliderKind, string> = {
  sphere: "Sphere",
  capsule: "Capsule",
  plane: "Plane",
};

/**
 * A collider bound to a bone: centred at `offset` in the bone's axes. A capsule runs `length` along `axis` through the
 * centre; a plane passes through the centre with `axis` as its normal, keeping the chain on that side.
 */
export interface AnimSpringCollider {
  kind: AnimSpringColliderKind;
  bone: string;
  offset: number[];
  radius: number;
  length: number;
  axis: AnimBoneAxis;
}

export const ANIM_SPRING_PLANAR_CONSTRAINTS = ["none", "x", "y", "z"] as const;
export type AnimSpringPlanarConstraint = (typeof ANIM_SPRING_PLANAR_CONSTRAINTS)[number];
export const ANIM_SPRING_PLANAR_LABELS: Record<AnimSpringPlanarConstraint, string> = {
  none: "None",
  x: "Lock X",
  y: "Lock Y",
  z: "Lock Z",
};

/** The curves along the chain: multipliers of Stiffness, Damping, Radius and Limit Angle. Empty multiplies by 1. */
export interface AnimSpringCurves {
  stiffness: AnimChainCurveKey[];
  damping: AnimChainCurveKey[];
  radius: AnimChainCurveKey[];
  limitAngle: AnimChainCurveKey[];
}

export interface AnimSpringBoneSettings {
  /** Bones whose branches leave the chain. */
  excludeBones: string[];
  /** Pull back toward the animated pose each 1/120 s step, 0 to 1. */
  stiffness: number;
  /** Speed lost each step, 0 to 1. */
  damping: number;
  /** How much of the actor's movement the chain ignores, 0 (all of it trails) to 1 (none). */
  worldDampingLocation: number;
  /** How much of the actor's turning the chain ignores, 0 to 1. */
  worldDampingRotation: number;
  /** World-space acceleration. */
  gravity: number[];
  /** World-space direction of the wind, and its strength; its gusts follow `windSeed`. */
  windDirection: number[];
  windStrength: number;
  windSeed: number;
  /** Each bone's collision radius. */
  radius: number;
  /** The furthest a bone turns from its animated direction; 0 is no limit. */
  limitDegrees: number;
  curves: AnimSpringCurves;
  colliders: AnimSpringCollider[];
  /** An actor axis the chain does not move along. */
  planarConstraint: AnimSpringPlanarConstraint;
  /** A move of the actor further than this in one tick resets the chain to its pose; 0 never resets. */
  teleportDistance: number;
  /** A turn of the actor further than this in one tick resets the chain; 0 never resets. */
  teleportDegrees: number;
  /** A tip past each last bone, so that bone swings too; 0 adds none. */
  tipLength: number;
}

export const ANIM_SPRING_DEFAULTS: Readonly<Omit<AnimSpringBoneSettings, "excludeBones" | "curves" | "colliders">> = {
  stiffness: 0.05,
  damping: 0.1,
  worldDampingLocation: 0.8,
  worldDampingRotation: 0.8,
  gravity: [0, 0, 0],
  windDirection: [1, 0, 0],
  windStrength: 0,
  windSeed: 0,
  radius: 0.03,
  limitDegrees: 0,
  planarConstraint: "none",
  teleportDistance: 3,
  teleportDegrees: 30,
  tipLength: 0,
};

/** A Spring Bones change render simulates: the chain under `bone`, stepped by the tick's `dtSeconds`. */
export interface AnimSpringBonesChange {
  kind: "springBones";
  bone: string;
  alpha: number;
  dtSeconds: number;
  settings: AnimSpringBoneSettings;
  masks?: AnimLayerMaskRef[];
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function unit(value: unknown, fallback: number): number {
  return Math.min(1, Math.max(0, finite(value, fallback)));
}

function nonNegative(value: unknown, fallback: number): number {
  return Math.max(0, finite(value, fallback));
}

function vector(value: unknown, fallback: readonly number[]): number[] {
  const row = Array.isArray(value) ? value : [];
  return [0, 1, 2].map((i) => finite(row[i], fallback[i] ?? 0));
}

/** Curve keys as stored, cleaned: finite, `t` within 0–1, sorted. */
export function normalizeAnimChainCurve(value: unknown): AnimChainCurveKey[] {
  if (!Array.isArray(value)) return [];
  const keys: AnimChainCurveKey[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.t !== "number" || typeof row.value !== "number" || !Number.isFinite(row.t) || !Number.isFinite(row.value)) continue;
    keys.push({ t: Math.min(1, Math.max(0, row.t)), value: row.value });
  }
  return keys.sort((a, b) => a.t - b.t);
}

/** A chain curve's multiplier at `t`, linear between keys and held past the ends; 1 without keys. */
export function animChainCurveAt(keys: readonly AnimChainCurveKey[], t: number): number {
  if (keys.length === 0) return 1;
  if (t <= keys[0]!.t) return keys[0]!.value;
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i]!;
    if (t > b.t) continue;
    const a = keys[i - 1]!;
    return b.t > a.t ? a.value + ((b.value - a.value) * (t - a.t)) / (b.t - a.t) : b.value;
  }
  return keys[keys.length - 1]!.value;
}

function collider(value: unknown): AnimSpringCollider | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const kind = ANIM_SPRING_COLLIDER_KINDS.find((entry) => entry === row.kind) ?? "sphere";
  return {
    kind,
    bone: typeof row.bone === "string" ? row.bone : "",
    offset: vector(row.offset, [0, 0, 0]),
    radius: nonNegative(row.radius, 0.1),
    length: nonNegative(row.length, 0.2),
    axis: ANIM_BONE_AXES.find((entry) => entry === row.axis) ?? "y",
  };
}

/** A new collider's settings: a sphere on `bone`. */
export function defaultAnimSpringCollider(bone: string): AnimSpringCollider {
  return { kind: "sphere", bone, offset: [0, 0, 0], radius: 0.1, length: 0.2, axis: "y" };
}

/** A Spring Bones node's settings as stored on it, cleaned and with defaults filled. */
export function normalizeAnimSpringBoneSettings(data: Record<string, unknown>): AnimSpringBoneSettings {
  const d = ANIM_SPRING_DEFAULTS;
  const exclude = Array.isArray(data.excludeBones) ? data.excludeBones : [];
  const colliders = Array.isArray(data.colliders) ? data.colliders : [];
  return {
    excludeBones: [...new Set(exclude.filter((bone): bone is string => typeof bone === "string" && bone.trim() !== ""))],
    stiffness: unit(data.stiffness, d.stiffness),
    damping: unit(data.damping, d.damping),
    worldDampingLocation: unit(data.worldDampingLocation, d.worldDampingLocation),
    worldDampingRotation: unit(data.worldDampingRotation, d.worldDampingRotation),
    gravity: vector(data.gravity, d.gravity),
    windDirection: vector(data.windDirection, d.windDirection),
    windStrength: nonNegative(data.windStrength, d.windStrength),
    windSeed: Math.round(finite(data.windSeed, d.windSeed)),
    radius: nonNegative(data.radius, d.radius),
    limitDegrees: Math.min(180, nonNegative(data.limitDegrees, d.limitDegrees)),
    curves: {
      stiffness: normalizeAnimChainCurve(data.stiffnessCurve),
      damping: normalizeAnimChainCurve(data.dampingCurve),
      radius: normalizeAnimChainCurve(data.radiusCurve),
      limitAngle: normalizeAnimChainCurve(data.limitAngleCurve),
    },
    colliders: colliders.map(collider).filter((entry): entry is AnimSpringCollider => entry !== null && entry.bone !== ""),
    planarConstraint: ANIM_SPRING_PLANAR_CONSTRAINTS.find((entry) => entry === data.planarConstraint) ?? d.planarConstraint,
    teleportDistance: nonNegative(data.teleportDistance, d.teleportDistance),
    teleportDegrees: Math.min(180, nonNegative(data.teleportDegrees, d.teleportDegrees)),
    tipLength: nonNegative(data.tipLength, d.tipLength),
  };
}

/** A seed's two gust phases, deterministic per seed. */
function gustPhases(seed: number): [number, number] {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return [((h & 0xffff) / 0xffff) * Math.PI * 2, (((h >>> 16) & 0xffff) / 0xffff) * Math.PI * 2];
}

/** The wind's share of its strength at simulated time `seconds`: a gust between 0.25 and 1 that the seed shapes. */
export function animWindGust(seed: number, seconds: number): number {
  const [a, b] = gustPhases(seed);
  return 0.625 + 0.25 * Math.sin(1.3 * seconds + a) + 0.125 * Math.sin(3.1 * seconds + b);
}
