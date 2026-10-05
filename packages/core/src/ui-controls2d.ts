import { parseOverlayVisualStyle, type OverlayVisualStyle } from "./overlay-visual-style";

export { UI_CONTROL_2D_CLASS_IDS, isUIControl2DClass, isInteractiveUIControl2DClass, type UIControl2DClassId } from "./ui-controls2d-classes";

export const UI_CONTROL_2D_VISUAL_PARTS = ["background", "track", "fill", "thumb", "indicator"] as const;
export type UIControl2DVisualPart = (typeof UI_CONTROL_2D_VISUAL_PARTS)[number];
type VisualAssets = Record<`${UIControl2DVisualPart}${"Material" | "Texture"}Guid`, string | null>;

/** Shared serialized control state. Dimensions and font size use SceneLayer units. */
export interface UIControl2DProperties extends OverlayVisualStyle, VisualAssets {
  enabled: boolean;
  width: number;
  height: number;
  min: number;
  max: number;
  step: number;
  value: number;
  lowerValue: number;
  upperValue: number;
  orientation: "horizontal" | "vertical";
  checked: boolean;
  group: string;
  text: string;
  placeholder: string;
  /** Zero leaves text length unrestricted; counts Unicode code points. */
  maxLength: number;
  readOnly: boolean;
  options: string[];
  selectedIndex: number;
  fontSize: number;
  textColor: string;
}

const finite = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const positive = (value: unknown, fallback: number): number => {
  const number = finite(value, fallback);
  return number > 0 ? number : fallback;
};

/** Clamp before and after snapping so a partial last step still reaches the endpoint. */
export function clampUIControl2DValue(value: number, properties: Pick<UIControl2DProperties, "min" | "max" | "step">): number {
  const { min, max, step } = properties;
  const clamped = Math.max(min, Math.min(max, finite(value, min)));
  if (clamped === min || clamped === max || step <= 0) return clamped;
  const count = (clamped - min) / step;
  // Extreme finite inputs may overflow the ratio. The bounded input is still valid.
  if (!Number.isFinite(count)) return clamped;
  const snapped = Number((min + Math.round(count) * step).toPrecision(15));
  return Math.max(min, Math.min(max, snapped));
}

export function uiControl2DFraction(value: number, properties: Pick<UIControl2DProperties, "min" | "max">): number {
  if (properties.max <= properties.min) return 0;
  // Scaling the range first avoids overflow when min and max have opposite signs.
  const scale = Math.max(1, Math.abs(properties.min), Math.abs(properties.max));
  return Math.max(0, Math.min(1, (finite(value, properties.min) / scale - properties.min / scale)
    / (properties.max / scale - properties.min / scale)));
}

/** Pointer coordinates are centered on the control, with positive Y pointing up. */
export function uiControl2DValueAt(x: number, y: number, properties: UIControl2DProperties): number {
  const fraction = Math.max(0, Math.min(1, properties.orientation === "vertical"
    ? finite(y, 0) / properties.height + 0.5 : finite(x, 0) / properties.width + 0.5));
  return clampUIControl2DValue(properties.min * (1 - fraction) + properties.max * fraction, properties);
}

export function normalizeUIControl2DText(text: string, properties: Pick<UIControl2DProperties, "maxLength">): string {
  const singleLine = text.replace(/[\r\n]+/g, " ");
  return properties.maxLength > 0 ? Array.from(singleLine).slice(0, properties.maxLength).join("") : singleLine;
}

export function parseUIControl2DProperties(classId: string, source: Partial<UIControl2DProperties> | Record<string, unknown> = {}): UIControl2DProperties {
  const authoredMin = finite(source.min, 0);
  const authoredMax = finite(source.max, classId === "2DNumericInputComponent" ? 100 : 1);
  const min = Math.min(authoredMin, authoredMax);
  const max = Math.max(authoredMin, authoredMax);
  const step = Math.max(0, finite(source.step, classId === "2DNumericInputComponent" ? 1 : classId === "2DProgressBarComponent" ? 0 : 0.01));
  const range = { min, max, step };
  const lower = clampUIControl2DValue(finite(source.lowerValue, min), range);
  const upper = clampUIControl2DValue(finite(source.upperValue, max), range);
  const options = Array.isArray(source.options) ? source.options.filter((option): option is string => typeof option === "string") : [];
  const maxLength = Math.max(0, Math.floor(finite(source.maxLength, 0)));
  const compact = classId === "2DCheckboxComponent" || classId === "2DRadioButtonComponent";
  const assets = Object.fromEntries(UI_CONTROL_2D_VISUAL_PARTS.flatMap((part) => ["Material", "Texture"].map((kind) => {
    const key = `${part}${kind}Guid` as keyof VisualAssets;
    const value = source[key];
    return [key, typeof value === "string" && value.trim() ? value.trim() : null];
  }))) as VisualAssets;
  return {
    ...parseOverlayVisualStyle(source), ...assets,
    enabled: source.enabled !== false,
    width: positive(source.width, compact ? 0.6 : classId === "2DToggleComponent" ? 1.2 : 4),
    height: positive(source.height, 0.6),
    ...range,
    value: clampUIControl2DValue(finite(source.value, min), range),
    lowerValue: Math.min(lower, upper), upperValue: Math.max(lower, upper),
    orientation: source.orientation === "vertical" ? "vertical" : "horizontal",
    checked: source.checked === true,
    group: typeof source.group === "string" ? source.group : "",
    text: normalizeUIControl2DText(typeof source.text === "string" ? source.text : "", { maxLength }),
    placeholder: typeof source.placeholder === "string" ? source.placeholder : "",
    maxLength,
    readOnly: source.readOnly === true,
    options,
    selectedIndex: Math.max(-1, Math.min(options.length - 1, Math.floor(finite(source.selectedIndex, options.length ? 0 : -1)))),
    fontSize: positive(source.fontSize, 0.32),
    textColor: typeof source.textColor === "string" && /^#[\da-f]{6}$/i.test(source.textColor) ? source.textColor : "#ffffff",
  };
}

/** A material owns the part's appearance when both kinds of asset are assigned. */
export function uiControl2DVisualAsset(properties: UIControl2DProperties, part: UIControl2DVisualPart): { kind: "material" | "texture"; guid: string } | null {
  const material = properties[`${part}MaterialGuid`];
  if (material) return { kind: "material", guid: material };
  const texture = properties[`${part}TextureGuid`];
  return texture ? { kind: "texture", guid: texture } : null;
}
