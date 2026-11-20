import { identitySerializedTransform, type SerializedComponent, type SerializedTransform } from "./scene";

export const DECAL_CLASS_ID = "DecalComponent";

export const DECAL_BLEND_MODES = ["alpha", "multiply", "additive"] as const;
export type DecalBlendMode = (typeof DECAL_BLEND_MODES)[number];

export interface DecalProperties {
  enabled: boolean;
  textureGuid: string | null;
  normalTextureGuid: string | null;
  tint: [number, number, number];
  opacity: number;
  roughness: number;
  blendMode: DecalBlendMode;
  receiveLighting: boolean;
  /** Local OBB projection extents (X width, Y projection depth, Z height). */
  size: [number, number, number];
  /** Surface normal divergence angle from local +Y beyond which projection fades out (degrees). */
  fadeAngle: number;
  sortOrder: number;
  /** Hard distance cull in meters (0 = unlimited). */
  cullDistance: number;
}

export const DEFAULT_DECAL_PROPERTIES: DecalProperties = {
  enabled: true,
  textureGuid: null,
  normalTextureGuid: null,
  tint: [1, 1, 1],
  opacity: 1,
  roughness: 0.7,
  blendMode: "alpha",
  receiveLighting: true,
  size: [2, 1, 2],
  fadeAngle: 75,
  sortOrder: 0,
  cullDistance: 0,
};

function finite(entry: unknown, fallback: number): number {
  return typeof entry === "number" && Number.isFinite(entry) ? entry : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeGuid(entry: unknown): string | null {
  if (typeof entry !== "string") return null;
  const trimmed = entry.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTint(entry: unknown): [number, number, number] {
  if (Array.isArray(entry)) {
    return [
      clamp(finite(entry[0], 1), 0, 1),
      clamp(finite(entry[1], 1), 0, 1),
      clamp(finite(entry[2], 1), 0, 1),
    ];
  }
  if (entry && typeof entry === "object") {
    const color = entry as { r?: unknown; g?: unknown; b?: unknown };
    return [
      clamp(finite(color.r, 1), 0, 1),
      clamp(finite(color.g, 1), 0, 1),
      clamp(finite(color.b, 1), 0, 1),
    ];
  }
  return [1, 1, 1];
}

function normalizeSize(entry: unknown): [number, number, number] {
  const source = Array.isArray(entry) ? entry : [];
  const dim = (value: unknown, fallback: number): number => {
    const parsed = finite(value, fallback);
    return parsed > 0 ? parsed : fallback;
  };
  return [
    dim(source[0], DEFAULT_DECAL_PROPERTIES.size[0]),
    dim(source[1], DEFAULT_DECAL_PROPERTIES.size[1]),
    dim(source[2], DEFAULT_DECAL_PROPERTIES.size[2]),
  ];
}

export function normalizeDecalBlendMode(entry: unknown): DecalBlendMode {
  return entry === "multiply" || entry === "additive" ? entry : "alpha";
}

export function parseDecalProperties(value: unknown): DecalProperties {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    enabled: source.enabled !== false,
    textureGuid: normalizeGuid(source.textureGuid),
    normalTextureGuid: normalizeGuid(source.normalTextureGuid),
    tint: normalizeTint(source.tint),
    opacity: clamp(finite(source.opacity, DEFAULT_DECAL_PROPERTIES.opacity), 0, 1),
    roughness: clamp(finite(source.roughness, DEFAULT_DECAL_PROPERTIES.roughness), 0, 1),
    blendMode: normalizeDecalBlendMode(source.blendMode),
    receiveLighting: source.receiveLighting !== false,
    size: normalizeSize(source.size),
    fadeAngle: clamp(finite(source.fadeAngle, DEFAULT_DECAL_PROPERTIES.fadeAngle), 1, 180),
    sortOrder: Math.round(finite(source.sortOrder, DEFAULT_DECAL_PROPERTIES.sortOrder)),
    cullDistance: Math.max(0, finite(source.cullDistance, DEFAULT_DECAL_PROPERTIES.cullDistance)),
  };
}

export interface DecalBinding {
  id: string;
  properties: DecalProperties;
  /** Component-local transforms from decal to actor origin; actor world is separate. */
  transforms: SerializedTransform[];
  error?: string;
}

/** Preserve attachments through non-rendering components without applying actor world twice. */
export function decalBindings(components: readonly SerializedComponent[]): DecalBinding[] {
  const decals = components.filter((component) => component.classId === DECAL_CLASS_ID);
  if (!decals.length) return [];
  const byId = new Map(components.map((component) => [component.id, component]));
  return decals.map((component) => {
    const binding: DecalBinding = {
      id: component.id,
      properties: parseDecalProperties(component.properties),
      transforms: [],
    };
    const visited = new Set<string>();
    let current: SerializedComponent | undefined = component;
    while (current) {
      if (visited.has(current.id)) {
        binding.error = "Decal has a cyclic component attachment.";
        break;
      }
      visited.add(current.id);
      binding.transforms.push(current.transform ?? identitySerializedTransform());
      if (current.parentId && !byId.has(current.parentId)) {
        binding.error = "Decal has a missing component attachment.";
        break;
      }
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return binding;
  });
}

export interface DynamicDecalSpawnRequest {
  textureGuid: string;
  normalTextureGuid?: string | null;
  position: [number, number, number];
  rotation: [number, number, number, number];
  size: [number, number, number];
  tint?: [number, number, number];
  opacity?: number;
  roughness?: number;
  blendMode?: DecalBlendMode;
  receiveLighting?: boolean;
  fadeAngle?: number;
  sortOrder?: number;
  cullDistance?: number;
  /** Seconds before expiring; 0 keeps the decal until recycled by the ring buffer. */
  lifetime?: number;
  /** Seconds at the end of `lifetime` over which opacity fades linearly to 0. */
  fadeOutDuration?: number;
}
