export const CABLE_COMPONENT_CLASS_ID = "CableComponent";

export interface CableProperties {
  enabled: boolean;
  materialGuid: string | null;
  /** Rest length in world units; attached endpoints may stretch a shorter cable. */
  cableLength: number;
  numSegments: number;
  /** Tube diameter in world units. */
  cableWidth: number;
  numSides: number;
  tileMaterial: number;
  attachStart: boolean;
  attachEnd: boolean;
  /** End offset in the target component's space, or this component's space. */
  endPosition: [number, number, number];
  targetActorId: string | null;
  targetComponentId: string | null;
  solverIterations: number;
  enableStiffness: boolean;
  gravityScale: number;
  /** Additional world-space acceleration. */
  cableForce: [number, number, number];
  /** Fraction of velocity removed per 1/60 second. */
  damping: number;
  substepTime: number;
  maxSubsteps: number;
  enableCollision: boolean;
  collisionFriction: number;
  /** Maximum particle speed in world units/second before sleep. Zero disables sleep. */
  sleepThreshold: number;
  sleepDelay: number;
}

export const DEFAULT_CABLE_PROPERTIES: Readonly<CableProperties> = {
  enabled: true,
  materialGuid: null,
  cableLength: 4,
  numSegments: 16,
  cableWidth: 0.05,
  numSides: 6,
  tileMaterial: 1,
  attachStart: true,
  attachEnd: true,
  endPosition: [3, 0, 0],
  targetActorId: null,
  targetComponentId: null,
  solverIterations: 6,
  enableStiffness: false,
  gravityScale: 1,
  cableForce: [0, 0, 0],
  damping: 0.03,
  substepTime: 1 / 60,
  maxSubsteps: 4,
  enableCollision: false,
  collisionFriction: 0.2,
  sleepThreshold: 0.01,
  sleepDelay: 0.5,
};

export function cablePropertiesEqual(a: CableProperties, b: CableProperties): boolean {
  return a.enabled === b.enabled &&
    a.materialGuid === b.materialGuid &&
    a.cableLength === b.cableLength &&
    a.numSegments === b.numSegments &&
    a.cableWidth === b.cableWidth &&
    a.numSides === b.numSides &&
    a.tileMaterial === b.tileMaterial &&
    a.attachStart === b.attachStart &&
    a.attachEnd === b.attachEnd &&
    a.endPosition[0] === b.endPosition[0] &&
    a.endPosition[1] === b.endPosition[1] &&
    a.endPosition[2] === b.endPosition[2] &&
    a.targetActorId === b.targetActorId &&
    a.targetComponentId === b.targetComponentId &&
    a.solverIterations === b.solverIterations &&
    a.enableStiffness === b.enableStiffness &&
    a.gravityScale === b.gravityScale &&
    a.cableForce[0] === b.cableForce[0] &&
    a.cableForce[1] === b.cableForce[1] &&
    a.cableForce[2] === b.cableForce[2] &&
    a.damping === b.damping &&
    a.substepTime === b.substepTime &&
    a.maxSubsteps === b.maxSubsteps &&
    a.enableCollision === b.enableCollision &&
    a.collisionFriction === b.collisionFriction &&
    a.sleepThreshold === b.sleepThreshold &&
    a.sleepDelay === b.sleepDelay;
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function vector(value: unknown, fallback: readonly number[]): [number, number, number] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const coordinates = value as Record<string, unknown>;
    value = [coordinates.x, coordinates.y, coordinates.z];
  }
  if (!Array.isArray(value) || value.length !== 3 ||
    !value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))) {
    return [fallback[0], fallback[1], fallback[2]];
  }
  // Keep authored coordinates/accelerations within a useful float-buffer range.
  return value.map((coordinate: number) => Math.min(1e6, Math.max(-1e6, coordinate))) as [number, number, number];
}

function reference(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Sanitize serialized/editor values before allocating simulation or mesh buffers. */
export function parseCableProperties(value: unknown): CableProperties {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const defaults = DEFAULT_CABLE_PROPERTIES;
  return {
    enabled: source.enabled !== false,
    materialGuid: reference(source.materialGuid),
    cableLength: finiteNumber(source.cableLength, defaults.cableLength, 0.01, 10000),
    numSegments: Math.round(finiteNumber(source.numSegments, defaults.numSegments, 1, 64)),
    cableWidth: finiteNumber(source.cableWidth, defaults.cableWidth, 0.001, 10),
    numSides: Math.round(finiteNumber(source.numSides, defaults.numSides, 3, 12)),
    tileMaterial: finiteNumber(source.tileMaterial, defaults.tileMaterial, 0.01, 1000),
    attachStart: source.attachStart !== false,
    attachEnd: source.attachEnd !== false,
    endPosition: vector(source.endPosition, defaults.endPosition),
    targetActorId: reference(source.targetActorId),
    targetComponentId: reference(source.targetComponentId),
    solverIterations: Math.round(finiteNumber(source.solverIterations, defaults.solverIterations, 1, 16)),
    enableStiffness: source.enableStiffness === true,
    gravityScale: finiteNumber(source.gravityScale, defaults.gravityScale, -100, 100),
    cableForce: vector(source.cableForce, defaults.cableForce),
    damping: finiteNumber(source.damping, defaults.damping, 0, 1),
    substepTime: finiteNumber(source.substepTime, defaults.substepTime, 1 / 120, 1 / 15),
    maxSubsteps: Math.round(finiteNumber(source.maxSubsteps, defaults.maxSubsteps, 1, 8)),
    enableCollision: source.enableCollision === true,
    collisionFriction: finiteNumber(source.collisionFriction, defaults.collisionFriction, 0, 1),
    sleepThreshold: finiteNumber(source.sleepThreshold, defaults.sleepThreshold, 0, 1),
    sleepDelay: finiteNumber(source.sleepDelay, defaults.sleepDelay, 0, 10),
  };
}
