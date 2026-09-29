import { parsePainter2DProperties, SCENE_LAYER_HIT_TESTS, SCENE_LAYER_HIT_TEST_LABELS, type SerializedComponent } from "@babylonslate/core";
import type { PropertyRow } from "@babylonslate/editor-kit";

export function painterPropertyRows(actorId: string, component: SerializedComponent, update: (property: string, value: unknown) => void): PropertyRow[] {
  const value = parsePainter2DProperties(component.properties), defaults = parsePainter2DProperties({});
  const id = (key: string) => `${actorId}-${component.id}-${key}`;
  const number = (key: "width" | "height" | "pixelsPerUnit" | "strokeWidth", label: string, min: number, description?: string): PropertyRow => ({
    kind: "number", id: id(key), label, value: value[key], defaultValue: defaults[key], min, precision: 3, sensitivity: 0.01, description,
    onChange: (next) => update(key, Math.max(min, next)),
  });
  const boolean = (key: "clearEachFrame" | "fill" | "stroke", label: string, description?: string): PropertyRow => ({
    kind: "boolean", id: id(key), label, value: value[key], defaultValue: defaults[key], description, onChange: (next) => update(key, next),
  });
  return [
    number("width", "Width", 0.001, "Drawing bounds in SceneLayer units, centered on this component."),
    number("height", "Height", 0.001),
    number("pixelsPerUnit", "Pixels Per Unit", 1, "Raster quality. Resolution is bounded to 4096 pixels per side and four million pixels per painter."),
    boolean("clearEachFrame", "Clear Each Frame", "Clear drawing and mask/path state before each simulation Tick. Disable to retain drawing until Clear."),
    boolean("fill", "Fill"), boolean("stroke", "Stroke"),
    { kind: "color4", id: id("fillColor"), label: "Fill Color", value: value.fillColor, defaultValue: defaults.fillColor, onChange: (next) => update("fillColor", next) },
    { kind: "color4", id: id("strokeColor"), label: "Stroke Color", value: value.strokeColor, defaultValue: defaults.strokeColor, onChange: (next) => update("strokeColor", next) },
    number("strokeWidth", "Stroke Width", 0, "Line width in SceneLayer units."),
    { kind: "enum", id: id("lineCap"), label: "Line Cap", value: value.lineCap, defaultValue: defaults.lineCap, options: ["butt", "round", "square"].map((entry) => ({ value: entry, label: entry[0]!.toUpperCase() + entry.slice(1) })), onChange: (next) => update("lineCap", next) },
    { kind: "enum", id: id("lineJoin"), label: "Line Join", value: value.lineJoin, defaultValue: defaults.lineJoin, options: ["miter", "round", "bevel"].map((entry) => ({ value: entry, label: entry[0]!.toUpperCase() + entry.slice(1) })), onChange: (next) => update("lineJoin", next) },
    { kind: "enum", id: id("fillRule"), label: "Fill Rule", value: value.fillRule, defaultValue: defaults.fillRule, options: [{ value: "nonzero", label: "Nonzero" }, { value: "evenodd", label: "Even Odd" }], onChange: (next) => update("fillRule", next) },
    { kind: "enum", id: id("hitTest"), label: "Hit Test", value: value.hitTest, defaultValue: defaults.hitTest, options: SCENE_LAYER_HIT_TESTS.map((entry) => ({ value: entry, label: SCENE_LAYER_HIT_TEST_LABELS[entry] })), description: "Uses the drawing bounds. Add 2D Button or 2D Focus Target for interaction.", onChange: (next) => update("hitTest", next) },
  ];
}
