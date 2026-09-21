import { identitySerializedTransform, type SerializedComponent, type SerializedTransform } from "./scene";

export const AREA_RECT_LIGHT_CLASS_ID = "AreaRectLightComponent";

/** Typed emission references in scenes, component templates and native variable pins. */
export function areaEmissionTextureGuids(value: unknown): string[] {
  const result = new Set<string>();
  const add = (entry: unknown) => { if (typeof entry === "string" && entry.trim()) result.add(entry.trim()); };
  const walk = (entry: unknown): void => {
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) { entry.forEach(walk); return; }
    const record = entry as Record<string, unknown>;
    if (record.classId === AREA_RECT_LIGHT_CLASS_ID) {
      const properties = record.properties as Record<string, unknown> | undefined;
      add(properties?.textureGuid);
      if (record.propertyKey === "textureGuid" || record.variableName === "EmissionTexture") {
        add(["default:EmissionTexture", "default:emissionTexture", "default:value", "value"].map((key) => record[key]).find((item) => item !== undefined));
      }
    }
    Object.values(record).forEach(walk);
  };
  walk(value);
  return [...result];
}

/** Authored data only. Native textures, materials and transforms belong to the view. */
export type AreaRectLightProperties = {
  enabled: boolean;
  width: number;
  height: number;
  color: [number, number, number];
  intensity: number;
  textureGuid: string | null;
};

export function parseAreaRectLightProperties(value: unknown): AreaRectLightProperties {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const positive = (entry: unknown, fallback: number) => typeof entry === "number" && Number.isFinite(entry) && entry > 0 ? entry : fallback;
  const color = Array.isArray(source.color) && source.color.length === 3 && source.color.every((v) => typeof v === "number" && Number.isFinite(v))
    ? source.color.map((v: number) => Math.min(1, Math.max(0, v))) as [number, number, number] : [1, 1, 1] as [number, number, number];
  return {
    enabled: source.enabled !== false,
    width: positive(source.width, 1),
    height: positive(source.height, 1),
    color,
    intensity: source.intensity === 0 ? 0 : positive(source.intensity, 1),
    textureGuid: typeof source.textureGuid === "string" && source.textureGuid.trim() ? source.textureGuid.trim() : null,
  };
}

export type AreaRectLightBinding = {
  id: string;
  properties: AreaRectLightProperties;
  /** Component local transforms, from emitter to actor origin; never actor world twice. */
  transforms: SerializedTransform[];
  error?: string;
};

/** Preserve component attachments, including non-rendering parents. */
export function areaRectLightBindings(components: readonly SerializedComponent[]): AreaRectLightBinding[] {
  const byId = new Map(components.map((component) => [component.id, component]));
  return components.filter((component) => component.classId === AREA_RECT_LIGHT_CLASS_ID).map((component) => {
    const binding: AreaRectLightBinding = { id: component.id, properties: parseAreaRectLightProperties(component.properties), transforms: [] };
    const visited = new Set<string>();
    let current: SerializedComponent | undefined = component;
    while (current) {
      if (visited.has(current.id)) { binding.error = "Rectangular Area Light has a cyclic component attachment."; break; }
      visited.add(current.id);
      binding.transforms.push(current.transform ?? identitySerializedTransform());
      if (current.parentId && !byId.has(current.parentId)) { binding.error = "Rectangular Area Light has a missing component attachment."; break; }
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return binding;
  });
}
