import type { SerializedComponent } from "./scene";

export const OUTLINE_COMPONENT_CLASS_ID = "OutlineComponent";
export const OUTLINE_WIDTH_LIMITS = [0.25, 8] as const;

export interface OutlineProperties {
  enabled: boolean;
  color: [number, number, number];
  /** Width in output pixels, independent of world scale. */
  width: number;
  throughMeshes: boolean;
}

export const DEFAULT_OUTLINE_PROPERTIES: Readonly<OutlineProperties> = {
  enabled: true,
  color: [0.03, 0.03, 0.03],
  width: 1,
  throughMeshes: false,
};

/** Invalid colors inherit; finite channels are clamped without quantization. */
export function normalizeOutlineColor(value: unknown): OutlineProperties["color"] | undefined {
  if (!Array.isArray(value) || value.length !== 3 ||
    ![0, 1, 2].every((index) => typeof value[index] === "number" && Number.isFinite(value[index]))) return undefined;
  return value.map((channel: number) => Math.min(1, Math.max(0, channel))) as OutlineProperties["color"];
}

export function parseOutlineProperties(value: unknown): OutlineProperties {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    enabled: source.enabled !== false,
    color: normalizeOutlineColor(source.color) ?? [...DEFAULT_OUTLINE_PROPERTIES.color],
    width: typeof source.width === "number" && Number.isFinite(source.width)
      ? Math.min(OUTLINE_WIDTH_LIMITS[1], Math.max(OUTLINE_WIDTH_LIMITS[0], source.width))
      : DEFAULT_OUTLINE_PROPERTIES.width,
    throughMeshes: source.throughMeshes === true,
  };
}

/** Each authored component keeps its own lifetime even on a shared mesh asset. */
export interface OutlineBinding extends OutlineProperties {
  id: string;
  actorId: string;
}

export function outlineBindings(actorId: string, components: readonly SerializedComponent[]): OutlineBinding[] {
  return components
    .filter((component) => component.classId === OUTLINE_COMPONENT_CLASS_ID)
    .map((component) => ({ id: component.id, actorId, ...parseOutlineProperties(component.properties) }));
}
