import type { UiControlDescriptor } from "./controls";
import type { WidgetKind } from "./types";

export type GuiControlType =
  | "Rectangle"
  | "StackPanel"
  | "Grid"
  | "ScrollViewer"
  | "Button"
  | "TextBlock"
  | "InputText"
  | "Slider"
  | "Checkbox"
  | "Image"
  | "ProgressBar"
  | "Container"
  | "Ellipse";

export type GuiAlignment = "left" | "top";

export interface GuiControlSpec {
  id: string;
  type: GuiControlType;
  left: number;
  top: number;
  width: number;
  height: number;
  horizontalAlignment: GuiAlignment;
  verticalAlignment: GuiAlignment;
  text?: string;
  background?: string;
  color?: string;
  fontFamily?: string;
  fontSize?: number;
  alpha?: number;
  cornerRadius?: number;
  thickness?: number;
  isVertical?: boolean;
  hitTestVisible: boolean;
  isPointerBlocker: boolean;
  imageGuid?: string | null;
  sliderValue?: number;
  checked?: boolean;
  progress?: number;
  kind: WidgetKind;
}

export function guiControlType(kind: WidgetKind): GuiControlType {
  switch (kind) {
    case "Canvas":
    case "Overlay":
    case "Border":
    case "SizeBox":
    case "UserInterface":
    case "TouchDPad":
      return "Rectangle";
    case "HorizontalBox":
    case "VerticalBox":
      return "StackPanel";
    case "Grid":
      return "Grid";
    case "ScrollBox":
      return "ScrollViewer";
    case "Button":
    case "TouchButton":
      return "Button";
    case "Text":
      return "TextBlock";
    case "TextInput":
      return "InputText";
    case "Slider":
      return "Slider";
    case "CheckBox":
      return "Checkbox";
    case "Image":
      return "Image";
    case "ProgressBar":
      return "ProgressBar";
    case "Spacer":
      return "Container";
    case "TouchJoystick":
      return "Ellipse";
  }
}

function numberProp(
  props: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = props[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boolProp(
  props: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  return typeof props[key] === "boolean" ? (props[key] as boolean) : fallback;
}

export function guiSpecFromDescriptor(
  control: UiControlDescriptor,
  options: { interactive: boolean },
): GuiControlSpec {
  const interactive = options.interactive && control.visible;
  const imageGuid =
    typeof control.props.imageGuid === "string"
      ? control.props.imageGuid
      : (control.style.imageGuid ?? null);
  return {
    id: control.id,
    kind: control.kind,
    type: guiControlType(control.kind),
    left: control.guiRect.x,
    top: control.guiRect.y,
    width: Math.max(0, control.guiRect.width),
    height: Math.max(0, control.guiRect.height),
    horizontalAlignment: "left",
    verticalAlignment: "top",
    text: control.text ?? (control.kind === "Button" ? control.name : undefined),
    background: control.style.background,
    color: control.style.color,
    fontFamily: control.style.fontFamily,
    fontSize: control.style.fontSize,
    alpha: control.style.opacity,
    cornerRadius:
      control.kind === "TouchJoystick"
        ? undefined
        : control.style.borderRadius,
    thickness: control.kind === "Border" ? 1 : 0,
    isVertical: control.kind === "VerticalBox",
    hitTestVisible: interactive,
    isPointerBlocker: interactive,
    imageGuid,
    sliderValue: numberProp(control.props, "value", 0),
    checked: boolProp(control.props, "checked", false),
    progress: numberProp(control.props, "value", 0),
  };
}
