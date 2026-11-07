import { colorToHex, type ColorValue } from "./color-field";
import type { Color4Value, PropertyRow, Vector3Value } from "./property-grid";

/**
 * One copied Inspector value: the kind of row it came from, the value, and for
 * an asset its type, so Paste can tell whether another row takes it.
 */
export interface PropertyClipboardEntry {
  kind: PropertyRow["kind"];
  value: unknown;
  /** Asset rows: the copied asset's type (`Texture`, `Material`, …). */
  assetType?: string;
  /** Built-in range and curve Structures: their kind, which must match to paste. */
  variant?: string;
}

/** The editor-wide copied property, shared by every PropertyGrid for the session. */
let copied: PropertyClipboardEntry | null = null;

/** A row's value cannot be copied when it shows several values (a mixed selection). */
export function canCopyPropertyRow(row: PropertyRow): boolean {
  if (row.mixed) return false;
  if (row.kind === "vector3" && row.mixedAxes?.some(Boolean)) return false;
  return true;
}

function assetTypeOf(row: Extract<PropertyRow, { kind: "asset" }>): string | undefined {
  return row.visual?.assetType ?? row.displayType;
}

/** The value as plain text for the system clipboard, so it can also go outside the editor. */
export function propertyRowText(row: PropertyRow): string {
  switch (row.kind) {
    case "number":
    case "slider":
    case "flags":
      return String(row.value);
    case "vector3":
    case "range":
      return row.value.join(", ");
    case "boolean":
      return row.value ? "true" : "false";
    case "text":
    case "info":
      return row.value;
    case "enum":
      return row.options.find((option) => option.value === row.value)?.label ?? row.value;
    case "color":
      return row.value ? colorToHex(row.value) : "";
    case "asset":
      return row.displayLabel ?? row.value ?? "";
    default:
      return JSON.stringify(row.value);
  }
}

/** Copies the row's value for Paste, and its text to the system clipboard when the browser allows. */
export function copyPropertyRow(row: PropertyRow): boolean {
  if (!canCopyPropertyRow(row)) return false;
  copied = {
    kind: row.kind,
    value: structuredClone(row.value),
    ...(row.kind === "asset" && row.value ? { assetType: assetTypeOf(row) } : {}),
    ...(row.kind === "value-range" ? { variant: row.rangeKind } : {}),
    ...(row.kind === "value-curve" ? { variant: row.curveKind } : {}),
  };
  void globalThis.navigator?.clipboard?.writeText?.(propertyRowText(row)).catch(() => {});
  return true;
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isNumberArray = (value: unknown, length?: number): value is number[] =>
  Array.isArray(value) && value.every(isNumber) && (length === undefined || value.length === length);

function clamp(value: number, min?: number, max?: number): number {
  return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, value));
}

function withinCount(count: number, min?: number, max?: number): boolean {
  return count >= (min ?? 0) && count <= (max ?? Infinity);
}

/**
 * The value `entry` gives `row`, or `undefined` when the row does not take it.
 * Kinds match exactly, with these conversions: a number and a slider take each
 * other's value (clamped to the row's range), a color and an RGBA color take
 * each other's (the RGBA keeps its alpha), and a text row takes a read-only
 * fact's text.
 */
export function pastedPropertyValue(row: PropertyRow, entry: PropertyClipboardEntry | null): unknown {
  if (!entry || row.disabled || (row.kind === "text" && row.readOnly)) return undefined;
  const { kind, value } = entry;
  switch (row.kind) {
    case "number":
    case "slider":
      return (kind === "number" || kind === "slider") && isNumber(value) ? clamp(value, row.min, row.max) : undefined;
    case "vector3":
      return kind === "vector3" && isNumberArray(value, row.value.length) ? (value as Vector3Value) : undefined;
    case "boolean":
      return kind === "boolean" && typeof value === "boolean" ? value : undefined;
    case "text":
      return (kind === "text" || kind === "info") && typeof value === "string" ? value : undefined;
    case "enum":
      return kind === "enum" && row.options.some((option) => option.value === value && !option.disabled) ? value : undefined;
    case "color":
      if (kind === "color" && isNumberArray(value, 3)) return value as ColorValue;
      if (kind === "color4" && isNumberArray(value, 4)) return value.slice(0, 3) as ColorValue;
      return undefined;
    case "color4":
      if (kind === "color4" && isNumberArray(value, 4)) return value as Color4Value;
      if (kind === "color" && isNumberArray(value, 3)) return [...value, row.value[3]] as Color4Value;
      return undefined;
    case "flags": {
      const bits = row.bitCount ?? 32;
      return kind === "flags" && isNumber(value) && value >= 0 && (bits >= 32 || value < 2 ** bits) ? value : undefined;
    }
    case "collision-responses": {
      if (kind !== "collision-responses" || !value || typeof value !== "object") return undefined;
      const { mask, overlapMask } = value as { mask?: unknown; overlapMask?: unknown };
      const limit = 2 ** row.labels.length;
      return isNumber(mask) && isNumber(overlapMask) && mask < limit && overlapMask < limit ? value : undefined;
    }
    case "asset": {
      if (kind !== "asset") return undefined;
      // Clearing always fits; an asset fits a row that names its type, or one already holding that type.
      if (value === null) return null;
      if (typeof value !== "string" || !entry.assetType) return undefined;
      const accepts = row.assetTypes ? row.assetTypes.includes(entry.assetType) : row.value !== null && assetTypeOf(row) === entry.assetType;
      return accepts ? value : undefined;
    }
    case "range":
      return kind === "range" && isNumberArray(value, 2) ? value : undefined;
    case "value-range":
      return kind === "value-range" && entry.variant === row.rangeKind ? value : undefined;
    case "value-curve":
      return kind === "value-curve" && entry.variant === row.curveKind ? value : undefined;
    case "curve":
      return kind === "curve" && Array.isArray(value) && withinCount(value.length, row.minKeys, row.maxKeys) ? value : undefined;
    case "gradient":
      return kind === "gradient" && Array.isArray(value) && withinCount(value.length, row.minStops, row.maxStops) ? value : undefined;
    case "tag":
    case "tag-container":
      return kind === row.kind ? value : undefined;
    case "info":
      return undefined;
  }
}

export function canPastePropertyRow(row: PropertyRow, entry: PropertyClipboardEntry | null = copied): boolean {
  return pastedPropertyValue(row, entry) !== undefined;
}

/** Sets the copied value on `row` as one finished edit; false when the row does not take it. */
export function pastePropertyRow(row: PropertyRow, entry: PropertyClipboardEntry | null = copied): boolean {
  const pasted = pastedPropertyValue(row, entry);
  if (pasted === undefined) return false;
  const value = structuredClone(pasted);
  // Same shape as Reset: change, then commit for rows that report finished edits.
  (row as { onChange: (value: unknown) => void }).onChange(value);
  if ("onCommit" in row) (row as { onCommit?: (value: unknown) => void }).onCommit?.(value);
  return true;
}
