import { parseOverlayContainerProperties, parseOverlayLayoutProperties, type SerializedComponent } from "@babylonslate/core";
import { humanizePropertyLabel, type ClassPickerEntry, type PropertyRow } from "@babylonslate/editor-kit";

export function overlayLayoutPropertyRows(actorId: string, component: SerializedComponent, update: (key: string, value: unknown) => void, classes: readonly ClassPickerEntry[] = []): PropertyRow[] {
  const props = { ...parseOverlayLayoutProperties(component.properties, component.classId), ...parseOverlayContainerProperties(component.properties) };
  const id = (key: string) => `${actorId}-${component.id}-${key}`;
  const number = (key: keyof typeof props, min = 0): PropertyRow => ({ kind: "number", id: id(key), label: humanizePropertyLabel(key), value: Number(props[key]), min, onChange: value => update(key, value) });
  const select = (key: keyof typeof props, values: string[], label?: string): PropertyRow => ({ kind: "enum", id: id(key), label: label ?? humanizePropertyLabel(key), value: String(props[key]), options: values.map(value => ({ value, label: humanizePropertyLabel(value) })), onChange: value => update(key, value) });
  const bool = (key: keyof typeof props): PropertyRow => ({ kind: "boolean", id: id(key), label: humanizePropertyLabel(key), value: Boolean(props[key]), onChange: value => update(key, value) });
  if (component.classId === "2DPaddingComponent") return (["paddingLeft", "paddingRight", "paddingTop", "paddingBottom"] as const).map(key => number(key));
  if (component.classId === "2DMaskComponent") return [number("width"), number("height")];
  const rows: PropertyRow[] = [select("widthMode", ["fixed", "content", "fill"]), ...(props.widthMode === "fixed" || component.classId === "2DSpacerComponent" ? [number("width")] : []), select("heightMode", ["fixed", "content", "fill"]), ...(props.heightMode === "fixed" || component.classId === "2DSpacerComponent" ? [number("height")] : []), number("fillWeight")];
  if (component.classId === "2DSpacerComponent") return rows;
  rows.push(number("gap"), select("horizontalAlignment", ["start", "center", "end", "stretch"]), select("verticalAlignment", ["start", "center", "end", "stretch"]));
  rows.push(...(["paddingLeft", "paddingRight", "paddingTop", "paddingBottom"] as const).map(key => number(key)));
  const virtual = component.classId === "2DVirtualizedListComponent" || component.classId === "2DVirtualizedGridComponent";
  if (component.classId === "2DScrollBoxComponent" || virtual) rows.push(select("scrollAxis", component.classId === "2DVirtualizedGridComponent" ? ["vertical"] : virtual ? ["vertical", "horizontal"] : ["vertical", "horizontal", "both"]), number("scrollX"), number("scrollY"));
  if (virtual) {
    rows.push({ kind: "enum", id: id("itemClassId"), label: "Item Class", value: props.itemClassId ?? "", options: [{ value: "", label: "None" }, ...classes.map(entry => ({ value: entry.id, label: humanizePropertyLabel(entry.name) }))], onChange: value => update("itemClassId", value || null) }, number("itemCount"), number("itemWidth", 0.001), number("itemHeight", 0.001), number("overscan"));
    if (component.classId === "2DVirtualizedGridComponent") rows.push(number("columns"));
  }
  if (component.classId === "2DSafeAreaComponent") rows.push(...(["useSafeArea", "safeLeft", "safeRight", "safeTop", "safeBottom"] as const).map(bool), ...(["insetLeft", "insetRight", "insetTop", "insetBottom"] as const).map(key => number(key)));
  return rows;
}
