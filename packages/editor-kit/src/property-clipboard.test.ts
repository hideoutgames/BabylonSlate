import { describe, expect, it, vi } from "vitest";
import { canCopyPropertyRow, pastePropertyRow, pastedPropertyValue, type PropertyClipboardEntry } from "./property-clipboard";
import type { PropertyRow } from "./property-grid";

const base = { id: "row", label: "Row" };
const number = (extra: Partial<Extract<PropertyRow, { kind: "number" }>> = {}): PropertyRow =>
  ({ ...base, kind: "number", value: 1, onChange: () => {}, ...extra });
const asset = (extra: Partial<Extract<PropertyRow, { kind: "asset" }>> = {}): PropertyRow =>
  ({ ...base, kind: "asset", value: null, onPick: () => {}, onChange: () => {}, ...extra });

describe("property clipboard", () => {
  it.each<[string, PropertyRow, PropertyClipboardEntry, unknown]>([
    ["a number into a number", number(), { kind: "number", value: 4 }, 4],
    ["a slider value into a number, clamped to its range", number({ max: 2 }), { kind: "slider", value: 5 }, 2],
    ["a number into a slider, clamped", { ...base, kind: "slider", value: 0, min: 0, max: 1, onChange: () => {} }, { kind: "number", value: -3 }, 0],
    ["a boolean into a number", number(), { kind: "boolean", value: true }, undefined],
    ["a vector into a vector of the same size", { ...base, kind: "vector3", value: [0, 0, 0], onChange: () => {} }, { kind: "vector3", value: [1, 2, 3] }, [1, 2, 3]],
    ["a vector into a vector of another size", { ...base, kind: "vector3", value: [0, 0, 0, 0], onChange: () => {} }, { kind: "vector3", value: [1, 2, 3] }, undefined],
    ["an option the enum has", { ...base, kind: "enum", value: "a", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], onChange: () => {} }, { kind: "enum", value: "b" }, "b"],
    ["an option the enum lacks", { ...base, kind: "enum", value: "a", options: [{ value: "a", label: "A" }], onChange: () => {} }, { kind: "enum", value: "b" }, undefined],
    ["a disabled option", { ...base, kind: "enum", value: "a", options: [{ value: "a", label: "A" }, { value: "b", label: "B", disabled: true }], onChange: () => {} }, { kind: "enum", value: "b" }, undefined],
    ["an RGBA color into a color, without alpha", { ...base, kind: "color", value: null, onChange: () => {} }, { kind: "color4", value: [1, 0.5, 0, 0.2] }, [1, 0.5, 0]],
    ["a color into an RGBA color, keeping its alpha", { ...base, kind: "color4", value: [0, 0, 0, 0.4], onChange: () => {} }, { kind: "color", value: [1, 1, 0] }, [1, 1, 0, 0.4]],
    ["a read-only fact into a text row", { ...base, kind: "text", value: "", onChange: () => {} }, { kind: "info", value: "12 keys" }, "12 keys"],
    ["flags beyond the row's bits", { ...base, kind: "flags", value: 0, bitCount: 4, onChange: () => {} }, { kind: "flags", value: 16 }, undefined],
    ["flags within the row's bits", { ...base, kind: "flags", value: 0, bitCount: 8, onChange: () => {} }, { kind: "flags", value: 16 }, 16],
    ["an asset of an accepted type", asset({ assetTypes: ["Texture"] }), { kind: "asset", value: "tex", assetType: "Texture" }, "tex"],
    ["an asset of another type", asset({ assetTypes: ["Material"] }), { kind: "asset", value: "tex", assetType: "Texture" }, undefined],
    ["an asset into a row holding the same type", asset({ value: "old", displayType: "Texture" }), { kind: "asset", value: "tex", assetType: "Texture" }, "tex"],
    ["an asset into an empty row that names no types", asset(), { kind: "asset", value: "tex", assetType: "Texture" }, undefined],
    ["an empty asset, which clears", asset({ value: "old", assetTypes: ["Material"] }), { kind: "asset", value: null }, null],
    ["a curve with too many keys", { ...base, kind: "curve", value: [], maxKeys: 1, onChange: () => {} }, { kind: "curve", value: [{ t: 0, v: 0 }, { t: 1, v: 1 }] }, undefined],
    ["a range of the same kind", { ...base, kind: "value-range", rangeKind: "float", value: { Min: 0, Max: 1 }, onChange: () => {} } as PropertyRow, { kind: "value-range", value: { Min: 2, Max: 3 }, variant: "float" }, { Min: 2, Max: 3 }],
    ["a range of another kind", { ...base, kind: "value-range", rangeKind: "float", value: { Min: 0, Max: 1 }, onChange: () => {} } as PropertyRow, { kind: "value-range", value: { Min: [0, 0, 0], Max: [1, 1, 1] }, variant: "vec3" }, undefined],
    ["anything into a disabled row", number({ disabled: true }), { kind: "number", value: 4 }, undefined],
  ])("pastes %s", (_name, row, entry, expected) => {
    expect(pastedPropertyValue(row, entry)).toEqual(expected);
  });

  it("does not copy a value a mixed selection only partly shares", () => {
    expect(canCopyPropertyRow(number())).toBe(true);
    expect(canCopyPropertyRow(number({ mixed: true }))).toBe(false);
    expect(canCopyPropertyRow({ ...base, kind: "vector3", value: [0, 0, 0], mixedAxes: [false, true, false], onChange: () => {} })).toBe(false);
  });

  it("pastes as one finished edit, with its own copy of the value", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const entry: PropertyClipboardEntry = { kind: "vector3", value: [1, 2, 3] };
    expect(pastePropertyRow({ ...base, kind: "vector3", value: [0, 0, 0], onChange, onCommit }, entry)).toBe(true);
    expect(onChange).toHaveBeenCalledWith([1, 2, 3]);
    expect(onCommit).toHaveBeenCalledWith([1, 2, 3]);
    expect(onChange.mock.calls[0]![0]).not.toBe(entry.value);
    expect(pastePropertyRow(number({ onChange }), entry)).toBe(false);
  });
});
