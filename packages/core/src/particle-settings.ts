/**
 * Particle literals and budgets shared by the Basic Particle Emitter schema
 * (`@babylonslate/assets`) and the Babylon-free Particle Graph IR, which cannot
 * import assets. Documents store only these string ids; `@babylonslate/render`
 * maps them to Babylon constants by name (docs/design/particle-emitters.md D7).
 */

/** Additive = Babylon ONEONE, Normal = STANDARD, Alpha Additive = ADD. */
export const PARTICLE_BLEND_MODE_IDS = [
  "additive",
  "standard",
  "add",
  "multiply",
  "subtract",
] as const;
export type ParticleBlendMode = (typeof PARTICLE_BLEND_MODE_IDS)[number];

/** Camera Facing, Y Axis, Stretched (aligned to velocity). */
export const PARTICLE_BILLBOARD_MODE_IDS = ["all", "y", "stretched"] as const;
export type ParticleBillboardMode = (typeof PARTICLE_BILLBOARD_MODE_IDS)[number];

export type ParticleSpace = "world" | "local";
export type ParticleLoopMode = "infinite" | "once";

export const PARTICLE_CAPACITY_MIN = 16;
export const PARTICLE_CAPACITY_MAX = 4096;
export const PARTICLE_CAPACITY_DEFAULT = 256;
/** CPU simulation cap: the Basic CPU fallback clamps to it, Particle Graph warns above it. */
export const PARTICLE_CPU_CAPACITY_BUDGET = 512;
export const PARTICLE_SYSTEM_MAX_EMITTERS = 8;
export const PARTICLE_CURVE_MIN_KEYS = 2;
export const PARTICLE_CURVE_MAX_KEYS = 8;
/** Seconds per animation-ratio unit, so rates are /s and lifetimes are s. */
export const PARTICLE_UPDATE_SPEED = 1 / 60;
export const PARTICLE_PREWARM_MAX_SECONDS = 10;
export const PARTICLE_PREWARM_CYCLES_MAX = 60;

/**
 * Babylon prewarm steps that simulate `seconds` at `PARTICLE_UPDATE_SPEED`:
 * `cycles × stepOffset / 60 === seconds`. Steps are 1/30 s until the cycle cap,
 * then grow. Zero or invalid seconds give no prewarm and a harmless offset of 1.
 */
export function particlePrewarmSteps(seconds: number): {
  cycles: number;
  stepOffset: number;
} {
  const cycles =
    Number.isFinite(seconds) && seconds > 0
      ? Math.min(PARTICLE_PREWARM_CYCLES_MAX, Math.ceil(seconds * 30))
      : 0;
  return { cycles, stepOffset: cycles ? (seconds * 60) / cycles : 1 };
}
