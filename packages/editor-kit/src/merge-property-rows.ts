import { MIXED_VALUES_LABEL } from "./numeric-expression";
import type { PropertyRow, Vector3Value } from "./property-grid";

export interface MergePropertyRowsOptions {
  /** What rows match by across items; the row id by default. Items whose ids carry their own id (`actor-1-mesh-scale`) pass the shared part. */
  key?: (row: PropertyRow) => string;
  /**
   * Runs one edit's per-item changes. A host that persists each item's change
   * from the state it rendered must apply them to one working copy and commit
   * once here, so the edit is one undo step and no item overwrites another.
   */
  batch: (apply: () => void) => void;
}

type Row<K extends PropertyRow["kind"]> = Extract<PropertyRow, { kind: K }>;

function same(values: readonly unknown[]): boolean {
  const first = JSON.stringify(values[0]);
  return values.every((value) => JSON.stringify(value) === first);
}

/** Whether rows of one key can be edited as one: same kind and the same choices. */
function compatible(rows: readonly PropertyRow[]): boolean {
  const kind = rows[0]!.kind;
  if (!rows.every((row) => row.kind === kind)) return false;
  switch (kind) {
    case "enum":
      return same(rows.map((row) => (row as Row<"enum">).options.map((option) => option.value)));
    case "asset":
      return same(rows.map((row) => (row as Row<"asset">).assetTypes ?? null));
    case "vector3":
      return same(rows.map((row) => ((row as Row<"vector3">).axes ?? ["X", "Y", "Z"]).length));
    case "flags":
      return same(rows.map((row) => (row as Row<"flags">).bitCount ?? null));
    case "collision-responses":
      return same(rows.map((row) => (row as Row<"collision-responses">).labels));
    case "value-range":
      return same(rows.map((row) => (row as Row<"value-range">).rangeKind));
    case "value-curve":
      return same(rows.map((row) => (row as Row<"value-curve">).curveKind));
    default:
      return true;
  }
}

/**
 * The Inspector rows a multi-selection shares: rows every item has under the
 * same key, of the same kind and with the same choices, in the first item's
 * order. A row whose values differ is `mixed` and shows `Mixed Values`; an
 * edit runs each item's own `onChange` inside `batch`. Number, slider and
 * vector rows carry each item's value, so typed math and scrubs change each
 * from its own (`Mixed Values+4`); a flags edit sets or clears only the bits
 * it changed, on each item. One item's rows come back unchanged.
 */
export function mergePropertyRows(
  items: readonly (readonly PropertyRow[])[],
  { key = (row) => row.id, batch }: MergePropertyRowsOptions,
): PropertyRow[] {
  if (items.length === 0) return [];
  if (items.length === 1) return [...items[0]!];
  const byKey = items.map((rows) => new Map(rows.map((row) => [key(row), row])));
  const merged: PropertyRow[] = [];
  for (const first of items[0]!) {
    const rows = byKey.map((map) => map.get(key(first)));
    if (rows.some((row) => !row)) continue;
    const all = rows as PropertyRow[];
    if (!compatible(all)) continue;
    merged.push(mergeRow(all, batch));
  }
  return merged;
}

