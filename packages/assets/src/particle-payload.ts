/** A16-oriented particle budgets (engineplan §2.7). Matches Babylon GPU/CPU shared surface. */

export const PARTICLE_CAPACITY_MIN = 16;
export const PARTICLE_CAPACITY_MAX = 4096;
export const PARTICLE_CAPACITY_DEFAULT = 256;
export const PARTICLE_CPU_FALLBACK_CAPACITY = 512;
export const PARTICLE_SYSTEM_MAX_EMITTERS = 8;
export const PARTICLE_GRADIENT_MIN_KEYS = 2;
export const PARTICLE_GRADIENT_MAX_KEYS = 8;
export const PARTICLE_PREWARM_CYCLES_MAX = 60;

/** Babylon `ParticleSystem.BLENDMODE_STANDARD`. */
export const PARTICLE_BLENDMODE_STANDARD = 0;
/** Babylon `ParticleSystem.BLENDMODE_ONEONE` (additive). */
export const PARTICLE_BLENDMODE_ONEONE = 1;
/** Babylon `Mesh.BILLBOARDMODE_ALL`. */
export const PARTICLE_BILLBOARDMODE_ALL = 7;

export const PARTICLE_ASSET_TYPES = ["ParticleEmitter", "ParticleSystem"] as const;
export type ParticleAssetType = (typeof PARTICLE_ASSET_TYPES)[number];

export type ParticleBlendMode = "standard" | "additive";
export type ParticleSpace = "world" | "local";

export type ParticleVec3Tuple = [number, number, number];
export type ParticleColorTuple = [number, number, number, number];

export type ParticleColorKey = { t: number; color: ParticleColorTuple };
export type ParticleScalarKey = { t: number; value: number };

export type ParticlePointShape = {
  kind: "point";
  direction1: ParticleVec3Tuple;
  direction2: ParticleVec3Tuple;
};

export type ParticleBoxShape = {
  kind: "box";
  min: ParticleVec3Tuple;
  max: ParticleVec3Tuple;
  direction1: ParticleVec3Tuple;
  direction2: ParticleVec3Tuple;
};

export type ParticleSphereShape = {
  kind: "sphere";
  radius: number;
  radiusRange: number;
};

export type ParticleConeShape = {
  kind: "cone";
  radius: number;
  angle: number;
};

export type ParticleEmitterShape =
  | ParticlePointShape
  | ParticleBoxShape
  | ParticleSphereShape
  | ParticleConeShape;

export type ParticleEmitterPayload = {
  textureGuid: string | null;
  materialGuid: string | null;
  capacity: number;
  emitRate: number;
  shape: ParticleEmitterShape;
  minLifeTime: number;
  maxLifeTime: number;
  minEmitPower: number;
  maxEmitPower: number;
  gravity: ParticleVec3Tuple;
  minSize: number;
  maxSize: number;
  sizeGradient: ParticleScalarKey[];
  colorGradient: ParticleColorKey[];
  minAngularSpeed: number;
  maxAngularSpeed: number;
  angularSpeedGradient: ParticleScalarKey[] | null;
  dragGradient: ParticleScalarKey[] | null;
  blendMode: ParticleBlendMode;
  preWarmCycles: number;
  preWarmStepOffset: number;
};

export type ParticleSystemPayload = {
  emitterGuids: string[];
  space: ParticleSpace;
  looping: boolean;
  duration: number;
};

export type ParticleDiagnostic = {
  code: string;
  message: string;
  guid?: string;
};

export type ParticleVec3 = { x: number; y: number; z: number };
export type ParticleColor4Like = { r: number; g: number; b: number; a: number };

