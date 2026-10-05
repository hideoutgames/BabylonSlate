import type { SerializedComponent } from "./scene";

export const DEFORMER_COMPONENT_CLASS_ID = "DeformerComponent";
export const DEFORMER_MAX_CONTROLS = 64;
/** Match dynamic geometry's finite world-coordinate envelope before Float32 upload. */
export const DEFORMER_MAX_COORDINATE = 1e10;
export const DEFORMER_PROPERTY_KEYS = ["targetMeshComponentId", "enabled", "strength", "resolution", "offsets", "fitToMesh", "boundsMin", "boundsMax"] as const;

export interface DeformerProperties {
  targetMeshComponentId: string;
  enabled: boolean;
  strength: number;
  resolution: [number, number, number];
  /** XYZ offsets in target-local units; index = x + resolutionX * (y + resolutionY * z). */
  offsets: number[];
  fitToMesh: boolean;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
}

/** A bounded control snapshot; never contains mesh vertices. */
export interface DeformerBinding extends DeformerProperties { id: string }

function tuple(value: unknown, fallback: [number, number, number]): [number, number, number] {
  const source = Array.isArray(value) ? value : value && typeof value === "object"
    ? [(value as Record<string, unknown>).x, (value as Record<string, unknown>).y, (value as Record<string, unknown>).z] : [];
  return [0, 1, 2].map((i) => typeof source[i] === "number" && Number.isFinite(source[i]) ? coordinate(source[i]) : fallback[i]) as [number, number, number];
}

function coordinate(value: number): number { return Math.max(-DEFORMER_MAX_COORDINATE, Math.min(DEFORMER_MAX_COORDINATE, value)); }

export function parseDeformerProperties(value: unknown): DeformerProperties {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const resolution = tuple(source.resolution, [2, 2, 2]).map((axis) => Math.max(2, Math.min(4, Math.round(axis)))) as [number, number, number];
  const offsets = Array.isArray(source.offsets) ? source.offsets : [];
  const boundsMin = tuple(source.boundsMin, [-0.5, -0.5, -0.5]);
  const boundsMax = tuple(source.boundsMax, [0.5, 0.5, 0.5]);
  for (const axis of [0, 1, 2] as const) {
    if (boundsMax[axis] - boundsMin[axis] < 0.0001) {
      boundsMin[axis] = -0.5;
      boundsMax[axis] = 0.5;
    }
  }
  return {
    targetMeshComponentId: typeof source.targetMeshComponentId === "string" ? source.targetMeshComponentId.trim() : "",
    enabled: source.enabled === true,
    strength: typeof source.strength === "number" && Number.isFinite(source.strength) ? Math.max(0, Math.min(1, source.strength)) : 1,
    resolution,
    offsets: Array.from({ length: resolution[0] * resolution[1] * resolution[2] * 3 }, (_, i) =>
      typeof offsets[i] === "number" && Number.isFinite(offsets[i]) ? coordinate(offsets[i]) : 0),
    fitToMesh: source.fitToMesh !== false,
    boundsMin,
    boundsMax,
  };
}

/** Changing cage topology resets offsets rather than reinterpreting old point indices. */
export function updateDeformerProperties(properties: unknown, key: string, value: unknown): DeformerProperties {
  const current = parseDeformerProperties(properties);
  const next = parseDeformerProperties({ ...current, [key]: value });
  if (key === "resolution" && next.resolution.some((axis, i) => axis !== current.resolution[i])) next.offsets.fill(0);
  return next;
}

/** Same-owner references only. Exact IDs win over inherited source IDs. One enabled cage per mesh. */
export function deformerBindings(_actorId: string, components: readonly SerializedComponent[]): DeformerBinding[] {
  const meshes = components.filter((component) => component.classId === "MeshComponent");
  const claimed = new Set<string>();
  const bindings: DeformerBinding[] = [];
  for (const component of components) {
    if (component.classId !== DEFORMER_COMPONENT_CLASS_ID) continue;
    const properties = parseDeformerProperties(component.properties);
    if (!properties.enabled) continue;
    const target = meshes.find((mesh) => mesh.id === properties.targetMeshComponentId)
      ?? meshes.find((mesh) => mesh.sourceId === properties.targetMeshComponentId);
    if (!target || claimed.has(target.id)) continue;
    claimed.add(target.id);
    bindings.push({ id: component.id, ...properties, targetMeshComponentId: target.id });
  }
  return bindings;
}
