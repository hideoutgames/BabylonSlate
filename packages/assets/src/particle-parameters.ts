/**
 * Particle parameters (.agents/reference/architecture/particles.md, "Parameters"): values
 * gameplay sets by name. Each emitter declares the parameters it reads (a Particle Graph its
 * `parameters`, a Basic emitter its `bindings`); a Particle System's set is their union by name.
 * Effective value per slot = component runtime value ?? component override ?? System default ??
 * emitter default, resized to the emitter's type. Babylon-free: render applies the result.
 */
import {
  normalizeParticleParameterName,
  resizeParticleValue,
  type ParticleGraphDocument,
  type ParticleNumericType,
} from "@haptic/particle-graph";
import type { ParticleParameterCatalogEntry } from "@haptic/core";
import type { BasicEmitterPlan } from "./particle-basic-emitter";
import type { ParticleLibrary, ParticleLibraryEmitter } from "./particle-library";

export type ParticleParameterType = ParticleNumericType;

/** Basic emitter targets a parameter can drive. Extend only by adding targets; never bind arbitrary fields. */
export const PARTICLE_BASIC_BINDING_TARGETS = {
  "spawn.rateScale": { type: "float", label: "Spawn Rate Scale", defaultValue: [1] },
  "spawn.burstScale": { type: "float", label: "Burst Count Scale", defaultValue: [1] },
  "init.lifetimeScale": { type: "float", label: "Lifetime Scale", defaultValue: [1] },
  "init.speedScale": { type: "float", label: "Speed Scale", defaultValue: [1] },
  "init.sizeScale": { type: "float", label: "Size Scale", defaultValue: [1] },
  "init.colorTint": { type: "color", label: "Color Tint", defaultValue: [1, 1, 1, 1] },
  "forces.gravity": { type: "vec3", label: "Gravity", defaultValue: [0, -9.81, 0] },
} as const satisfies Record<string, { type: ParticleParameterType; label: string; defaultValue: readonly number[] }>;

export type ParticleBasicBindingTarget = keyof typeof PARTICLE_BASIC_BINDING_TARGETS;
export const PARTICLE_BASIC_BINDING_TARGET_IDS = Object.keys(PARTICLE_BASIC_BINDING_TARGETS) as ParticleBasicBindingTarget[];
export const PARTICLE_BASIC_BINDINGS_MAX = 16;

export type ParticleBasicBinding = {
  target: ParticleBasicBindingTarget;
  parameterName: string;
  /** Sized to the target's type. */
  defaultValue: number[];
};

/** A parameter one emitter declares. */
export type ParticleEmitterParameter = { name: string; type: ParticleParameterType; defaultValue: number[] };

function isTarget(value: unknown): value is ParticleBasicBindingTarget {
  return typeof value === "string" && Object.hasOwn(PARTICLE_BASIC_BINDING_TARGETS, value);
}

function numbers(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((component) => typeof component === "number" && Number.isFinite(component))) return null;
  return [...value] as number[];
}

/**
 * One binding per target, at most 16, each with a valid name; a name already bound to a target
 * of another type is dropped (one name has one type per emitter).
 */
export function normalizeParticleBasicBindings(value: unknown): ParticleBasicBinding[] {
  if (!Array.isArray(value)) return [];
  const bindings: ParticleBasicBinding[] = [];
  const targets = new Set<string>();
  const types = new Map<string, ParticleParameterType>();
  for (const entry of value) {
    if (bindings.length >= PARTICLE_BASIC_BINDINGS_MAX) break;
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const name = normalizeParticleParameterName(record.parameterName);
    if (!isTarget(record.target) || !name || targets.has(record.target)) continue;
    const spec = PARTICLE_BASIC_BINDING_TARGETS[record.target];
    if ((types.get(name) ?? spec.type) !== spec.type) continue;
    targets.add(record.target);
    types.set(name, spec.type);
    bindings.push({
      target: record.target,
      parameterName: name,
      defaultValue: resizeParticleValue(numbers(record.defaultValue) ?? [...spec.defaultValue], spec.type),
    });
  }
  return bindings;
}

