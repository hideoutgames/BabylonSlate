/** Engine base for authored UserInterface assets. */
export const USER_INTERFACE_ENGINE_CLASS_ID = "UserInterface";

/** Engine base for concrete widget instances. */
export const WIDGET_ENGINE_CLASS_ID = "Widget";

/** Namespaced prefix so asset class ids stay unique across renames. */
export const USER_INTERFACE_CLASS_PREFIX = `${USER_INTERFACE_ENGINE_CLASS_ID}:`;

/**
 * Widget kinds that have a deterministic `*Widget` engine subclass.
 * Keep in lockstep with `@babylonslate/ui-runtime` `WIDGET_KINDS`.
 */
export const ENGINE_WIDGET_KINDS = [
  "Canvas",
  "HorizontalBox",
  "VerticalBox",
  "Grid",
  "ScrollBox",
  "Overlay",
  "SizeBox",
  "Border",
  "Button",
  "Text",
  "TextInput",
  "Slider",
  "CheckBox",
  "Image",
  "Material",
  "ProgressBar",
  "Spacer",
  "TouchJoystick",
  "TouchButton",
  "TouchDPad",
  "UserInterface",
] as const;

export type EngineWidgetKind = (typeof ENGINE_WIDGET_KINDS)[number];

export type UserInterfaceClassMetadata = {
  classId: string;
  parentClassId: typeof USER_INTERFACE_ENGINE_CLASS_ID;
  assetGuid: string;
};

export function userInterfaceClassId(assetGuid: string): string {
  return `${USER_INTERFACE_CLASS_PREFIX}${assetGuid}`;
}

export function isUserInterfaceClassId(classId: string): boolean {
  return classId.startsWith(USER_INTERFACE_CLASS_PREFIX) && classId.length > USER_INTERFACE_CLASS_PREFIX.length;
}

export function userInterfaceAssetGuidFromClassId(classId: string): string | null {
  if (!isUserInterfaceClassId(classId)) return null;
  return classId.slice(USER_INTERFACE_CLASS_PREFIX.length);
}

export function userInterfaceClassMetadata(
  assetGuid: string,
): UserInterfaceClassMetadata {
  return {
    classId: userInterfaceClassId(assetGuid),
    parentClassId: USER_INTERFACE_ENGINE_CLASS_ID,
    assetGuid,
  };
}

export function normalizeUserInterfaceClassRef(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isUserInterfaceClassId(trimmed)) return trimmed;
  return userInterfaceClassId(trimmed);
}

export function widgetClassIdForKind(kind: string): string {
  return `${kind}${WIDGET_ENGINE_CLASS_ID}`;
}

export function isWidgetClassId(classId: string): boolean {
  if (classId === WIDGET_ENGINE_CLASS_ID) return true;
  if (classId === "WidgetComponent") return false;
  if (isUserInterfaceClassId(classId)) return false;
  if (classId === USER_INTERFACE_ENGINE_CLASS_ID) return false;
  return classId.endsWith(WIDGET_ENGINE_CLASS_ID);
}

export function widgetKindFromClassId(classId: string): string | null {
  if (classId === WIDGET_ENGINE_CLASS_ID) return null;
  if (!isWidgetClassId(classId)) return null;
  return classId.slice(0, -WIDGET_ENGINE_CLASS_ID.length);
}
