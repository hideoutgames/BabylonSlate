import { describe, expect, it, vi } from "vitest";
import { mergePropertyRows } from "./merge-property-rows";
import { evaluateNumericExpression } from "./numeric-expression";
import type { PropertyRow } from "./property-grid";

function numberRow(id: string, value: number, onChange = vi.fn()): PropertyRow {
  return { kind: "number", id, label: id, value, onChange };
}

describe("mergePropertyRows", () => {
  it("keeps only rows every item has with the same kind and choices, in the first item's order", () => {
    const enumRow = (options: string[]): PropertyRow => ({
      kind: "enum", id: "mode", label: "Mode", value: options[0]!, options: options.map((value) => ({ value, label: value })), onChange: vi.fn(),
    });
    const merged = mergePropertyRows([
      [numberRow("a", 1), numberRow("b", 2), enumRow(["x", "y"]), { kind: "boolean", id: "c", label: "C", value: true, onChange: vi.fn() }],
      [numberRow("b", 2), numberRow("a", 1), enumRow(["x", "y"]), { kind: "text", id: "c", label: "C", value: "", onChange: vi.fn() }],
      [numberRow("a", 1), numberRow("b", 3), enumRow(["x", "y"])],
    ], { batch: (apply) => apply() });
    expect(merged.map((row) => row.id)).toEqual(["a", "b", "mode"]);
    expect(merged.map((row) => row.mixed)).toEqual([false, true, false]);

    const differentChoices = mergePropertyRows([[enumRow(["x", "y"])], [enumRow(["x", "z"])]], { batch: (apply) => apply() });
    expect(differentChoices).toEqual([]);
  });

  it("matches by a caller's key and runs an edit's per-item changes in one batch", () => {
    const changes: Array<[string, number]> = [];
    const batch = vi.fn((apply: () => void) => apply());
    const merged = mergePropertyRows([
      [numberRow("actor-1-scale", 1, vi.fn((value) => changes.push(["1", value])))],
      [numberRow("actor-2-scale", 5, vi.fn((value) => changes.push(["2", value])))],
    ], { key: (row) => row.id.replace(/^actor-\d+-/, ""), batch });
    const [scale] = merged as Array<Extract<PropertyRow, { kind: "number" }>>;
    expect(scale!.mixed).toBe(true);
    expect(scale!.itemValues).toEqual([1, 5]);
    // "Mixed Values+4" evaluated against each item's own value.
    scale!.onItemValuesChange!(scale!.itemValues!.map((value) => evaluateNumericExpression("Mixed Values+4", value)!));
    expect(changes).toEqual([["1", 5], ["2", 9]]);
    expect(batch).toHaveBeenCalledOnce();
    scale!.onChange(3);
    expect(changes.slice(2)).toEqual([["1", 3], ["2", 3]]);
  });

  it("marks each differing vector axis and edits one axis on every item", () => {
    const onChange = [vi.fn(), vi.fn()];
    const merged = mergePropertyRows([
      [{ kind: "vector3", id: "pos", label: "Position", value: [1, 2, 3], onChange: onChange[0]! }],
      [{ kind: "vector3", id: "pos", label: "Position", value: [1, 5, 3], onChange: onChange[1]! }],
    ], { batch: (apply) => apply() }) as Array<Extract<PropertyRow, { kind: "vector3" }>>;
    expect(merged[0]!.mixedAxes).toEqual([false, true, false]);
    merged[0]!.onAxisChange!(0, 9);
    expect(onChange[0]).toHaveBeenCalledWith([9, 2, 3]);
    expect(onChange[1]).toHaveBeenCalledWith([9, 5, 3]);
  });

  it("sets or clears only the flags bits an edit changed, on each item", () => {
    const onChange = [vi.fn(), vi.fn()];
    const [flags] = mergePropertyRows([
      [{ kind: "flags", id: "layers", label: "Layers", value: 0b0011, onChange: onChange[0]! }],
      [{ kind: "flags", id: "layers", label: "Layers", value: 0b0101, onChange: onChange[1]! }],
    ], { batch: (apply) => apply() }) as Array<Extract<PropertyRow, { kind: "flags" }>>;
    expect(flags!.value).toBe(0b0001);
    // Set bit 3 and clear bit 0: bits 1 and 2 stay each item's own.
    flags!.onChange(0b1000);
    expect(onChange[0]).toHaveBeenCalledWith(0b1010);
    expect(onChange[1]).toHaveBeenCalledWith(0b1100);
  });

  it("reads a mixed fact as Mixed Values and returns one item's rows unchanged", () => {
    const [fact] = mergePropertyRows([
      [{ kind: "info", id: "keys", label: "Keys", value: "2" }],
      [{ kind: "info", id: "keys", label: "Keys", value: "3" }],
    ], { batch: (apply) => apply() });
    expect(fact!.value).toBe("Mixed Values");
    const single = [numberRow("a", 1)];
    expect(mergePropertyRows([single], { batch: (apply) => apply() })).toEqual(single);
  });
});

describe("Mixed Values in numeric expressions", () => {
  it("stands for each item's own value", () => {
    expect(evaluateNumericExpression("Mixed Values+4", 2)).toBe(6);
    expect(evaluateNumericExpression("mixed values * 2", 3)).toBe(6);
    expect(evaluateNumericExpression("(Mixed Values-1)/2", 5)).toBe(2);
    expect(evaluateNumericExpression("Mixed Values", 7)).toBe(7);
    expect(evaluateNumericExpression("Mixed Valuez", 7)).toBeUndefined();
  });
});