function mergeRow(rows: PropertyRow[], batch: (apply: () => void) => void): PropertyRow {
  const first = rows[0]!;
  const values = rows.map((row) => row.value);
  const mixed = !same(values) || rows.some((row) => row.mixed);
  const defaults = rows.map((row) => ("defaultValue" in row ? row.defaultValue : undefined));
  const base = {
    ...first,
    mixed,
    disabled: rows.some((row) => row.disabled) || undefined,
    status: same(rows.map((row) => row.status)) ? first.status : undefined,
    error: rows.find((row) => row.error)?.error,
    labelAccessory: undefined,
  };
  if ("defaultValue" in base && !same(defaults)) delete (base as { defaultValue?: unknown }).defaultValue;
  const each = (apply: (row: PropertyRow, index: number) => void) => batch(() => { rows.forEach(apply); });

  switch (first.kind) {
    case "info":
      return { ...(base as Row<"info">), value: mixed ? MIXED_VALUES_LABEL : first.value };
    case "number":
    case "slider": {
      const typed = rows as Array<Row<"number"> | Row<"slider">>;
      return {
        ...(base as Row<"number"> | Row<"slider">),
        onChange: (value: number) => each((_, index) => typed[index]!.onChange(value)),
        onCommit: (value: number) => each((_, index) => typed[index]!.onCommit?.(value)),
        itemValues: typed.map((row) => row.value),
        onItemValuesChange: (next: number[]) => each((_, index) => typed[index]!.onChange(next[index]!)),
        onItemValuesCommit: (next: number[]) => each((_, index) => typed[index]!.onCommit?.(next[index]!)),
      } as PropertyRow;
    }
    case "vector3": {
      const typed = rows as Row<"vector3">[];
      // Only the shown axes: a 2D row's hidden Z may differ without the row being mixed.
      const axisCount = ((first as Row<"vector3">).axes ?? ["X", "Y", "Z"]).length;
      const mixedAxes = Array.from({ length: axisCount }, (_, axis) =>
        !same(typed.map((row) => row.value[axis])) || typed.some((row) => row.mixedAxes?.[axis] ?? row.mixed === true));
      const withAxis = (value: Vector3Value, axis: number, next: number) => {
        const copy = [...value] as Vector3Value;
        copy[axis] = next;
        return copy;
      };
      return {
        ...(base as Row<"vector3">),
        mixed: mixedAxes.some(Boolean),
        mixedAxes,
        onChange: (value: Vector3Value) => each((_, index) => typed[index]!.onChange(value)),
        onCommit: (value: Vector3Value) => each((_, index) => typed[index]!.onCommit?.(value)),
        onAxisChange: (axis: number, next: number) => each((_, index) => {
          const row = typed[index]!;
          if (row.onAxisChange) row.onAxisChange(axis, next);
          else row.onChange(withAxis(row.value, axis, next));
        }),
        linked: typed.every((row) => row.linked === true),
        itemLinked: typed.map((row) => row.linked === true),
        onLinkedChange: typed.every((row) => row.onLinkedChange)
          ? (linked: boolean) => each((_, index) => typed[index]!.onLinkedChange!(linked))
          : undefined,
        itemValues: typed.map((row) => row.value),
        onItemValuesChange: (next: Vector3Value[]) => each((_, index) => typed[index]!.onChange(next[index]!)),
        onItemValuesCommit: (next: Vector3Value[]) => each((_, index) => typed[index]!.onCommit?.(next[index]!)),
      };
    }
    case "flags": {
      const typed = rows as Row<"flags">[];
      // Bits every item has; a changed bit is set or cleared on each item, the rest stay its own.
      const common = typed.reduce((bits, row) => bits & row.value, ~0);
      return {
        ...(base as Row<"flags">),
        value: common,
        onChange: (next: number) => {
          const set = next & ~common;
          const clear = common & ~next;
          each((_, index) => {
            const row = typed[index]!;
            row.onChange((row.value | set) & ~clear);
          });
        },
      };
    }
    case "asset": {
      const typed = rows as Row<"asset">[];
      return {
        ...(base as Row<"asset">),
        onChange: (value: string | null) => each((_, index) => typed[index]!.onChange(value)),
      };
    }
    default: {
      const typed = rows as Array<PropertyRow & { onChange: (value: unknown) => void; onCommit?: (value: unknown) => void }>;
      const withCommit = typed.some((row) => row.onCommit)
        ? { onCommit: (value: unknown) => each((_, index) => typed[index]!.onCommit?.(value)) }
        : {};
      return {
        ...base,
        onChange: (value: unknown) => each((_, index) => typed[index]!.onChange(value)),
        ...withCommit,
      } as PropertyRow;
    }
  }
}
