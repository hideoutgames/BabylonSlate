/** Serializable skeletal pose shared by the render host and worker physics. */
export interface RagdollBonePose {
  name: string;
  parentName: string | null;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
}

export interface RagdollProperties {
  enabled: boolean;
  /** Empty selects the complete skeleton; names otherwise select a connected subset. */
  boneNames: string[];
  totalMass: number;
  radius: number;
  angularLimit: number;
  linearDamping: number;
  angularDamping: number;
  friction: number;
  restitution: number;
  layer: number;
  mask: number;
}

export function parseRagdollProperties(properties: Record<string, unknown>): RagdollProperties {
  const number = (key: string, fallback: number, min: number, max = Number.MAX_VALUE) => {
    const value = properties[key] ?? fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Ragdoll ${key} must be between ${min} and ${max}.`);
    }
    return value;
  };
  const names = properties.boneNames ?? [];
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || !name.trim())) {
    throw new Error("Ragdoll Bone Names must contain nonempty bone names.");
  }
  if (new Set(names).size !== names.length || names.length > 128) {
    throw new Error("Ragdoll Bone Names must be unique and contain at most 128 bones.");
  }
  const mask = (key: string, fallback: number) => {
    const value = number(key, fallback, 0, 0xffffffff);
    if (!Number.isInteger(value)) throw new Error(`Ragdoll ${key} must be an integer bit mask.`);
    return value >>> 0;
  };
  return {
    enabled: properties.enabled === true,
    boneNames: [...names] as string[],
    totalMass: number("totalMass", 60, 0.001),
    radius: number("radius", 0.08, 0.001),
    angularLimit: number("angularLimit", 45, 0, 180),
    linearDamping: number("linearDamping", 0.05, 0),
    angularDamping: number("angularDamping", 0.3, 0),
    friction: number("friction", 0.5, 0),
    restitution: number("restitution", 0, 0, 1),
    layer: mask("layer", 1),
    mask: mask("mask", 0xffffffff),
  };
}
