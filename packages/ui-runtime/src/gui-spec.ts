import type { UiControlDescriptor } from "./controls";
import type { HorizontalAlignment, VerticalAlignment, WidgetKind } from "./types";
import type { EdgeInsets, SizeUnit, Vec2 } from "./types";

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

export type GuiAlignment = HorizontalAlignment | VerticalAlignment;

export interface GuiControlSpec {
  id: string;
  type: GuiControlType;
  parentId: string | null;
  layoutMode: UiControlDescriptor["layoutMode"];
  gridColumn?: number;
  gridRow?: number;
  left: number;
  top: number;
  width: number;
  height: number;
  widthUnit: SizeUnit;
  heightUnit: SizeUnit;
  horizontalAlignment: HorizontalAlignment;
  verticalAlignment: VerticalAlignment;
  padding: EdgeInsets;
  transformCenter: Vec2;
  text?: string;
  background?: string;
  color?: string;
  fontFamily?: string;
  fontSize?: number;
  alpha?: number;
  cornerRadius?: number;
  thickness?: number;
  isVertical?: boolean;
    spacing?: number;
    gridColumns?: number;
    gridRows?: number;
    hitTestVisible: boolean;
  isPointerBlocker: boolean;
  imageGuid?: string | null;
  sliderValue?: number;
  sliderMin?: number;
  sliderMax?: number;
  checked?: boolean;
  progress?: number;
  kind: WidgetKind;
  ignoreSafeArea?: boolean;
}

export function guiControlType(kind: WidgetKind): GuiControlType {
  switch (kind) {
    case "Canvas":
    case "Overlay":
    case "Border":
    case "SizeBox":
    case "UserInterface":
    case "TouchButton":
      return "Rectangle";
    case "HorizontalBox":
    case "VerticalBox":
      return "StackPanel";
    case "Grid":
      return "Grid";
    case "ScrollBox":
      return "ScrollViewer";
    case "Button":
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
    case "TouchDPad":
      return "Rectangle";
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
  const layout = control.layout;
  const slotOwned =
    control.layoutMode === "stack" ||
    control.layoutMode === "grid" ||
    control.layoutMode === "scroll";
  return {
    id: control.id,
    kind: control.kind,
    type: guiControlType(control.kind),
    parentId: control.parentId,
    layoutMode: control.layoutMode,
    gridColumn: control.gridColumn,
    gridRow: control.gridRow,
    left: slotOwned ? 0 : layout.left,
    top: slotOwned ? 0 : layout.top,
    width: layout.width,
    height: layout.height,
    widthUnit: layout.widthUnit,
    heightUnit: layout.heightUnit,
    horizontalAlignment: layout.horizontalAlignment,
    verticalAlignment: layout.verticalAlignment,
    padding: layout.padding,
    transformCenter: layout.transformCenter,
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
    spacing: numberProp(control.props, "gap", 0),
    gridColumns: numberProp(control.props, "columns", 2),
    gridRows: numberProp(control.props, "rows", 2),
    hitTestVisible: interactive,
    isPointerBlocker: interactive,
    imageGuid,
    sliderValue: numberProp(control.props, "value", 0),
    sliderMin: numberProp(control.props, "min", 0),
    sliderMax: numberProp(control.props, "max", 1),
    checked: boolProp(control.props, "checked", false),
    progress: numberProp(control.props, "value", 0),
    ignoreSafeArea: control.ignoreSafeArea === true,
  };
}
