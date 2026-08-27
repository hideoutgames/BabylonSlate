import {
  identitySerializedTransform,
  type SerializedComponent,
  type SerializedScene,
} from "./scene";

export const DEFAULT_TEXT3D_TEXT = "Text";
export const DEFAULT_TEXT3D_SIZE = 1;
export const DEFAULT_TEXT3D_DEPTH = 0.1;
export const DEFAULT_TEXT3D_COLOR: [number, number, number] = [1, 1, 1];
export const DEFAULT_TEXT3D_ALIGNMENT = "left" as const;

export const TEXT3D_ALIGNMENTS = ["left", "center", "right"] as const;
export type Text3DAlignment = (typeof TEXT3D_ALIGNMENTS)[number];

export const TEXT3D_ALIGNMENT_LABELS: Record<Text3DAlignment, string> = {
  left: "Left",
  center: "Center",
  right: "Right",
};

export type Text3DProperties = {
  text: string;
  size: number;
  depth: number;
  color: [number, number, number];
  fontAssetGuid: string | null;
  alignment: Text3DAlignment;
};

export function parseText3DText(value: unknown): string {
  return typeof value === "string" ? value : DEFAULT_TEXT3D_TEXT;
}

export function parseText3DSize(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_TEXT3D_SIZE;
}

export function parseText3DDepth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_TEXT3D_DEPTH;
}

export function parseText3DColor(value: unknown): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) return [...DEFAULT_TEXT3D_COLOR];
  const r = value[0];
  const g = value[1];
  const b = value[2];
  if (
    typeof r !== "number" ||
    !Number.isFinite(r) ||
    typeof g !== "number" ||
    !Number.isFinite(g) ||
    typeof b !== "number" ||
    !Number.isFinite(b)
  ) {
    return [...DEFAULT_TEXT3D_COLOR];
  }
  return [r, g, b];
}

export function parseText3DFontAssetGuid(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseText3DAlignment(value: unknown): Text3DAlignment {
  return TEXT3D_ALIGNMENTS.includes(value as Text3DAlignment)
    ? (value as Text3DAlignment)
    : DEFAULT_TEXT3D_ALIGNMENT;
}

export function parseText3DProperties(value: unknown): Text3DProperties {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    text: parseText3DText(source.text),
    size: parseText3DSize(source.size),
    depth: parseText3DDepth(source.depth),
    color: parseText3DColor(source.color),
    fontAssetGuid: parseText3DFontAssetGuid(source.fontAssetGuid),
    alignment: parseText3DAlignment(source.alignment),
  };
}

export function createText3DComponent(id: string): SerializedComponent {
  return {
    id,
    classId: "Text3DComponent",
    properties: {
      text: DEFAULT_TEXT3D_TEXT,
      size: DEFAULT_TEXT3D_SIZE,
      depth: DEFAULT_TEXT3D_DEPTH,
      color: [...DEFAULT_TEXT3D_COLOR],
      fontAssetGuid: null,
      alignment: DEFAULT_TEXT3D_ALIGNMENT,
    },
    parentId: null,
    transform: identitySerializedTransform(),
  };
}

export function text3DFontGuidsFromScene(
  scene: SerializedScene | null | undefined,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const actor of scene?.actors ?? []) {
    for (const component of actor.components) {
      if (component.classId !== "Text3DComponent") continue;
      const guid = parseText3DFontAssetGuid(component.properties.fontAssetGuid);
      if (!guid || seen.has(guid)) continue;
      seen.add(guid);
      found.push(guid);
    }
  }
  return found;
}
