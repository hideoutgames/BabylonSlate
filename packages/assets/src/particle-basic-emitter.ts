/**
 * Basic Particle Emitter payload: a module stack nested by stage, its normalizer, and
 * the Babylon-free plan that `@babylonslate/render` applies onto a GPU (or CPU
 * fallback) particle system (docs/design/particle-emitters.md, "Basic Particle Emitter").
 * The plan carries semantic ids only; render maps them to Babylon constants by name.
 */
import {
  PARTICLE_BILLBOARD_MODE_IDS,
  PARTICLE_BLEND_MODE_IDS,
  PARTICLE_CAPACITY_DEFAULT,
  PARTICLE_CAPACITY_MAX,
  PARTICLE_CAPACITY_MIN,
  PARTICLE_CPU_CAPACITY_BUDGET,
  PARTICLE_PREWARM_MAX_SECONDS,
  PARTICLE_UPDATE_SPEED,
  particlePrewarmSteps,
  type ParticleBillboardMode,
  type ParticleBlendMode,
  type ParticleLoopMode,
  type ParticleSpace,
} from "@babylonslate/core";
import { stableStringify } from "./bytes";
import { burstFireTimes, type ParticleBurst } from "./particle-schedule";
import {
  PARTICLE_COLOR_SPEC,
  PARTICLE_VALUE_SPECS,
  normalizeColorValue,
  normalizeScalarValue,
  sampleScalarCurve,
  scalarValueBounds,
  type ParticleColorTuple,
  type ParticleColorValue,
  type ParticleScalarKey,
  type ParticleScalarValue,
  type ParticleVec3Tuple,
} from "./particle-values";

/** Payload field; never a top-level `version` (the project service strips it). */
export const PARTICLE_EMITTER_SCHEMA_VERSION = 2 as const;
export const PARTICLE_BURST_MAX_ENTRIES = 8;

/** Authoring bounds shared by the normalizer and the Details panel. */
export const PARTICLE_EMITTER_LIMITS = {
  duration: { min: 0.05, max: 600 },
  prewarm: { min: 0, max: PARTICLE_PREWARM_MAX_SECONDS },
  burstTime: { min: 0, max: 600 },
  burstCount: { min: 1, max: PARTICLE_CAPACITY_MAX },
  /** 0 repeats every Interval until the cycle ends. */
  burstCycles: { min: 0, max: 64 },
  burstInterval: { min: 0.01, max: 600 },
  /** Zero radius with zero randomizer normalizes a zero vector on the GPU (NaN). */
  radius: { min: 0.001, max: 100 },
  /** Full cone opening angle in radians. */
  coneAngle: { min: 0.0175, max: Math.PI },
  height: { min: 0, max: 100 },
  boxExtent: { min: -100, max: 100 },
  /** Directions are not normalized: their length multiplies Speed. */
  direction: { min: -1000, max: 1000 },
  gravity: { min: -1000, max: 1000 },
} as const;

export type ParticleShapeDirection =
  | { mode: "radial"; randomizer: number }
  | {
      mode: "directed";
      direction1: ParticleVec3Tuple;
      direction2: ParticleVec3Tuple;
    };

export type ParticleEmitterShape =
  | {
      kind: "point";
      direction1: ParticleVec3Tuple;
      direction2: ParticleVec3Tuple;
    }
  | {
      kind: "box";
      min: ParticleVec3Tuple;
      max: ParticleVec3Tuple;
      direction1: ParticleVec3Tuple;
      direction2: ParticleVec3Tuple;
    }
  | {
      kind: "sphere";
      radius: number;
      radiusRange: number;
      direction: ParticleShapeDirection;
    }
  | {
      /** Babylon has no directed hemisphere. */
      kind: "hemisphere";
      radius: number;
      radiusRange: number;
      randomizer: number;
    }
  | {
      kind: "cylinder";
      radius: number;
      height: number;
      radiusRange: number;
      direction: ParticleShapeDirection;
    }
  | {
      kind: "cone";
      radius: number;
      angle: number;
      radiusRange: number;
      heightRange: number;
      emitFromSpawnPointOnly: boolean;
      direction: ParticleShapeDirection;
    };

