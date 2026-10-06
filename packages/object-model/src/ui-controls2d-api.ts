import { UI_CONTROL_2D_VISUAL_PARTS, type UIControl2DClassId } from "@babylonslate/core";
import type { EngineClassScriptApi, EngineScriptEvent, EngineScriptFunction, EngineScriptPin, EngineScriptVariable } from "./engine-script-api";

const EXEC_IN: EngineScriptPin = { name: "exec", typeId: "exec", direction: "in" };
const EXEC_OUT: EngineScriptPin = { name: "then", typeId: "exec", direction: "out" };
const variable = (name: string, propertyKey: string, typeId = "float"): EngineScriptVariable => ({ name, propertyKey, typeId });
const event = (name: string, suffix: string): EngineScriptEvent => ({ name, eventType: `flow.event.ui${suffix}`, exportName: `onUI${suffix}` });
const fn = (name: string, runtime: string, inputs: Array<[string, string]>): EngineScriptFunction => ({
  name, runtime,
  pins: [EXEC_IN, EXEC_OUT, ...inputs.map(([pinName, typeId]) => ({ name: pinName, typeId, direction: "in" as const })),
    { name: "success", typeId: "bool", direction: "out" }],
});
const COMMON = [variable("Enabled", "enabled", "bool"), variable("Width", "width"), variable("Height", "height"),
  variable("Opacity", "opacity"), variable("Tint", "tint", "color")];
const NUMERIC = [variable("Minimum", "min"), variable("Maximum", "max"), variable("Step", "step")];
const VALUE = variable("Value", "value");
const ORIENTATION = variable("Orientation", "orientation", "string");
const CHECKED = variable("Checked", "checked", "bool");
const READ_ONLY = variable("Read Only", "readOnly", "bool");
const TEXT_STYLE = [variable("Font Size", "fontSize"), variable("Text Color", "textColor", "string")];
const VISUALS: EngineScriptVariable[] = UI_CONTROL_2D_VISUAL_PARTS.flatMap((part) => ["Material", "Texture"].map((kind) => ({
  name: `${part[0]!.toUpperCase()}${part.slice(1)} ${kind}`, propertyKey: `${part}${kind}Guid`, typeId: "asset", typeClassId: kind,
})));
const FOCUS: EngineScriptVariable[] = [
  variable("Focus Enabled", "focusEnabled", "bool"), variable("Initial Focus", "focusInitial", "bool"),
  { ...variable("Focused", "focused", "bool"), getOnly: true },
  ...["Up", "Down", "Left", "Right"].map((direction) => variable(`Focus ${direction}`, `focus${direction}`, "string")),
];
const FOCUS_FUNCTIONS: EngineScriptFunction[] = [
  fn("Set Focus", "setFocusTarget", []),
  { name: "Clear Focus", runtime: "clearFocusTarget", pins: [EXEC_IN, EXEC_OUT] },
];
const FOCUS_EVENTS: EngineScriptEvent[] = ["Enter", "Leave", "Activate"].map((suffix) => ({
  name: `On Focus ${suffix}`, eventType: `flow.event.focus${suffix}`, exportName: `onFocus${suffix}`,
}));
const SET_VALUE = fn("Set Value", "setUIControlValue", [["value", "float"]]);
const INCREMENT: EngineScriptFunction = {
  ...fn("Increment", "incrementUIControl", [["delta", "float"]]),
  description: "Add Delta steps to Value. Use 1 to increase by one step or -1 to decrease. A zero Step uses one unit.",
};
const SET_CHECKED = fn("Set Checked", "setUIControlChecked", [["checked", "bool"]]);
const VALUE_CHANGED = event("On Value Changed", "ValueChanged");
const CHECKED_CHANGED = event("On Checked Changed", "CheckedChanged");

function control(classId: UIControl2DClassId, variables: EngineScriptVariable[], functions: EngineScriptFunction[], events: EngineScriptEvent[]): EngineClassScriptApi {
  const interactive = classId !== "2DProgressBarComponent";
  return { classId,
    variables: [...COMMON, ...variables, ...VISUALS, ...(interactive ? FOCUS : [])],
    functions: [...functions, ...(interactive ? FOCUS_FUNCTIONS : [])],
    events: [...events, ...(interactive ? FOCUS_EVENTS : [])],
  };
}

/** These metadata entries feed class variables, component-bound events and NodeGraph calls. */
export const UI_CONTROL_2D_SCRIPT_APIS: readonly EngineClassScriptApi[] = [
  control("2DSliderComponent", [...NUMERIC, VALUE, ORIENTATION], [SET_VALUE, INCREMENT], [VALUE_CHANGED]),
  control("2DRangeSliderComponent", [...NUMERIC, variable("Lower Value", "lowerValue"), variable("Upper Value", "upperValue"), ORIENTATION],
    [fn("Set Range", "setUIControlRange", [["lowerValue", "float"], ["upperValue", "float"]])], [event("On Range Changed", "RangeChanged")]),
  control("2DCheckboxComponent", [CHECKED], [SET_CHECKED], [CHECKED_CHANGED]),
  control("2DRadioButtonComponent", [CHECKED, variable("Group", "group", "string")], [SET_CHECKED], [CHECKED_CHANGED]),
  control("2DToggleComponent", [CHECKED], [SET_CHECKED], [CHECKED_CHANGED]),
  control("2DTextInputComponent", [variable("Text", "text", "string"), variable("Placeholder", "placeholder", "string"),
    variable("Maximum Length", "maxLength", "int"), READ_ONLY, ...TEXT_STYLE],
    [fn("Set Text", "setUIControlText", [["text", "string"]])], [event("On Text Changed", "TextChanged"), event("On Text Submitted", "TextSubmitted")]),
  control("2DNumericInputComponent", [...NUMERIC, VALUE, READ_ONLY, ...TEXT_STYLE], [SET_VALUE, INCREMENT], [VALUE_CHANGED]),
  control("2DDropdownComponent", [{ ...variable("Options", "options", "string"), container: "array" },
    variable("Selected Index", "selectedIndex", "int"), ...TEXT_STYLE],
    [fn("Set Selected Index", "setUIControlSelectedIndex", [["index", "int"]])], [event("On Selection Changed", "SelectionChanged")]),
  control("2DProgressBarComponent", [...NUMERIC, VALUE, ORIENTATION], [SET_VALUE], [VALUE_CHANGED]),
];
