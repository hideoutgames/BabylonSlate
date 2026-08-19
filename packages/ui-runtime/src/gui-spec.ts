import type { UiControlDescriptor } from "./controls";
import type { HorizontalAlignment, VerticalAlignment, WidgetKind } from "./types";
import { defaultHitTestableFor, resizeGridTracks, type GridTrackDef } from "./types";
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
  leftUnit: SizeUnit;
  topUnit: SizeUnit;
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
    columnDefs?: GridTrackDef[];
    rowDefs?: GridTrackDef[];
    zIndex?: number;
    rotation?: number;
    scaleX?: number;
    scaleY?: number;
    fontWeight?: number | string;
    imageStretch?: number;
    hitTestVisible: boolean;
  isPointerBlocker: boolean;
  imageGuid?: string | null;
  materialGuid?: string | null;
  sliderValue?: number;
  sliderMin?: number;
  sliderMax?: number;
  checked?: boolean;
  progress?: number;
  kind: WidgetKind;
  ignoreSafeArea?: boolean;
  visible?: boolean;
}

export function guiControlType(kind: WidgetKind): GuiControlType {
  switch (kind) {
    case "Canvas":
    case "Rectangle":
    case "UserInterface":
    case "TouchButton":
    case "TouchDPad":
      return "Rectangle";
    case "StackPanel":
      return "StackPanel";
    case "Grid":
      return "Grid";
    case "ScrollViewer":
      return "ScrollViewer";
    case "Button":
      return "Button";
    case "TextBlock":
      return "TextBlock";
    case "InputText":
      return "InputText";
    case "Slider":
      return "Slider";
    case "Checkbox":
      return "Checkbox";
    case "Image":
    case "Material":
      return "Image";
    case "ProgressBar":
      return "ProgressBar";
    case "Container":
      return "Container";
    case "Ellipse":
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
  options: { interactive: boolean; allowGuiHits?: boolean },
): GuiControlSpec {
  const interactive = options.interactive && control.visible;
  const hitTestable =
    control.hitTestable ?? defaultHitTestableFor(control.kind);
  const allowGuiHits = options.allowGuiHits !== false;
  const imageGuid =
    typeof control.props.imageGuid === "string"
      ? control.props.imageGuid
      : (control.style.imageGuid ?? null);
  const materialGuid =
    typeof control.props.materialGuid === "string"
      ? control.props.materialGuid
      : null;
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
    leftUnit: slotOwned ? "px" : (layout.leftUnit ?? "px"),
    topUnit: slotOwned ? "px" : (layout.topUnit ?? "px"),
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
    fontWeight: control.style.fontWeight,
    alpha: control.style.opacity,
    cornerRadius:
      control.kind === "TouchJoystick"
        ? undefined
        : control.style.borderRadius,
    thickness: numberProp(control.props, "thickness", 0),
    isVertical: control.kind === "StackPanel" ? boolProp(control.props, "isVertical", true) : undefined,
    spacing: numberProp(control.props, "gap", 0),
    gridColumns: numberProp(control.props, "columns", 2),
    gridRows: numberProp(control.props, "rows", 2),
    columnDefs: resizeGridTracks(
      Array.isArray(control.props.gridColumns)
        ? (control.props.gridColumns as GridTrackDef[])
        : undefined,
      numberProp(control.props, "columns", 2),
    ),
    rowDefs: resizeGridTracks(
      Array.isArray(control.props.gridRows)
        ? (control.props.gridRows as GridTrackDef[])
        : undefined,
      numberProp(control.props, "rows", 2),
    ),
    zIndex: control.zIndex,
    rotation: layout.rotation,
    scaleX: layout.scaleX,
    scaleY: layout.scaleY,
    imageStretch: numberProp(control.props, "stretch", 0),
    hitTestVisible: interactive && hitTestable && allowGuiHits,
    isPointerBlocker: interactive && hitTestable && allowGuiHits,
    imageGuid,
    materialGuid,
    sliderValue: numberProp(control.props, "value", 0),
    sliderMin: numberProp(control.props, "min", 0),
    sliderMax: numberProp(control.props, "max", 1),
    checked: boolProp(control.props, "checked", false),
    progress: numberProp(control.props, "value", 0),
    ignoreSafeArea: control.ignoreSafeArea === true,
    visible: control.visible,
  };
}
