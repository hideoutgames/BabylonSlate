import {
  identitySerializedTransform,
  type SerializedComponent,
  type SerializedScene,
} from "./scene";

export const DEFAULT_WIDGET_WIDTH = 1;
export const DEFAULT_WIDGET_HEIGHT = 1;

export type WidgetComponentProperties = {
  uiAssetGuid: string | null;
  twoSided: boolean;
  width: number;
  height: number;
};

export function parseWidgetUiAssetGuid(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseWidgetTwoSided(value: unknown): boolean {
  return value === true;
}

export function parseWidgetWidth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_WIDGET_WIDTH;
}

export function parseWidgetHeight(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_WIDGET_HEIGHT;
}

export function parseWidgetComponentProperties(
  value: unknown,
): WidgetComponentProperties {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    uiAssetGuid: parseWidgetUiAssetGuid(source.uiAssetGuid),
    twoSided: parseWidgetTwoSided(source.twoSided),
    width: parseWidgetWidth(source.width),
    height: parseWidgetHeight(source.height),
  };
}

export function createWidgetComponent(id: string): SerializedComponent {
  return {
    id,
    classId: "WidgetComponent",
    properties: {
      uiAssetGuid: null,
      twoSided: false,
      width: DEFAULT_WIDGET_WIDTH,
      height: DEFAULT_WIDGET_HEIGHT,
    },
    parentId: null,
    transform: identitySerializedTransform(),
  };
}

export function widgetUiGuidsFromScene(
  scene: SerializedScene | null | undefined,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const actor of scene?.actors ?? []) {
    for (const component of actor.components) {
      if (component.classId !== "WidgetComponent") continue;
      const guid = parseWidgetUiAssetGuid(component.properties.uiAssetGuid);
      if (!guid || seen.has(guid)) continue;
      seen.add(guid);
      found.push(guid);
    }
  }
  return found;
}