/** Parameter values by name: trimmed valid names with finite number arrays; anything else is dropped. */
export function normalizeParticleParameterValues(value: unknown): Record<string, number[]> {
  const values: Record<string, number[]> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return values;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const name = normalizeParticleParameterName(key);
    const parsed = numbers(entry);
    if (name && parsed) values[name] = parsed;
  }
  return values;
}

/** The parameters an emitter reads: a graph's declarations, or a Basic emitter's bound names (first binding's default). */
function particleEmitterParameters(emitter: ParticleLibraryEmitter): ParticleEmitterParameter[] {
  if (emitter.kind === "graph") return graphParameters(emitter.document);
  const parameters = new Map<string, ParticleEmitterParameter>();
  for (const binding of emitter.payload.bindings) {
    if (parameters.has(binding.parameterName)) continue;
    const spec = PARTICLE_BASIC_BINDING_TARGETS[binding.target];
    parameters.set(binding.parameterName, { name: binding.parameterName, type: spec.type, defaultValue: [...binding.defaultValue] });
  }
  return [...parameters.values()];
}

function graphParameters(document: ParticleGraphDocument): ParticleEmitterParameter[] {
  return (document.parameters ?? []).map((parameter) => ({ name: parameter.name, type: parameter.type, defaultValue: [...parameter.defaultValue] }));
}

export type ParticleSystemParameter = {
  name: string;
  type: ParticleParameterType;
  /** The System's override, else the first slot's emitter default. */
  defaultValue: number[];
  /** Whether `defaultValue` is the System's own override. */
  overridden: boolean;
  /** Slot indices that read it with this type. */
  slots: number[];
};

export type ParticleSystemParameterConflict = {
  name: string;
  /** The type the first slot declares; the System's parameter has it. */
  type: ParticleParameterType;
  /** Slots that declare another type; they ignore runtime values and use their own defaults. */
  slots: number[];
};

/**
 * A Particle System's derived parameters: the union by name of its slot emitters' parameters,
 * in first-use order. The first slot that declares a name decides its type; a slot that declares
 * it with another type is a conflict (`particle.parameter_type_conflict`).
 */
export function particleSystemParameters(
  library: ParticleLibrary,
  systemGuid: string,
): { parameters: ParticleSystemParameter[]; conflicts: ParticleSystemParameterConflict[] } {
  const system = library.systems.get(systemGuid);
  const parameters = new Map<string, ParticleSystemParameter>();
  const conflicts = new Map<string, ParticleSystemParameterConflict>();
  if (!system) return { parameters: [], conflicts: [] };
  system.emitterGuids.forEach((guid, slot) => {
    const emitter = library.emitters.get(guid);
    if (!emitter) return;
    for (const declared of particleEmitterParameters(emitter)) {
      const existing = parameters.get(declared.name);
      if (!existing) {
        const override = system.parameterDefaults?.[declared.name];
        parameters.set(declared.name, {
          name: declared.name,
          type: declared.type,
          defaultValue: override ? resizeParticleValue(override, declared.type) : declared.defaultValue,
          overridden: Boolean(override),
          slots: [slot],
        });
      } else if (existing.type === declared.type) {
        if (!existing.slots.includes(slot)) existing.slots.push(slot);
      } else {
        const conflict = conflicts.get(declared.name) ?? { name: declared.name, type: existing.type, slots: [] };
        if (!conflict.slots.includes(slot)) conflict.slots.push(slot);
        conflicts.set(declared.name, conflict);
      }
    }
  });
  return { parameters: [...parameters.values()], conflicts: [...conflicts.values()] };
}

/**
 * Every Particle System's parameters, keyed by System guid, for the game Worker (the `load` and
 * `loadSceneContent` catalogs). Each entry's default is the System's own default, else the
 * first declaring slot's; a System without parameters is left out.
 */
export function buildParticleParameterCatalog(library: ParticleLibrary): Record<string, ParticleParameterCatalogEntry[]> {
  const catalog: Record<string, ParticleParameterCatalogEntry[]> = {};
  for (const guid of library.systems.keys()) {
    const { parameters } = particleSystemParameters(library, guid);
    if (parameters.length) catalog[guid] = parameters.map(({ name, type, defaultValue }) => ({ name, type, defaultValue: [...defaultValue] }));
  }
  return catalog;
}

