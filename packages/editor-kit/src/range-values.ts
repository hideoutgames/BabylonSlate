/** Value kinds a range holds; matches the built-in range Structures. */
export type RangeFieldKind = "int" | "float" | "vec2" | "vec3" | "rotator";

/** `{ Min, Max }`: numbers, or axis records (`x`/`y`/`z`, `pitch`/`yaw`/`roll`). */
export type RangeFieldValue = { Min: unknown; Max: unknown };

export type Axis = { key: string; label: string; accent?: "x" | "y" | "z" };

export const AXES: Record<RangeFieldKind, readonly Axis[]> = {
  int: [],
  float: [],
  vec2: [{ key: "x", label: "X", accent: "x" }, { key: "y", label: "Y", accent: "y" }],
  vec3: [{ key: "x", label: "X", accent: "x" }, { key: "y", label: "Y", accent: "y" }, { key: "z", label: "Z", accent: "z" }],
  rotator: [{ key: "pitch", label: "Pitch" }, { key: "yaw", label: "Yaw" }, { key: "roll", label: "Roll" }],
};

export type Ends = { min: number[]; max: number[] };

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function read(kind: RangeFieldKind, value: unknown): number[] {
  const axes = AXES[kind];
  if (axes.length === 0) return [finite(value)];
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return axes.map((axis) => finite(record[axis.key]));
}

function write(kind: RangeFieldKind, values: readonly number[]): unknown {
  const axes = AXES[kind];
  if (axes.length === 0) return kind === "int" ? Math.trunc(values[0] ?? 0) : values[0] ?? 0;
  return Object.fromEntries(axes.map((axis, index) => [axis.key, values[index] ?? 0]));
}

export function endsOf(kind: RangeFieldKind, value: RangeFieldValue | null | undefined): Ends {
  return { min: read(kind, value?.Min), max: read(kind, value?.Max) };
}

export function toValue(kind: RangeFieldKind, ends: Ends): RangeFieldValue {
  return { Min: write(kind, ends.min), Max: write(kind, ends.max) };
}

/** The range with Min at most Max on every axis; crossing axes are swapped. */
export function normalizeRangeFieldValue(kind: RangeFieldKind, value: RangeFieldValue | null | undefined): RangeFieldValue {
  const { min, max } = endsOf(kind, value);
  return toValue(kind, { min: min.map((a, i) => Math.min(a, max[i]!)), max: max.map((b, i) => Math.max(b, min[i]!)) });
}

function formatNumber(value: number, kind: RangeFieldKind): string {
  const text = kind === "int" ? String(Math.trunc(value)) : value.toFixed(2);
  return text.replace("-", "−");
}

/** One-line summary, as collapsed rows and Data Tree cells show it: `2–5`, `−5, 0, −5 – 5, 2, 5`. */
export function formatRangeSummary(kind: RangeFieldKind, value: RangeFieldValue | null | undefined, unit?: string): string {
  const { min, max } = endsOf(kind, value);
  const suffix = unit ? (unit === "deg" ? "°" : ` ${unit}`) : "";
  const side = (values: number[]) => values.map((entry) => formatNumber(entry, kind)).join(", ") + suffix;
  return AXES[kind].length === 0 ? `${side(min)}–${side(max)}` : `${side(min)} – ${side(max)}`;
}

/**
 * Applies one end's edit. While an edit is live, an end dragged or typed past the other pushes it along;
 * a typed edit that ends past the other end swaps instead, so the other end keeps its value. Measured from
 * `baseline`, the range when the edit began, so moving back restores the pushed end.
 */
export function applyEdit(
  baseline: Ends, axis: number, end: "min" | "max", raw: number, integer: boolean, commitTyped: boolean,
): Ends {
  const value = integer ? Math.round(raw) : raw;
  const min = [...baseline.min];
  const max = [...baseline.max];
  if (end === "min") {
    const other = baseline.max[axis]!;
    if (value > other && commitTyped) { min[axis] = other; max[axis] = value; }
    else { min[axis] = value; max[axis] = Math.max(other, value); }
  } else {
    const other = baseline.min[axis]!;
    if (value < other && commitTyped) { max[axis] = other; min[axis] = value; }
    else { max[axis] = value; min[axis] = Math.min(other, value); }
  }
  return { min, max };
}