export type ParticleShapeKind = ParticleEmitterShape["kind"];

export const PARTICLE_SHAPE_KINDS: readonly ParticleShapeKind[] = [
  "point",
  "box",
  "sphere",
  "hemisphere",
  "cylinder",
  "cone",
];

/** Optional modules carry `enabled`; a disabled module keeps its values. */
export type ParticleEmitterPayload = {
  schemaVersion: typeof PARTICLE_EMITTER_SCHEMA_VERSION;
  emitter: {
    loop: ParticleLoopMode;
    /** Seconds: loop length when infinite, run length when once. */
    duration: number;
    /** Seconds simulated before the first frame; infinite loops only. */
    prewarm: number;
    capacity: number;
  };
  spawn: {
    /** Always on; rate 0 gives a bursts-only emitter. */
    rate: ParticleScalarValue;
    bursts: { enabled: boolean; entries: ParticleBurst[] };
  };
  shape: ParticleEmitterShape;
  initialize: {
    lifetime: ParticleScalarValue;
    speed: ParticleScalarValue;
    size: ParticleScalarValue;
    color: ParticleColorValue;
    scale: { enabled: boolean; x: ParticleScalarValue; y: ParticleScalarValue };
    rotation: {
      enabled: boolean;
      start: ParticleScalarValue;
      speed: ParticleScalarValue;
    };
  };
  overLife: {
    velocity: { enabled: boolean; multiplier: ParticleScalarValue };
    speedLimit: {
      enabled: boolean;
      limit: ParticleScalarValue;
      /** 0..1, applied per update step while speed exceeds the limit. */
      damping: number;
    };
    drag: { enabled: boolean; amount: ParticleScalarValue };
  };
  forces: { gravity: { enabled: boolean; acceleration: ParticleVec3Tuple } };
  render: {
    materialGuid: string | null;
    blendMode: ParticleBlendMode;
    billboard: ParticleBillboardMode;
  };
};

const UP: ParticleVec3Tuple = [0, 1, 0];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function bounded(
  value: unknown,
  fallback: number,
  limits: { min: number; max: number },
): number {
  const finite =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return clamp(finite, limits.min, limits.max);
}

function boundedInt(
  value: unknown,
  fallback: number,
  limits: { min: number; max: number },
): number {
  return Math.round(bounded(value, fallback, limits));
}

function vec3(
  value: unknown,
  fallback: ParticleVec3Tuple,
  limits: { min: number; max: number },
): ParticleVec3Tuple {
  const source = Array.isArray(value) && value.length >= 3 ? value : fallback;
  return [
    bounded(source[0], fallback[0], limits),
    bounded(source[1], fallback[1], limits),
    bounded(source[2], fallback[2], limits),
  ];
}

function nullableGuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function oneOf<T extends string>(
  value: unknown,
  options: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (options as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

const unit = { min: 0, max: 1 };

/** Defaults for one shape kind; shape switches keep the fields both kinds share. */
export function createDefaultParticleShape(
  kind: ParticleShapeKind,
): ParticleEmitterShape {
  const radial = (): ParticleShapeDirection => ({ mode: "radial", randomizer: 0 });
  switch (kind) {
    case "point":
      return { kind, direction1: [...UP], direction2: [...UP] };
    case "box":
      return {
        kind,
        min: [-0.5, -0.5, -0.5],
        max: [0.5, 0.5, 0.5],
        direction1: [...UP],
        direction2: [...UP],
      };
    case "sphere":
      return { kind, radius: 0.5, radiusRange: 1, direction: radial() };
    case "hemisphere":
      return { kind, radius: 0.5, radiusRange: 1, randomizer: 0 };
    case "cylinder":
      return { kind, radius: 0.5, height: 1, radiusRange: 1, direction: radial() };
    case "cone":
      return {
        kind,
        radius: 0.1,
        angle: Math.PI / 6,
        radiusRange: 1,
        heightRange: 1,
        emitFromSpawnPointOnly: false,
        direction: radial(),
      };
  }
}

/** Defaults give a visible fountain once a Material is picked. */
export function createDefaultParticleEmitterPayload(): ParticleEmitterPayload {
  return normalizeParticleEmitterPayload({});
}

function normalizeDirection(value: unknown): ParticleShapeDirection {
  const rec = asRecord(value);
  if (rec.mode === "directed") {
    return {
      mode: "directed",
      direction1: vec3(rec.direction1, UP, PARTICLE_EMITTER_LIMITS.direction),
      direction2: vec3(rec.direction2, UP, PARTICLE_EMITTER_LIMITS.direction),
    };
  }
  return { mode: "radial", randomizer: bounded(rec.randomizer, 0, unit) };
}

function normalizeShape(value: unknown): ParticleEmitterShape {
  const rec = asRecord(value);
  const kind = oneOf(rec.kind, PARTICLE_SHAPE_KINDS, "cone");
  const base = createDefaultParticleShape(kind);
  const { direction: limit, radius, height, boxExtent, coneAngle } =
    PARTICLE_EMITTER_LIMITS;
  switch (base.kind) {
    case "point":
      return {
        kind: "point",
        direction1: vec3(rec.direction1, base.direction1, limit),
        direction2: vec3(rec.direction2, base.direction2, limit),
      };
    case "box": {
      const a = vec3(rec.min, base.min, boxExtent);
      const b = vec3(rec.max, base.max, boxExtent);
      return {
        kind: "box",
        min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
        max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
        direction1: vec3(rec.direction1, base.direction1, limit),
        direction2: vec3(rec.direction2, base.direction2, limit),
      };
    }
    case "sphere":
      return {
        kind: "sphere",
        radius: bounded(rec.radius, base.radius, radius),
        radiusRange: bounded(rec.radiusRange, base.radiusRange, unit),
        direction: normalizeDirection(rec.direction),
      };
    case "hemisphere":
      return {
        kind: "hemisphere",
        radius: bounded(rec.radius, base.radius, radius),
        radiusRange: bounded(rec.radiusRange, base.radiusRange, unit),
        randomizer: bounded(rec.randomizer, base.randomizer, unit),
      };
    case "cylinder":
      return {
        kind: "cylinder",
        radius: bounded(rec.radius, base.radius, radius),
        height: bounded(rec.height, base.height, height),
        radiusRange: bounded(rec.radiusRange, base.radiusRange, unit),
        direction: normalizeDirection(rec.direction),
      };
    case "cone":
      return {
        kind: "cone",
        radius: bounded(rec.radius, base.radius, radius),
        angle: bounded(rec.angle, base.angle, coneAngle),
        radiusRange: bounded(rec.radiusRange, base.radiusRange, unit),
        heightRange: bounded(rec.heightRange, base.heightRange, unit),
        emitFromSpawnPointOnly: rec.emitFromSpawnPointOnly === true,
        direction: normalizeDirection(rec.direction),
      };
  }
}

/** Keeps order, drops non-objects, caps at 8 entries and each count at `capacity`. */
function normalizeBursts(value: unknown, capacity: number): ParticleBurst[] {
  if (!Array.isArray(value)) return [];
  const limits = PARTICLE_EMITTER_LIMITS;
  const bursts: ParticleBurst[] = [];
  for (const entry of value) {
    if (bursts.length >= PARTICLE_BURST_MAX_ENTRIES) break;
    if (!isRecord(entry)) continue;
    bursts.push({
      time: bounded(entry.time, 0, limits.burstTime),
      count: Math.min(boundedInt(entry.count, 10, limits.burstCount), capacity),
      cycles: boundedInt(entry.cycles, 1, limits.burstCycles),
      interval: bounded(entry.interval, 0.5, limits.burstInterval),
    });
  }
  return bursts;
}

/**
 * Reads only the nested module shape. Old flat P17 fields (`emitRate`,
 * `textureGuid`, `sizeGradient`, …) are ignored and load as defaults (no migration).
 */
export function normalizeParticleEmitterPayload(
  value: unknown,
): ParticleEmitterPayload {
  const rec = asRecord(value);
  const emitter = asRecord(rec.emitter);
  const spawn = asRecord(rec.spawn);
  const bursts = asRecord(spawn.bursts);
  const initialize = asRecord(rec.initialize);
  const scale = asRecord(initialize.scale);
  const rotation = asRecord(initialize.rotation);
  const overLife = asRecord(rec.overLife);
  const velocity = asRecord(overLife.velocity);
  const speedLimit = asRecord(overLife.speedLimit);
  const drag = asRecord(overLife.drag);
  const gravity = asRecord(asRecord(rec.forces).gravity);
  const render = asRecord(rec.render);
  const specs = PARTICLE_VALUE_SPECS;
  const capacity = boundedInt(emitter.capacity, PARTICLE_CAPACITY_DEFAULT, {
    min: PARTICLE_CAPACITY_MIN,
    max: PARTICLE_CAPACITY_MAX,
  });
  return {
    schemaVersion: PARTICLE_EMITTER_SCHEMA_VERSION,
    emitter: {
      loop: emitter.loop === "once" ? "once" : "infinite",
      duration: bounded(emitter.duration, 2, PARTICLE_EMITTER_LIMITS.duration),
      prewarm: bounded(emitter.prewarm, 0, PARTICLE_EMITTER_LIMITS.prewarm),
      capacity,
    },
    spawn: {
      rate: normalizeScalarValue(spawn.rate, specs["spawn.rate"]),
      bursts: {
        enabled: bursts.enabled === true,
        entries: normalizeBursts(bursts.entries, capacity),
      },
    },
    shape: normalizeShape(rec.shape),
    initialize: {
      lifetime: normalizeScalarValue(
        initialize.lifetime,
        specs["initialize.lifetime"],
      ),
      speed: normalizeScalarValue(initialize.speed, specs["initialize.speed"]),
      size: normalizeScalarValue(initialize.size, specs["initialize.size"]),
      color: normalizeColorValue(initialize.color, PARTICLE_COLOR_SPEC),
      scale: {
        enabled: scale.enabled === true,
        x: normalizeScalarValue(scale.x, specs["initialize.scale.x"]),
        y: normalizeScalarValue(scale.y, specs["initialize.scale.y"]),
      },
      rotation: {
        enabled: rotation.enabled === true,
        start: normalizeScalarValue(
          rotation.start,
          specs["initialize.rotation.start"],
        ),
        speed: normalizeScalarValue(
          rotation.speed,
          specs["initialize.rotation.speed"],
        ),
      },
    },
    overLife: {
      velocity: {
        enabled: velocity.enabled === true,
        multiplier: normalizeScalarValue(
          velocity.multiplier,
          specs["overLife.velocity.multiplier"],
        ),
      },
      speedLimit: {
        enabled: speedLimit.enabled === true,
        limit: normalizeScalarValue(
          speedLimit.limit,
          specs["overLife.speedLimit.limit"],
        ),
        damping: bounded(speedLimit.damping, 0.4, unit),
      },
      drag: {
        enabled: drag.enabled === true,
        amount: normalizeScalarValue(drag.amount, specs["overLife.drag.amount"]),
      },
    },
    forces: {
      gravity: {
        enabled: gravity.enabled === true,
        acceleration: vec3(
          gravity.acceleration,
          [0, -9.81, 0],
          PARTICLE_EMITTER_LIMITS.gravity,
        ),
      },
    },
    render: {
      materialGuid: nullableGuid(render.materialGuid),
      blendMode: oneOf(render.blendMode, PARTICLE_BLEND_MODE_IDS, "additive"),
      billboard: oneOf(render.billboard, PARTICLE_BILLBOARD_MODE_IDS, "all"),
    },
  };
}

/** The CPU fallback caps capacity at `PARTICLE_CPU_CAPACITY_BUDGET`; the GPU keeps the authored value. */
export function resolveParticleEmitterCapacity(
  capacity: number,
  gpuSupported: boolean,
): number {
  const authored = clamp(
    Math.round(capacity),
    PARTICLE_CAPACITY_MIN,
    PARTICLE_CAPACITY_MAX,
  );
  if (gpuSupported) return authored;
  return Math.min(authored, PARTICLE_CPU_CAPACITY_BUDGET);
}

/** Which simulation the owning engine runs: CPU fallback, WebGL2 transform feedback or WebGPU compute. */
export type ParticleSimBackend = "cpu" | "transformFeedback" | "compute";
export type BasicPlanRange = { min: number; max: number };
export type BasicPlanFactorKey = { t: number; factor: number };
/** `color2` is set only for a Random Range colour; each particle then keeps one colour between the two. */
export type BasicPlanColorKey = {
  t: number;
  color1: ParticleColorTuple;
  color2: ParticleColorTuple | null;
};

/** Emitter-time state the owner drives each frame; never lowered to Babylon gradients. */
export type BasicEmissionSchedule = {
  loop: ParticleLoopMode;
  duration: number;
  rateCurve: ParticleScalarKey[] | null;
  lifetimeCurve: ParticleScalarKey[] | null;
  /** Empty when the Bursts module is disabled. */
  bursts: ParticleBurst[];
};

/**
 * Everything render writes onto one native system. A gradient replaces its fixed
 * counterpart in Babylon, so each property sets exactly one side.
 */
export type BasicEmitterPlan = {
  capacity: number;
  updateSpeed: number;
  /** `once` → duration; `infinite` → 0 (the owner wraps the cycle clock). */
  targetStopDuration: number;
  preWarmCycles: number;
  preWarmStepOffset: number;
  /** Constant rate, or the rate curve at the cycle start. */
  emitRate: number;
  lifeTime: BasicPlanRange;
  /** Longest lifetime any particle can get, including over a lifetime curve. */
  lifetimeBound: number;
  emitPower: BasicPlanRange;
  size: BasicPlanRange;
  scaleX: BasicPlanRange;
  scaleY: BasicPlanRange;
  initialRotation: BasicPlanRange;
  angularSpeed: BasicPlanRange;
  gravity: ParticleVec3Tuple;
  limitVelocityDamping: number;
  gradients: {
    /** Always at least one key. */
    color: BasicPlanColorKey[];
    size: BasicPlanFactorKey[] | null;
    angularSpeed: BasicPlanFactorKey[] | null;
    velocity: BasicPlanFactorKey[] | null;
    limitVelocity: BasicPlanFactorKey[] | null;
    drag: BasicPlanFactorKey[] | null;
  };
  shape: ParticleEmitterShape;
  blendMode: ParticleBlendMode;
  billboard: ParticleBillboardMode;
  isLocal: boolean;
  schedule: BasicEmissionSchedule;
};

const NEUTRAL: BasicPlanRange = { min: 1, max: 1 };
const ZERO: BasicPlanRange = { min: 0, max: 0 };

/** Fixed Babylon range: a curve contributes its value at x = 0. */
function startRange(value: ParticleScalarValue): BasicPlanRange {
  if (value.mode !== "curve") return scalarValueBounds(value);
  const start = sampleScalarCurve(value.keys, 0);
  return { min: start, max: start };
}

function factorKeys(keys: readonly ParticleScalarKey[]): BasicPlanFactorKey[] {
  return keys.map((key) => ({ t: key.t, factor: key.value }));
}

/** A constant over-life value is a single-key gradient, which Babylon holds flat. */
function overLifeKeys(value: ParticleScalarValue): BasicPlanFactorKey[] {
  return value.mode === "curve"
    ? factorKeys(value.keys)
    : [{ t: 0, factor: startRange(value).max }];
}

function colorKeys(value: ParticleColorValue): BasicPlanColorKey[] {
  if (value.mode === "constant") {
    return [{ t: 0, color1: [...value.color], color2: null }];
  }
  if (value.mode === "range") {
    return [{ t: 0, color1: [...value.min], color2: [...value.max] }];
  }
  return value.keys.map((key) => ({ t: key.t, color1: [...key.color], color2: null }));
}

function curveKeys(value: ParticleScalarValue): ParticleScalarKey[] | null {
  return value.mode === "curve" ? value.keys.map((key) => ({ ...key })) : null;
}

/**
 * Pure Basic → native mapping. On WebGL2 transform feedback Babylon does not normalize
 * the hemisphere direction, so Speed is divided by the radius there to match WebGPU
 * compute and the CPU (exact for surface spawns with a small randomizer).
 */
export function resolveBasicEmitterPlan(
  payload: ParticleEmitterPayload,
  options: { backend: ParticleSimBackend; space: ParticleSpace },
): BasicEmitterPlan {
  const { emitter, spawn, shape, initialize, overLife, forces, render } = payload;
  const prewarm = particlePrewarmSteps(
    emitter.loop === "infinite" ? emitter.prewarm : 0,
  );
  const speed = scalarValueBounds(initialize.speed);
  const speedScale =
    options.backend === "transformFeedback" && shape.kind === "hemisphere"
      ? 1 / Math.max(shape.radius, PARTICLE_EMITTER_LIMITS.radius.min)
      : 1;
  const { scale, rotation } = initialize;
  const angular = rotation.enabled ? rotation.speed : null;
  return {
    capacity: resolveParticleEmitterCapacity(
      emitter.capacity,
      options.backend !== "cpu",
    ),
    updateSpeed: PARTICLE_UPDATE_SPEED,
    targetStopDuration: emitter.loop === "once" ? emitter.duration : 0,
    preWarmCycles: prewarm.cycles,
    preWarmStepOffset: prewarm.stepOffset,
    emitRate: startRange(spawn.rate).max,
    lifeTime: startRange(initialize.lifetime),
    lifetimeBound: scalarValueBounds(initialize.lifetime).max,
    emitPower: { min: speed.min * speedScale, max: speed.max * speedScale },
    size: startRange(initialize.size),
    scaleX: scale.enabled ? scalarValueBounds(scale.x) : { ...NEUTRAL },
    scaleY: scale.enabled ? scalarValueBounds(scale.y) : { ...NEUTRAL },
    initialRotation: rotation.enabled
      ? scalarValueBounds(rotation.start)
      : { ...ZERO },
    angularSpeed:
      angular && angular.mode !== "curve"
        ? scalarValueBounds(angular)
        : { ...ZERO },
    gravity: forces.gravity.enabled
      ? [...forces.gravity.acceleration]
      : [0, 0, 0],
    limitVelocityDamping: overLife.speedLimit.damping,
    gradients: {
      color: colorKeys(initialize.color),
      size:
        initialize.size.mode === "curve"
          ? factorKeys(initialize.size.keys)
          : null,
      angularSpeed: angular?.mode === "curve" ? factorKeys(angular.keys) : null,
      velocity: overLife.velocity.enabled
        ? overLifeKeys(overLife.velocity.multiplier)
        : null,
      limitVelocity: overLife.speedLimit.enabled
        ? overLifeKeys(overLife.speedLimit.limit)
        : null,
      drag: overLife.drag.enabled ? overLifeKeys(overLife.drag.amount) : null,
    },
    shape: structuredClone(shape),
    blendMode: render.blendMode,
    billboard: render.billboard,
    isLocal: options.space === "local",
    schedule: {
      loop: emitter.loop,
      duration: emitter.duration,
      rateCurve: curveKeys(spawn.rate),
      lifetimeCurve: curveKeys(initialize.lifetime),
      bursts: spawn.bursts.enabled
        ? spawn.bursts.entries.map((burst) => ({ ...burst }))
        : [],
    },
  };
}

/** Fire events above this make the Capacity hint report an unbounded need. */
const SLOT_NEED_EVENT_LIMIT = 4096;

/**
 * Upper bound of simultaneously live particles, for the editor's Capacity hint:
 * rate × longest lifetime plus the peak burst particles in any lifetime-long window
 * (across loop wraps). Infinity when bursts fire more than 4096 events in that span.
 */
export function basicEmitterSlotNeed(payload: ParticleEmitterPayload): number {
  const { emitter, spawn, initialize } = payload;
  const lifetime = scalarValueBounds(initialize.lifetime).max;
  const once = emitter.loop === "once";
  const rateSpan = once ? Math.min(lifetime, emitter.duration) : lifetime;
  // The epsilon keeps float products such as 30 × 1.2 from rounding up a whole particle.
  const rateNeed = Math.max(
    0,
    Math.ceil(scalarValueBounds(spawn.rate).max * rateSpan - 1e-9),
  );
  if (!spawn.bursts.enabled) return rateNeed;
  const cycles = once ? 1 : Math.ceil(lifetime / emitter.duration) + 1;
  const events: Array<{ time: number; count: number }> = [];
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    for (const burst of spawn.bursts.entries) {
      const remaining = SLOT_NEED_EVENT_LIMIT - events.length;
      const times = burstFireTimes(burst, emitter.duration, remaining + 1);
      if (times.length > remaining) return Number.POSITIVE_INFINITY;
      for (const time of times) {
        events.push({ time: cycle * emitter.duration + time, count: burst.count });
      }
    }
  }
  events.sort((a, b) => a.time - b.time);
  let peak = 0;
  let live = 0;
  let oldest = 0;
  for (const event of events) {
    live += event.count;
    // A particle fired `lifetime` ago has died by now (age ≥ life).
    while (events[oldest]!.time <= event.time - lifetime) {
      live -= events[oldest]!.count;
      oldest += 1;
    }
    peak = Math.max(peak, live);
  }
  return rateNeed + peak;
}

export type ParticleEmitterChangeTier = "none" | "live" | "respawn" | "rebuild";

const TIER_PLAN_OPTIONS = { backend: "compute", space: "world" } as const;

function gradientSignature(plan: BasicEmitterPlan): string {
  const { color, ...factors } = plan.gradients;
  const present = Object.values(factors).map((keys) => (keys ? "1" : "0"));
  return `${present.join("")}:${color[0]?.color2 ? "color2" : "color"}`;
}

function gradientKeyCounts(plan: BasicEmitterPlan): string {
  return Object.values(plan.gradients)
    .map((keys) => keys?.length ?? 0)
    .join(",");
}

/** Emitter class plus the options that change GPU update-shader defines. */
function shapeClass(shape: ParticleEmitterShape): string {
  const direction = "direction" in shape ? shape.direction.mode : "";
  const spawnPoint =
    shape.kind === "cone" && shape.emitFromSpawnPointOnly ? "spawnPoint" : "";
  return `${shape.kind}:${direction}:${spawnPoint}`;
}

/**
 * How a running preview applies an edit (docs/design/particle-emitters.md, "Live edits"):
 * - `live`: uniforms, owner-driven curves, bursts and same-count gradient keys; particles survive.
 * - `respawn`: shape class, gradient key counts, or a blend change into or out of Multiply
 *   (WebGL2 records its vertex arrays per program); GPU particles restart.
 * - `rebuild`: capacity, loop, prewarm, a `once` duration, material, billboard, or a
 *   gradient appearing, disappearing or gaining `color2`; the emitter is recreated.
 */
export function particleEmitterChangeTier(
  prev: ParticleEmitterPayload,
  next: ParticleEmitterPayload,
): ParticleEmitterChangeTier {
  if (stableStringify(prev) === stableStringify(next)) return "none";
  const a = resolveBasicEmitterPlan(prev, TIER_PLAN_OPTIONS);
  const b = resolveBasicEmitterPlan(next, TIER_PLAN_OPTIONS);
  if (
    prev.emitter.capacity !== next.emitter.capacity ||
    prev.emitter.loop !== next.emitter.loop ||
    a.targetStopDuration !== b.targetStopDuration ||
    a.preWarmCycles !== b.preWarmCycles ||
    a.preWarmStepOffset !== b.preWarmStepOffset ||
    prev.render.materialGuid !== next.render.materialGuid ||
    prev.render.billboard !== next.render.billboard ||
    gradientSignature(a) !== gradientSignature(b)
  ) {
    return "rebuild";
  }
  if (
    shapeClass(prev.shape) !== shapeClass(next.shape) ||
    gradientKeyCounts(a) !== gradientKeyCounts(b) ||
    (prev.render.blendMode === "multiply") !==
      (next.render.blendMode === "multiply")
  ) {
    return "respawn";
  }
  return "live";
}