/**
 * One slot's effective parameter values by name: component values (runtime sets merged over
 * overrides) ?? System default ?? emitter default, resized to the emitter's type. A conflicting
 * slot keeps its own defaults for the conflicting names.
 */
export function particleSlotParameterValues(
  emitter: ParticleLibraryEmitter,
  options: {
    systemDefaults: Readonly<Record<string, readonly number[]>>;
    componentValues: ReadonlyMap<string, readonly number[]>;
    /** Names this slot declares with a type other than the System's. */
    conflicting?: ReadonlySet<string>;
  },
): Map<string, number[]> {
  const values = new Map<string, number[]>();
  for (const parameter of particleEmitterParameters(emitter)) {
    const value = options.conflicting?.has(parameter.name)
      ? parameter.defaultValue
      : options.componentValues.get(parameter.name) ?? options.systemDefaults[parameter.name] ?? parameter.defaultValue;
    values.set(parameter.name, resizeParticleValue(value, parameter.type));
  }
  return values;
}

/** Names that slot `slot` of the System declares with a conflicting type. */
export function particleSlotConflicts(conflicts: readonly ParticleSystemParameterConflict[], slot: number): Set<string> {
  return new Set(conflicts.filter((conflict) => conflict.slots.includes(slot)).map((conflict) => conflict.name));
}

/**
 * A Basic emitter's plan with its bound targets applied (`values` from `particleSlotParameterValues`):
 * scales multiply (bursts round and stay capped at capacity), the tint multiplies every colour
 * key, and Gravity replaces the acceleration while the Gravity module is on. Pure; the base plan
 * is untouched.
 */
export function applyBasicParameters(
  plan: BasicEmitterPlan,
  bindings: readonly ParticleBasicBinding[],
  values: ReadonlyMap<string, readonly number[]>,
  options: { gravityEnabled: boolean },
): BasicEmitterPlan {
  if (!bindings.length) return plan;
  const next: BasicEmitterPlan = structuredClone(plan);
  const value = (binding: ParticleBasicBinding) =>
    resizeParticleValue(values.get(binding.parameterName) ?? binding.defaultValue, PARTICLE_BASIC_BINDING_TARGETS[binding.target].type);
  const scaleRange = (range: { min: number; max: number }, factor: number) => {
    range.min *= factor;
    range.max *= factor;
  };
  for (const binding of bindings) {
    const [x = 0, y = 0, z = 0, w = 1] = value(binding);
    switch (binding.target) {
      case "spawn.rateScale": {
        const factor = Math.max(0, x);
        next.emitRate *= factor;
        next.schedule.rateCurve = next.schedule.rateCurve?.map((key) => ({ ...key, value: key.value * factor })) ?? null;
        break;
      }
      case "spawn.burstScale": {
        const factor = Math.max(0, x);
        next.schedule.bursts = next.schedule.bursts.map((burst) => ({
          ...burst, count: Math.min(plan.capacity, Math.round(burst.count * factor)),
        }));
        break;
      }
      case "init.lifetimeScale": {
        const factor = Math.max(0, x);
        scaleRange(next.lifeTime, factor);
        next.lifetimeBound *= factor;
        next.schedule.lifetimeCurve = next.schedule.lifetimeCurve?.map((key) => ({ ...key, value: key.value * factor })) ?? null;
        break;
      }
      case "init.speedScale":
        scaleRange(next.emitPower, x);
        break;
      case "init.sizeScale":
        scaleRange(next.size, Math.max(0, x));
        next.gradients.size = next.gradients.size?.map((key) => ({ ...key, factor: key.factor * Math.max(0, x) })) ?? null;
        break;
      case "init.colorTint": {
        const tint = [x, y, z, w];
        const multiply = (color: number[]) => color.map((component, index) => component * tint[index]!) as typeof color;
        next.gradients.color = next.gradients.color.map((key) => ({
          ...key,
          color1: multiply([...key.color1]) as typeof key.color1,
          color2: key.color2 ? (multiply([...key.color2]) as typeof key.color2) : null,
        }));
        break;
      }
      case "forces.gravity":
        if (options.gravityEnabled) next.gravity = [x, y, z];
        break;
    }
  }
  return next;
}
