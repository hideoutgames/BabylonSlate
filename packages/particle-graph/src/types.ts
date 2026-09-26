/**
 * Particle Graph value types (docs/design/particle-emitters.md, "Particle Graph").
 *
 * `color` is RGBA (Babylon `Color4`); `particle` is the spine that carries the
 * system from Create Particle to Emitter Output. There is no `int`: Babylon Int
 * ports are typed Float here. The only implicit conversion is a Float splat into
 * a vector or color, which is Babylon's own `adapt` rule.
 */
export type ParticleValueType = "float" | "vec2" | "vec3" | "color" | "particle";

export type ParticleNumericType = Exclude<ParticleValueType, "particle">;

export const PARTICLE_NUMERIC_TYPES: readonly ParticleNumericType[] = [
  "float",
  "vec2",
  "vec3",
  "color",
];

const COMPONENTS: Record<ParticleValueType, number> = {
  float: 1,
  vec2: 2,
  vec3: 3,
  color: 4,
  particle: 0,
};

const LABELS: Record<ParticleValueType, string> = {
  float: "Float",
  vec2: "Vector 2",
  vec3: "Vector 3",
  color: "Color",
  particle: "Particle",
};

export function isParticleNumericType(type: string): type is ParticleNumericType {
  return type === "float" || type === "vec2" || type === "vec3" || type === "color";
}

export function isParticleValueType(type: string): type is ParticleValueType {
  return type === "particle" || isParticleNumericType(type);
}

export function particleComponentCount(type: ParticleValueType): number {
  return COMPONENTS[type];
}

export function particleTypeLabel(type: ParticleValueType): string {
  return LABELS[type];
}

/** Exact types, or a Float splatted into a vector or color. Particle meets only Particle. */
export function particleTypesAreAssignable(
  from: ParticleValueType,
  to: ParticleValueType,
): boolean {
  if (from === to) return true;
  return from === "float" && (to === "vec2" || to === "vec3" || to === "color");
}

export type ParticleConversion = {
  kind: "splat";
  from: "float";
  to: "vec2" | "vec3" | "color";
};

export function particleConversionFor(
  from: ParticleValueType,
  to: ParticleValueType,
): ParticleConversion | null {
  if (from !== "float") return null;
  if (to !== "vec2" && to !== "vec3" && to !== "color") return null;
  return { kind: "splat", from, to };
}

/**
 * Fit a literal to `type`: one component splats to every component (alpha
 * included), longer values keep their leading components, missing components
 * are 0 except color alpha (1), and non-finite components become 0.
 */
export function resizeParticleValue(
  value: readonly unknown[] | undefined,
  type: ParticleNumericType,
): number[] {
  const width = COMPONENTS[type];
  const source = (value ?? []).map((component) =>
    typeof component === "number" && Number.isFinite(component) ? component : 0,
  );
  if (source.length === 1) return Array.from({ length: width }, () => source[0]!);
  return Array.from({ length: width }, (_, index) =>
    index < source.length ? source[index]! : type === "color" && index === 3 ? 1 : 0,
  );
}

export type ParticleGenericResolution =
  | { ok: true; type: ParticleNumericType }
  | { ok: false; conflict: [ParticleValueType, ParticleValueType] };

/**
 * Resolve one generic pin group from the types wired into its inputs. Float
 * adapts to the other side; two different non-Float types conflict; with no
 * non-Float input the group resolves to `fallback` (Float unless the node says).
 */
export function resolveParticleGenericType(
  connected: readonly ParticleValueType[],
  fallback: ParticleNumericType = "float",
): ParticleGenericResolution {
  let resolved: ParticleNumericType | null = null;
  for (const type of connected) {
    if (type === "particle") return { ok: false, conflict: [resolved ?? fallback, type] };
    if (type === "float") continue;
    if (resolved && resolved !== type) return { ok: false, conflict: [resolved, type] };
    resolved = type;
  }
  return { ok: true, type: resolved ?? fallback };
}
