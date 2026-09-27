import { identitySerializedTransform, type SerializedComponent, type SerializedTransform } from "./scene";

export const FOG_VOLUME_CLASS_ID = "FogVolumeComponent";

export type FogVolumeProperties = {
  enabled: boolean;
  shape: "box" | "sphere";
  /** Full local extents; sphere diameters can differ to form an ellipsoid. */
  size: [number, number, number];
  density: number;
  /** Fraction of each half-extent over which density fades to zero at the edge. */
  edgeFalloff: number;
};

export function parseFogVolumeProperties(value: unknown): FogVolumeProperties {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const finite = (entry: unknown, fallback: number): number =>
    typeof entry === "number" && Number.isFinite(entry) ? entry : fallback;
  const size = Array.isArray(source.size) ? source.size : [];
  const dimension = (entry: unknown): number => {
    const value = finite(entry, 10);
    return value > 0 ? value : 10;
  };
  return {
    enabled: source.enabled !== false,
    shape: source.shape === "sphere" ? "sphere" : "box",
    size: [dimension(size[0]), dimension(size[1]), dimension(size[2])],
    density: Math.max(0, finite(source.density, 0.1)),
    edgeFalloff: Math.min(1, Math.max(0, finite(source.edgeFalloff, 0.2))),
  };
}

export type FogVolumeBinding = {
  id: string;
  properties: FogVolumeProperties;
  /** Component-local transforms from volume to actor origin; actor world is separate. */
  transforms: SerializedTransform[];
  error?: string;
};

/** Preserve attachments through non-rendering components without applying actor world twice. */
export function fogVolumeBindings(components: readonly SerializedComponent[]): FogVolumeBinding[] {
  const volumes = components.filter((component) => component.classId === FOG_VOLUME_CLASS_ID);
  if (!volumes.length) return [];
  const byId = new Map(components.map((component) => [component.id, component]));
  return volumes.map((component) => {
    const binding: FogVolumeBinding = {
      id: component.id,
      properties: parseFogVolumeProperties(component.properties),
      transforms: [],
    };
    const visited = new Set<string>();
    let current: SerializedComponent | undefined = component;
    while (current) {
      if (visited.has(current.id)) {
        binding.error = "Fog Volume has a cyclic component attachment.";
        break;
      }
      visited.add(current.id);
      binding.transforms.push(current.transform ?? identitySerializedTransform());
      if (current.parentId && !byId.has(current.parentId)) {
        binding.error = "Fog Volume has a missing component attachment.";
        break;
      }
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return binding;
  });
}