export type ParticleApplyTarget = {
  emitRate: number;
  minLifeTime: number;
  maxLifeTime: number;
  minEmitPower: number;
  maxEmitPower: number;
  gravity: ParticleVec3;
  minSize: number;
  maxSize: number;
  minAngularSpeed: number;
  maxAngularSpeed: number;
  isLocal: boolean;
  isBillboardBased: boolean;
  billboardMode: number;
  blendMode: number;
  preWarmCycles: number;
  preWarmStepOffset: number;
  targetStopDuration: number;
  capacity?: number;
  activeParticleCount?: number;
  addColorGradient: (gradient: number, color: ParticleColor4Like) => void;
  addSizeGradient: (gradient: number, factor: number) => void;
  addAngularSpeedGradient?: (gradient: number, factor: number) => void;
  addDragGradient?: (gradient: number, factor: number) => void;
  createPointEmitter: (
    direction1: ParticleVec3,
    direction2: ParticleVec3,
  ) => unknown;
  createBoxEmitter: (
    direction1: ParticleVec3,
    direction2: ParticleVec3,
    min: ParticleVec3,
    max: ParticleVec3,
  ) => unknown;
  createSphereEmitter: (radius: number, radiusRange: number) => unknown;
  createConeEmitter: (radius: number, angle: number) => unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nullableGuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function nonNegative(value: unknown, fallback: number): number {
  return Math.max(0, finiteNumber(value, fallback));
}

function vec3(value: unknown, fallback: ParticleVec3Tuple): ParticleVec3Tuple {
  if (!Array.isArray(value) || value.length < 3) return [...fallback];
  return [
    finiteNumber(value[0], fallback[0]),
    finiteNumber(value[1], fallback[1]),
    finiteNumber(value[2], fallback[2]),
  ];
}

function toVec3(tuple: ParticleVec3Tuple): ParticleVec3 {
  return { x: tuple[0], y: tuple[1], z: tuple[2] };
}

function color4(
  value: unknown,
  fallback: ParticleColorTuple,
): ParticleColorTuple {
  if (!Array.isArray(value) || value.length < 4) return [...fallback];
  return [
    clamp(finiteNumber(value[0], fallback[0]), 0, 1),
    clamp(finiteNumber(value[1], fallback[1]), 0, 1),
    clamp(finiteNumber(value[2], fallback[2]), 0, 1),
    clamp(finiteNumber(value[3], fallback[3]), 0, 1),
  ];
}

function defaultColorGradient(): ParticleColorKey[] {
  return [
    { t: 0, color: [1, 1, 1, 1] },
    { t: 1, color: [1, 1, 1, 0] },
  ];
}

function defaultSizeGradient(): ParticleScalarKey[] {
  return [
    { t: 0, value: 1 },
    { t: 1, value: 0 },
  ];
}

function defaultPointShape(): ParticlePointShape {
  return {
    kind: "point",
    direction1: [0, 1, 0],
    direction2: [0, 1, 0],
  };
}

export function createDefaultParticleEmitterPayload(): ParticleEmitterPayload {
  return {
    textureGuid: null,
    materialGuid: null,
    capacity: PARTICLE_CAPACITY_DEFAULT,
    emitRate: 30,
    shape: defaultPointShape(),
    minLifeTime: 0.8,
    maxLifeTime: 1.2,
    minEmitPower: 1,
    maxEmitPower: 2,
    gravity: [0, 0, 0],
    minSize: 0.2,
    maxSize: 0.4,
    sizeGradient: defaultSizeGradient(),
    colorGradient: defaultColorGradient(),
    minAngularSpeed: 0,
    maxAngularSpeed: 0,
    angularSpeedGradient: null,
    dragGradient: null,
    blendMode: "additive",
    preWarmCycles: 0,
    preWarmStepOffset: 1,
  };
}

export function createDefaultParticleSystemPayload(): ParticleSystemPayload {
  return {
    emitterGuids: [],
    space: "world",
    looping: true,
    duration: 2,
  };
}

function orderedRange(
  minValue: unknown,
  maxValue: unknown,
  minFallback: number,
  maxFallback: number,
): { min: number; max: number } {
  const min = nonNegative(minValue, minFallback);
  const max = nonNegative(maxValue, maxFallback);
  return min <= max ? { min, max } : { min: max, max: min };
}

function normalizeColorGradient(value: unknown): ParticleColorKey[] {
  if (!Array.isArray(value)) return defaultColorGradient();
  const keys: ParticleColorKey[] = [];
  for (const entry of value) {
    const rec = asRecord(entry);
    keys.push({
      t: clamp(finiteNumber(rec.t, 0), 0, 1),
      color: color4(rec.color, [1, 1, 1, 1]),
    });
  }
  if (keys.length < PARTICLE_GRADIENT_MIN_KEYS) return defaultColorGradient();
  keys.sort((a, b) => a.t - b.t);
  const limited = keys.slice(0, PARTICLE_GRADIENT_MAX_KEYS);
  limited[0]!.t = 0;
  limited[limited.length - 1]!.t = 1;
  return limited;
}

function normalizeSizeGradient(value: unknown): ParticleScalarKey[] {
  if (!Array.isArray(value)) return defaultSizeGradient();
  const keys: ParticleScalarKey[] = [];
  for (const entry of value) {
    const rec = asRecord(entry);
    keys.push({
      t: clamp(finiteNumber(rec.t, 0), 0, 1),
      value: nonNegative(rec.value, 1),
    });
  }
  if (keys.length < PARTICLE_GRADIENT_MIN_KEYS) return defaultSizeGradient();
  keys.sort((a, b) => a.t - b.t);
  const limited = keys.slice(0, PARTICLE_GRADIENT_MAX_KEYS);
  limited[0]!.t = 0;
  limited[limited.length - 1]!.t = 1;
  return limited;
}

function normalizeOptionalScalarGradient(
  value: unknown,
): ParticleScalarKey[] | null {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length < PARTICLE_GRADIENT_MIN_KEYS) {
    return null;
  }
  return normalizeSizeGradient(value);
}

