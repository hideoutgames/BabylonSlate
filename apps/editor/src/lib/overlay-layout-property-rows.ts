import { parseOverlayLayoutProperties, type SerializedComponent } from "@babylonslate/core";
import { humanizePropertyLabel, type PropertyRow } from "@babylonslate/editor-kit";

export function overlayLayoutPropertyRows(actorId: string, component: SerializedComponent, update: (key: string, value: unknown) => void): PropertyRow[] {
  const props = parseOverlayLayoutProperties(component.properties, component.classId);
  const id = (key: string) => `${actorId}-${component.id}-${key}`;
  const number = (key: keyof typeof props): PropertyRow => ({ kind: "number", id: id(key), label: humanizePropertyLabel(key), value: Number(props[key]), min: 0, onChange: value => update(key, value) });
  const select = (key: keyof typeof props, values: string[], label?: string): PropertyRow => ({ kind: "enum", id: id(key), label: label ?? humanizePropertyLabel(key), value: String(props[key]), options: values.map(value => ({ value, label: humanizePropertyLabel(value) })), onChange: value => update(key, value) });
  if (component.classId === "2DPaddingComponent") return (["paddingLeft", "paddingRight", "paddingTop", "paddingBottom"] as const).map(number);
  const rows: PropertyRow[] = [select("widthMode", ["fixed", "content", "fill"]), ...(props.widthMode === "fixed" || component.classId === "2DSpacerComponent" ? [number("width")] : []), select("heightMode", ["fixed", "content", "fill"]), ...(props.heightMode === "fixed" || component.classId === "2DSpacerComponent" ? [number("height")] : []), number("fillWeight")];
  if (component.classId === "2DSpacerComponent") return rows;
  rows.push(number("gap"), select("horizontalAlignment", ["start", "center", "end", "stretch"]), select("verticalAlignment", ["start", "center", "end", "stretch"]));
  if (component.classId === "2DScrollBoxComponent") rows.push(select("scrollAxis", ["vertical", "horizontal", "both"]), number("scrollX"), number("scrollY"));
  return rows;
}
