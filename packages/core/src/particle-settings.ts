/**
 * Particle literals and budgets shared by the Basic Particle Emitter schema
 * (`@haptic/assets`) and the Babylon-free Particle Graph IR, which cannot
 * import assets. Documents store only these string ids; `@haptic/render`
 * maps them to Babylon constants by name (.agents/reference/architecture/particles.md, "Decisions").
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
const PARTICLE_PREWARM_CYCLES_MAX = 60;

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

/** Why a ParticleComponent stopped playing, as the render host reports it (`particlePlaybackEnded`). */
export type ParticlePlaybackEndReason = "finished" | "stopped" | "failed";

/** Script-facing `engine:ParticlesFinishedReason`, the Reason of Event On Particles Finished. */
export const ENGINE_PARTICLES_FINISHED_REASON_ENUM_ID = "engine:ParticlesFinishedReason";
/** Finished: a Once system ran out. Stopped: Stop drained it. */
export const PARTICLES_FINISHED_REASONS = ["Finished", "Stopped"] as const;
export type ParticlesFinishedReason = (typeof PARTICLES_FINISHED_REASONS)[number];

/** Spawn Particles effects alive at once; beyond it the oldest is stopped and destroyed after its drain. */
export const PARTICLE_TRANSIENT_EFFECT_BUDGET = 256;

/**
 * ParticleComponent Retrigger: what Play does to a run that is still on screen. Overlap lets it
 * finish as a ghost (a playing run only when every emitter is Once) while a new run starts;
 * Restart cuts it and starts again.
 */
export const PARTICLE_RETRIGGER_MODES = ["overlap", "restart"] as const;
export type ParticleRetrigger = (typeof PARTICLE_RETRIGGER_MODES)[number];
export const PARTICLE_RETRIGGER_LABELS: Record<ParticleRetrigger, string> = { overlap: "Overlap", restart: "Restart" };
/** Overlapped runs kept per ParticleComponent; the oldest is cut beyond it. */
export const PARTICLE_GHOSTS_PER_COMPONENT = 3;

export function parseParticleRetrigger(value: unknown): ParticleRetrigger {
  return value === "restart" ? "restart" : "overlap";
}

/** A particle parameter's value type (Basic emitters bind Float, Vector3 and Color only). */
export type ParticleParameterValueType = "float" | "vec2" | "vec3" | "color";
/** One parameter a Particle System's slots declare: its type and default are the first declaring slot's, or the System's own default. */
export type ParticleParameterCatalogEntry = { name: string; type: ParticleParameterValueType; defaultValue: number[] };
/**
 * Each Particle System's parameters by System guid, as the game Worker reads them for Get, Set
 * and Reset Particle Parameter. Built from the session's particle library; Babylon-free.
 */
export type ParticleParameterCatalog = Readonly<Record<string, readonly ParticleParameterCatalogEntry[]>>;

/** The value types a parameter can hold across Particle Graphs and Global Parameter Collections. A Particle Graph has no Vector4. */
type ParameterValueType = ParticleParameterValueType | "vec4";
const PARAMETER_VALUE_WIDTHS: Readonly<Record<ParameterValueType, number>> = { float: 1, vec2: 2, vec3: 3, vec4: 4, color: 4 };

/** `value` as `type`: one number splats, missing components are 0 (Color alpha 1), extras are dropped. */
export function resizeParticleParameterValue(value: readonly unknown[] | undefined, type: ParameterValueType): number[] {
  const width = PARAMETER_VALUE_WIDTHS[type];
  const source = (value ?? []).map((component) => (typeof component === "number" && Number.isFinite(component) ? component : 0));
  if (source.length === 1) return Array.from({ length: width }, () => source[0]!);
  return Array.from({ length: width }, (_, index) => (index < source.length ? source[index]! : type === "color" && index === 3 ? 1 : 0));
}