function normalizeDragGradient(value: unknown): ParticleScalarKey[] | null {
  if (value == null || !Array.isArray(value) || value.length === 0) return null;
  const keys: ParticleScalarKey[] = [];
  for (const entry of value) {
    const rec = asRecord(entry);
    keys.push({
      t: clamp(finiteNumber(rec.t, 0), 0, 1),
      value: nonNegative(rec.value, 0),
    });
  }
  if (keys.length === 0) return null;
  const atZero = keys.find((key) => key.t === 0);
  const atOne = keys.find((key) => key.t === 1);
  const start =
    atZero?.value ??
    keys.reduce((best, key) => (key.t < best.t ? key : best)).value;
  const end =
    atOne?.value ??
    keys.reduce((best, key) => (key.t > best.t ? key : best)).value;
  return [
    { t: 0, value: start },
    { t: 1, value: end },
  ];
}

function normalizeShape(value: unknown): ParticleEmitterShape {
  const rec = asRecord(value);
  const kind = rec.kind;
  if (kind === "box") {
    return {
      kind: "box",
      min: vec3(rec.min, [-0.5, -0.5, -0.5]),
      max: vec3(rec.max, [0.5, 0.5, 0.5]),
      direction1: vec3(rec.direction1, [0, 1, 0]),
      direction2: vec3(rec.direction2, [0, 1, 0]),
    };
  }
  if (kind === "sphere") {
    return {
      kind: "sphere",
      radius: nonNegative(rec.radius, 1),
      radiusRange: clamp(finiteNumber(rec.radiusRange, 1), 0, 1),
    };
  }
  if (kind === "cone") {
    return {
      kind: "cone",
      radius: nonNegative(rec.radius, 0.5),
      angle: clamp(finiteNumber(rec.angle, 0.5), 0, Math.PI),
    };
  }
  return {
    kind: "point",
    direction1: vec3(rec.direction1, [0, 1, 0]),
    direction2: vec3(rec.direction2, [0, 1, 0]),
  };
}

