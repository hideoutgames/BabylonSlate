import { parseUIControl2DProperties, type SerializedComponent } from "@babylonslate/core";
import { colorFromHex, colorToHex, humanizePropertyLabel, type PropertyRow } from "@babylonslate/editor-kit";
import type { ComponentPropertyContext } from "./component-property-rows";
import { focusPropertyRows } from "./focus-property-rows";

/** Shared, typed control authoring for placed actors and Class prefabs. */
export function uiControlPropertyRows(actorId: string, component: SerializedComponent, update: (key: string, value: unknown) => void, context: ComponentPropertyContext, asset: (key: string, label: string, types: string[]) => PropertyRow): PropertyRow[] {
  const p = parseUIControl2DProperties(component.classId, component.properties);
  const id = (key: string) => `${actorId}-${component.id}-${key}`;
  const number = (key: keyof typeof p, min?: number, max?: number): PropertyRow => ({ kind: "number", id: id(key), label: humanizePropertyLabel(key), value: Number(p[key]), min, max, onChange: value => update(key, value) });
  const bool = (key: keyof typeof p): PropertyRow => ({ kind: "boolean", id: id(key), label: humanizePropertyLabel(key), value: Boolean(p[key]), onChange: value => update(key, value) });
  const text = (key: keyof typeof p): PropertyRow => ({ kind: "text", id: id(key), label: humanizePropertyLabel(key), value: String(p[key]), onChange: value => update(key, value) });
  const rows: PropertyRow[] = [bool("enabled"), number("width", 0.001), number("height", 0.001)];
  const kind = component.classId;
  const range = kind === "2DRangeSliderComponent";
  const slider = kind === "2DSliderComponent" || range;
  const numeric = kind === "2DNumericInputComponent";
  const progress = kind === "2DProgressBarComponent";
  if (slider || numeric || progress) {
    rows.push(number("min"), number("max"));
    if (!progress) rows.push(number("step", 0));
    rows.push(...(range ? [number("lowerValue", p.min, p.upperValue), number("upperValue", p.lowerValue, p.max)] : [number("value", p.min, p.max)]));
  }
  if (slider || progress) rows.push({ kind: "enum", id: id("orientation"), label: "Orientation", value: p.orientation, options: [{ value: "horizontal", label: "Horizontal" }, { value: "vertical", label: "Vertical" }], onChange: value => update("orientation", value) });
  if (["2DCheckboxComponent", "2DRadioButtonComponent", "2DToggleComponent"].includes(kind)) rows.push(bool("checked"));
  if (kind === "2DRadioButtonComponent") rows.push(text("group"));
  if (kind === "2DTextInputComponent") rows.push(text("text"), text("placeholder"), number("maxLength", 0), bool("readOnly"));
  if (numeric) rows.push(bool("readOnly"));
  if (kind === "2DDropdownComponent") rows.push(text("placeholder"), number("selectedIndex", -1, p.options.length - 1));
  if (kind === "2DTextInputComponent" || numeric || kind === "2DDropdownComponent") {
    rows.push(number("fontSize", 0.01), { kind: "color", id: id("textColor"), label: "Text Color", value: colorFromHex(p.textColor), onChange: value => update("textColor", colorToHex(value)) });
  }
  rows.push(number("opacity", 0, 1), { kind: "color4", id: id("tint"), label: "Tint", value: p.tint, onChange: value => update("tint", value) });
  const parts = ["background", ...(slider || progress || kind === "2DToggleComponent" ? ["track", "fill"] : []), ...(slider || kind === "2DToggleComponent" ? ["thumb"] : []), ...(["2DCheckboxComponent", "2DRadioButtonComponent", "2DDropdownComponent", "2DTextInputComponent", "2DNumericInputComponent"].includes(kind) ? ["indicator"] : [])];
  for (const part of parts) rows.push(asset(`${part}MaterialGuid`, `${humanizePropertyLabel(part)} Material`, ["Material", "MaterialInstance"]), asset(`${part}TextureGuid`, `${humanizePropertyLabel(part)} Texture`, ["Texture"]));
  if (!progress) rows.push(...focusPropertyRows(actorId, component, update, context.focusTargets));
  return rows;
}
