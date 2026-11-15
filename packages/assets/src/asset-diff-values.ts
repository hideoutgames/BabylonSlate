import { humanizePropertyLabel, quaternionToEulerDegrees } from "@haptic/core";

/**
 * What changed for one item between two versions of an asset: present only
 * in the compare version (`added`), only in the base (`removed`), in both
 * but different (`changed`), or the same.
 */
export type DiffStatus = "added" | "removed" | "changed" | "unchanged";

/** One property as both versions hold it, formatted for display; null where that version lacks it. */
export interface PropertyDiffRow {
  /** Unique within its group. */
  id: string;
  label: string;
  base: string | null;
  compare: string | null;
  /** `#rrggbb` swatches when the value is a color. */
  baseColor?: string;
  compareColor?: string;
  changed: boolean;
}

/** Rows under one heading: a component, the actor itself, a settings object. */
export interface PropertyDiffGroup {
  id: string;
  title: string;
  status: DiffStatus;
  rows: PropertyDiffRow[];
}

export interface DiffCounts {
  added: number;
  removed: number;
  changed: number;
}

export function emptyCounts(): DiffCounts {
  return { added: 0, removed: 0, changed: 0 };
}

export function countStatus(counts: DiffCounts, status: DiffStatus): void {
  if (status !== "unchanged") counts[status] += 1;
}

type Plain = Record<string, unknown>;

export function isPlainObject(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

/** Structural equality of JSON-like values; key order does not matter. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) if (!sameValue(a[index], b[index])) return false;
    return true;
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const keys = Object.keys(a).filter((key) => a[key] !== undefined);
    if (keys.length !== Object.keys(b).filter((key) => b[key] !== undefined).length) return false;
    return keys.every((key) => sameValue(a[key], b[key]));
  }
  return false;
}

/** Whether both are present and equal, or both absent. */
export function statusOf(base: unknown, compare: unknown): DiffStatus {
  if (base === undefined && compare === undefined) return "unchanged";
  if (base === undefined) return "added";
  if (compare === undefined) return "removed";
  return sameValue(base, compare) ? "unchanged" : "changed";
}

const MAX_TEXT = 80;

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Math.round(value * 100) / 100;
  // A minus sign, as the Inspector shows negative values.
  return (Object.is(rounded, -0) ? 0 : rounded).toString().replace("-", "−");
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

function hexByte(channel: number): string {
  return Math.round(Math.min(1, Math.max(0, channel)) * 255).toString(16).padStart(2, "0").toUpperCase();
}

/** `#RRGGBB` for a 0–1 RGB or RGBA tuple under a color-named key, else null. */
export function colorHex(key: string, value: unknown): string | null {
  if (!/colou?r|tint/i.test(key) || !Array.isArray(value) || (value.length !== 3 && value.length !== 4)) return null;
  if (!value.every((channel) => typeof channel === "number" && channel >= 0 && channel <= 1)) return null;
  const [r, g, b] = value as number[];
  return `#${hexByte(r!)}${hexByte(g!)}${hexByte(b!)}`;
}

/** A stored value as one short line: `On`, `0, 40, 0`, `#FFD9A8`, `"Hello"` for text is shown bare. */
export function formatDiffValue(value: unknown, key = ""): string {
  if (value === undefined || value === null) return "None";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "string") return value === "" ? "Empty" : clip(value);
  const color = colorHex(key, value);
  if (color) return color;
  if (Array.isArray(value)) {
    if (value.length === 0) return "Empty";
    if (value.length <= 4 && value.every((entry) => typeof entry === "number")) return value.map((entry) => formatNumber(entry as number)).join(", ");
    if (value.every((entry) => typeof entry === "string")) return clip(value.join(", "));
    return value.length === 1 ? "1 Item" : `${value.length} Items`;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
    if (entries.length === 0) return "Empty";
    if (entries.every(([, entry]) => typeof entry === "number")) return entries.map(([, entry]) => formatNumber(entry as number)).join(", ");
    return clip(JSON.stringify(value));
  }
  return clip(String(value));
}

/** A quaternion `[x, y, z, w]` as the Inspector shows it: `−45°, 30°, 0°`. */
export function formatRotation(value: unknown): string {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((entry) => typeof entry === "number")) return formatDiffValue(value);
  return quaternionToEulerDegrees(value as [number, number, number, number]).map((degrees) => `${formatNumber(degrees)}°`).join(", ");
}

/** A row comparing one value; `format` turns a present value into its display. */
export function valueRow(id: string, label: string, base: unknown, compare: unknown, format: (value: unknown) => string = (value) => formatDiffValue(value, id)): PropertyDiffRow {
  const row: PropertyDiffRow = {
    id,
    label,
    base: base === undefined ? null : format(base),
    compare: compare === undefined ? null : format(compare),
    changed: !sameValue(base, compare),
  };
  const baseColor = base === undefined ? null : colorHex(id, base);
  const compareColor = compare === undefined ? null : colorHex(id, compare);
  if (baseColor) row.baseColor = baseColor;
  if (compareColor) row.compareColor = compareColor;
  return row;
}

/** Keys of both objects: the compare version's order, then keys only the base has. */
export function unionKeys(base: Plain | undefined, compare: Plain | undefined, skip: ReadonlySet<string> = new Set()): string[] {
  const keys = new Set<string>();
  for (const key of Object.keys(compare ?? {})) if (!skip.has(key) && compare![key] !== undefined) keys.add(key);
  for (const key of Object.keys(base ?? {})) if (!skip.has(key) && base![key] !== undefined) keys.add(key);
  return [...keys];
}

/** A row per key of two property bags, labelled as the Inspector names keys. */
export function propertyRows(base: Plain | undefined, compare: Plain | undefined, prefix = "", skip?: ReadonlySet<string>): PropertyDiffRow[] {
  return unionKeys(base, compare, skip).map((key) => valueRow(`${prefix}${key}`, humanizePropertyLabel(key), base?.[key], compare?.[key]));
}

/** The group's status from its rows, unless the whole item was added or removed. */
export function groupStatus(rows: readonly PropertyDiffRow[], presence: DiffStatus = "changed"): DiffStatus {
  if (presence === "added" || presence === "removed") return presence;
  return rows.some((row) => row.changed) ? "changed" : "unchanged";
}

/** Top-level fields of two documents as groups: objects get a group each, the rest share `title`. */
export function documentGroups(base: Plain | undefined, compare: Plain | undefined, title: string, skip: ReadonlySet<string> = new Set()): PropertyDiffGroup[] {
  const loose: PropertyDiffRow[] = [];
  const groups: PropertyDiffGroup[] = [];
  for (const key of unionKeys(base, compare, skip)) {
    const before = base?.[key];
    const after = compare?.[key];
    if ((isPlainObject(before) || before === undefined) && (isPlainObject(after) || after === undefined) && (before !== undefined || after !== undefined)) {
      const rows = propertyRows(before as Plain | undefined, after as Plain | undefined, `${key}.`);
      groups.push({ id: key, title: humanizePropertyLabel(key), status: groupStatus(rows, statusOf(before, after)), rows });
    } else {
      loose.push(valueRow(key, humanizePropertyLabel(key), before, after));
    }
  }
  return loose.length > 0 ? [{ id: "", title, status: groupStatus(loose), rows: loose }, ...groups] : groups;
}

/** `1.4 MB`, `820 KB`, `512 B`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${formatNumber(bytes / 1024)} KB`;
  return `${formatNumber(bytes / (1024 * 1024))} MB`;
}