export function normalizeParticleEmitterPayload(
  value: unknown,
): ParticleEmitterPayload {
  const rec = asRecord(value);
  const defaults = createDefaultParticleEmitterPayload();
  const life = orderedRange(
    rec.minLifeTime,
    rec.maxLifeTime,
    defaults.minLifeTime,
    defaults.maxLifeTime,
  );
  const emit = orderedRange(
    rec.minEmitPower,
    rec.maxEmitPower,
    defaults.minEmitPower,
    defaults.maxEmitPower,
  );
  const size = orderedRange(
    rec.minSize,
    rec.maxSize,
    defaults.minSize,
    defaults.maxSize,
  );
  const angular = orderedRange(
    rec.minAngularSpeed,
    rec.maxAngularSpeed,
    defaults.minAngularSpeed,
    defaults.maxAngularSpeed,
  );
  return {
    textureGuid: nullableGuid(rec.textureGuid),
    materialGuid: nullableGuid(rec.materialGuid),
    capacity: clamp(
      Math.round(finiteNumber(rec.capacity, defaults.capacity)),
      PARTICLE_CAPACITY_MIN,
      PARTICLE_CAPACITY_MAX,
    ),
    emitRate: nonNegative(rec.emitRate, defaults.emitRate),
    shape: normalizeShape(rec.shape),
    minLifeTime: life.min,
    maxLifeTime: life.max,
    minEmitPower: emit.min,
    maxEmitPower: emit.max,
    gravity: vec3(rec.gravity, defaults.gravity),
    minSize: size.min,
    maxSize: size.max,
    sizeGradient: normalizeSizeGradient(rec.sizeGradient),
    colorGradient: normalizeColorGradient(rec.colorGradient),
    minAngularSpeed: angular.min,
    maxAngularSpeed: angular.max,
    angularSpeedGradient: normalizeOptionalScalarGradient(
      rec.angularSpeedGradient,
    ),
    dragGradient: normalizeDragGradient(rec.dragGradient),
    blendMode: rec.blendMode === "standard" ? "standard" : "additive",
    preWarmCycles: clamp(
      Math.round(nonNegative(rec.preWarmCycles, defaults.preWarmCycles)),
      0,
      PARTICLE_PREWARM_CYCLES_MAX,
    ),
    preWarmStepOffset: nonNegative(
      rec.preWarmStepOffset,
      defaults.preWarmStepOffset,
    ),
  };
}

export function normalizeParticleSystemPayload(
  value: unknown,
): ParticleSystemPayload {
  const rec = asRecord(value);
  const defaults = createDefaultParticleSystemPayload();
  const guids: string[] = [];
  const raw = Array.isArray(rec.emitterGuids) ? rec.emitterGuids : [];
  for (const entry of raw) {
    const guid = nullableGuid(entry);
    if (!guid) continue;
    guids.push(guid);
    if (guids.length >= PARTICLE_SYSTEM_MAX_EMITTERS) break;
  }
  return {
    emitterGuids: guids,
    space: rec.space === "local" ? "local" : "world",
    looping: rec.looping === false ? false : true,
    duration: nonNegative(rec.duration, defaults.duration),
  };
}

function collectGuids(values: Array<string | null | undefined>): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    if (value) unique.add(value);
  }
  return [...unique].sort();
}

export function particleAssetDependencies(
  assetType: string,
  payload: Record<string, unknown>,
): string[] {
  if (assetType === "ParticleEmitter") {
    const emitter = normalizeParticleEmitterPayload(payload);
    return collectGuids([emitter.textureGuid, emitter.materialGuid]);
  }
  if (assetType === "ParticleSystem") {
    const system = normalizeParticleSystemPayload(payload);
    return collectGuids(system.emitterGuids);
  }
  return [];
}

export function resolveParticleReferences(
  assetType: string,
  payload: Record<string, unknown>,
  existingGuids: ReadonlySet<string>,
): {
  payload: ParticleEmitterPayload | ParticleSystemPayload;
  diagnostics: ParticleDiagnostic[];
} {
  const diagnostics: ParticleDiagnostic[] = [];
  if (assetType === "ParticleSystem") {
    const system = normalizeParticleSystemPayload(payload);
    const emitterGuids = system.emitterGuids.filter((guid) => {
      if (existingGuids.has(guid)) return true;
      diagnostics.push({
        code: "particle.missing_emitter",
        message: "Particle System references a missing Particle Emitter.",
        guid,
      });
      return false;
    });
    return { payload: { ...system, emitterGuids }, diagnostics };
  }
  const emitter = normalizeParticleEmitterPayload(payload);
  let textureGuid = emitter.textureGuid;
  let materialGuid = emitter.materialGuid;
  if (textureGuid && !existingGuids.has(textureGuid)) {
    diagnostics.push({
      code: "particle.missing_texture",
      message: "Particle Emitter references a missing Texture.",
      guid: textureGuid,
    });
    textureGuid = null;
  }
  if (materialGuid && !existingGuids.has(materialGuid)) {
    diagnostics.push({
      code: "particle.missing_material",
      message: "Particle Emitter references a missing Material.",
      guid: materialGuid,
    });
    materialGuid = null;
  }
  return { payload: { ...emitter, textureGuid, materialGuid }, diagnostics };
}

export function remapParticlePayloadGuids(
  assetType: string,
  payload: Record<string, unknown>,
  remap: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const rewrite = (guid: string | null): string | null =>
    guid ? (remap.get(guid) ?? guid) : null;
  if (assetType === "ParticleEmitter") {
    const emitter = normalizeParticleEmitterPayload(payload);
    return {
      ...emitter,
      textureGuid: rewrite(emitter.textureGuid),
      materialGuid: rewrite(emitter.materialGuid),
    };
  }
  if (assetType === "ParticleSystem") {
    const system = normalizeParticleSystemPayload(payload);
    return {
      ...system,
      emitterGuids: system.emitterGuids.map(
        (guid) => remap.get(guid) ?? guid,
      ),
    };
  }
  return payload;
}

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
  return Math.min(authored, PARTICLE_CPU_FALLBACK_CAPACITY);
}

export function applyParticleEmitterPayload(
  payload: ParticleEmitterPayload,
  system: ParticleApplyTarget,
  options: {
    space: ParticleSpace;
    looping: boolean;
    duration: number;
    gpuSupported: boolean;
  },
): { appliedCapacity: number } {
  const appliedCapacity = resolveParticleEmitterCapacity(
    payload.capacity,
    options.gpuSupported,
  );
  system.capacity = appliedCapacity;
  if ("activeParticleCount" in system) {
    system.activeParticleCount = appliedCapacity;
  }
  system.emitRate = payload.emitRate;
  system.minLifeTime = payload.minLifeTime;
  system.maxLifeTime = payload.maxLifeTime;
  system.minEmitPower = payload.minEmitPower;
  system.maxEmitPower = payload.maxEmitPower;
  system.gravity = toVec3(payload.gravity);
  system.minSize = payload.minSize;
  system.maxSize = payload.maxSize;
  system.isLocal = options.space === "local";
  system.isBillboardBased = true;
  system.billboardMode = PARTICLE_BILLBOARDMODE_ALL;
  system.blendMode =
    payload.blendMode === "standard"
      ? PARTICLE_BLENDMODE_STANDARD
      : PARTICLE_BLENDMODE_ONEONE;
  system.preWarmCycles = payload.preWarmCycles;
  system.preWarmStepOffset = payload.preWarmStepOffset;
  system.targetStopDuration = options.looping ? 0 : options.duration;

  const shape = payload.shape;
  if (shape.kind === "box") {
    system.createBoxEmitter(
      toVec3(shape.direction1),
      toVec3(shape.direction2),
      toVec3(shape.min),
      toVec3(shape.max),
    );
  } else if (shape.kind === "sphere") {
    system.createSphereEmitter(shape.radius, shape.radiusRange);
  } else if (shape.kind === "cone") {
    system.createConeEmitter(shape.radius, shape.angle);
  } else {
    system.createPointEmitter(
      toVec3(shape.direction1),
      toVec3(shape.direction2),
    );
  }

  for (const key of payload.colorGradient) {
    system.addColorGradient(key.t, {
      r: key.color[0],
      g: key.color[1],
      b: key.color[2],
      a: key.color[3],
    });
  }
  for (const key of payload.sizeGradient) {
    system.addSizeGradient(key.t, key.value);
  }
  if (payload.angularSpeedGradient && system.addAngularSpeedGradient) {
    system.minAngularSpeed = 0;
    system.maxAngularSpeed = 0;
    for (const key of payload.angularSpeedGradient) {
      system.addAngularSpeedGradient(key.t, key.value);
    }
  } else {
    system.minAngularSpeed = payload.minAngularSpeed;
    system.maxAngularSpeed = payload.maxAngularSpeed;
  }
  if (payload.dragGradient && system.addDragGradient) {
    for (const key of payload.dragGradient) {
      system.addDragGradient(key.t, key.value);
    }
  }
  return { appliedCapacity };
}
