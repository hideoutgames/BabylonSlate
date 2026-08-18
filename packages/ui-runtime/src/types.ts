export type Vec2 = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };
export type EdgeInsets = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export type ScaleRule = "fitWidth" | "fitHeight" | "shortestSide";
export type HorizontalAlignment = "left" | "center" | "right";
export type VerticalAlignment = "top" | "center" | "bottom";
export type SizeUnit = "px" | "percent";

export const WIDGET_KINDS = [
  "Canvas",
  "HorizontalBox",
  "VerticalBox",
  "Grid",
  "ScrollBox",
  "Overlay",
  "SizeBox",
  "Border",
  "Button",
  "Text",
  "TextInput",
  "Slider",
  "CheckBox",
  "Image",
  "ProgressBar",
  "Spacer",
  "TouchJoystick",
  "TouchButton",
  "TouchDPad",
  "UserInterface",
] as const;

export type WidgetKind = (typeof WIDGET_KINDS)[number];

export const CONTAINER_KINDS: ReadonlySet<WidgetKind> = new Set([
  "Canvas",
  "HorizontalBox",
  "VerticalBox",
  "Grid",
  "ScrollBox",
  "Overlay",
  "SizeBox",
  "Border",
  "UserInterface",
]);

export interface WidgetLayout {
  horizontalAlignment: HorizontalAlignment;
  verticalAlignment: VerticalAlignment;
  width: number;
  height: number;
  widthUnit: SizeUnit;
  heightUnit: SizeUnit;
  /** Offset from the aligned edge (Babylon `left`, always added). */
  left: number;
  /** Offset from the aligned edge (Babylon `top`, always added, Y-down). */
  top: number;
  /** Layout insets on the control (`Control.padding*`). */
  padding: EdgeInsets;
  /** Babylon `transformCenterX/Y` in [0, 1]. */
  transformCenter: Vec2;
}

export interface WidgetStyle {
  background?: string;
  color?: string;
  borderRadius?: number;
  padding?: EdgeInsets;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number | string;
  imageGuid?: string | null;
  opacity?: number;
  pressedBackground?: string;
  disabledBackground?: string;
}

export interface WidgetNode {
  id: string;
  name: string;
  kind: WidgetKind;
  layout: WidgetLayout;
  visible: boolean;
  children: string[];
  style: WidgetStyle;
  props: Record<string, unknown>;
  /** Nested UserInterface asset guid. */
  nestedUiGuid?: string | null;
  /** Visual override UserInterface for Button / TouchJoystick / TouchButton. */
  visualOverrideGuid?: string | null;
  /** When true, a Canvas child parents to the full-bleed canvas, not the SafeArea container. */
  ignoreSafeArea?: boolean;
  /** When true, the control can receive GUI pointer hits and block widgets behind it. */
  hitTestable: boolean;
}

export interface UserInterfaceDocument {
  name: string;
  rootId: string;
  designResolution: { width: number; height: number };
  /** Kept on the payload for compatibility. Desired mode and nested slots use `contentDesiredSize`. */
  desiredSize: { width: number; height: number };
  scaleRule: ScaleRule;
  viewportLayer: boolean;
  widgets: Record<string, WidgetNode>;
}

export interface TextMeasurer {
  measure(
    text: string,
    fontStack: string,
    fontSize: number,
  ): { width: number; height: number };
}

export interface LaidOutWidget {
  id: string;
  kind: WidgetKind;
  name: string;
  rect: Rect;
  transformCenter: Vec2;
  visible: boolean;
  children: LaidOutWidget[];
  widget?: WidgetNode;
}

export interface LayoutResult {
  canvas: Rect;
  scale: number;
  tree: LaidOutWidget | null;
}

export const ZERO_INSETS: EdgeInsets = {
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
};

export const DEFAULT_DESIGN_RESOLUTION = { width: 1920, height: 1080 };
export const DEFAULT_DESIRED_SIZE = { width: 400, height: 300 };

export function defaultWidgetLayout(): WidgetLayout {
  return stretchLayout();
}

export function stretchLayout(insets: EdgeInsets = ZERO_INSETS): WidgetLayout {
  return {
    horizontalAlignment: "left",
    verticalAlignment: "top",
    width: 100,
    height: 100,
    widthUnit: "percent",
    heightUnit: "percent",
    left: 0,
    top: 0,
    padding: { ...insets },
    transformCenter: { x: 0.5, y: 0.5 },
  };
}

export function pinLayout(
  horizontalAlignment: HorizontalAlignment,
  verticalAlignment: VerticalAlignment,
  width: number,
  height: number,
  left = 0,
  top = 0,
): WidgetLayout {
  return {
    horizontalAlignment,
    verticalAlignment,
    width,
    height,
    widthUnit: "px",
    heightUnit: "px",
    left,
    top,
    padding: { ...ZERO_INSETS },
    transformCenter: { x: 0.5, y: 0.5 },
  };
}

export const DEFAULT_BUTTON_BACKGROUND = "#333333";

export function defaultWidgetStyle(): WidgetStyle {
  return {
    fontSize: 18,
    opacity: 1,
    padding: { ...ZERO_INSETS },
  };
}

/** Creation-time chrome only. Loaded documents keep an omitted background. */
export function defaultStyleFor(kind: WidgetKind): WidgetStyle {
  const style = defaultWidgetStyle();
  if (kind === "Button") style.background = DEFAULT_BUTTON_BACKGROUND;
  return style;
}

export function defaultHitTestableFor(kind: WidgetKind): boolean {
  return (
    kind === "Button" ||
    kind === "TouchButton" ||
    kind === "TouchJoystick" ||
    kind === "TouchDPad"
  );
}

export function createWidget(
  id: string,
  kind: WidgetKind,
  name: string = kind,
  layout: WidgetLayout = stretchLayout(),
): WidgetNode {
  return {
    id,
    name,
    kind,
    layout,
    visible: true,
    hitTestable: defaultHitTestableFor(kind),
    children: [],
    style: defaultStyleFor(kind),
    props: defaultPropsFor(kind),
  };
}

export function defaultPropsFor(kind: WidgetKind): Record<string, unknown> {
  switch (kind) {
    case "Text":
      return { text: "Text" };
    case "Button":
      return { text: "Button" };
    case "TextInput":
      return { text: "", placeholder: "Enter Text" };
    case "Slider":
      return { value: 0, min: 0, max: 1 };
    case "CheckBox":
      return { checked: false };
    case "ProgressBar":
      return { value: 0 };
    case "Image":
      return { imageGuid: null };
    case "Spacer":
      return { flex: 1 };
    case "SizeBox":
      return { width: 100, height: 100 };
    case "Grid":
      return { columns: 2, rows: 2, gap: 8 };
    case "HorizontalBox":
    case "VerticalBox":
      return { gap: 8 };
    case "TouchJoystick":
      return {
        origin: "fixed",
        deadZone: 0.15,
        autoHide: false,
        controlIdX: "joystick-x",
        controlIdY: "joystick-y",
      };
    case "TouchButton":
      return { controlId: "touch-button", action: "Jump" };
    case "TouchDPad":
      return {
        controlIdX: "dpad-x",
        controlIdY: "dpad-y",
      };
    default:
      return {};
  }
}

export function createDefaultUserInterface(name = "HUD"): UserInterfaceDocument {
  const root = createWidget("canvas", "Canvas", "Canvas");
  return {
    name,
    rootId: root.id,
    designResolution: { ...DEFAULT_DESIGN_RESOLUTION },
    desiredSize: { ...DEFAULT_DESIRED_SIZE },
    scaleRule: "shortestSide",
    viewportLayer: true,
    widgets: { [root.id]: root },
  };
}

/** Sample viewport HUD (joystick + title) for layout and designer tests. */
export function createDefaultPlayHud(name = "HUD"): UserInterfaceDocument {
  const doc = createDefaultUserInterface(name);
  const header = createWidget("header", "Text", "Title", {
    ...stretchLayout({ left: 24, right: 24, top: 16, bottom: 0 }),
    height: 40,
    heightUnit: "px",
  });
  header.props.text = "Score";
  const stick = createWidget(
    "stick",
    "TouchJoystick",
    "Move Stick",
    pinLayout("left", "bottom", 160, 160, 40, 0),
  );
  doc.widgets.canvas!.children = ["header", "stick"];
  doc.widgets.header = header;
  doc.widgets.stick = stick;
  doc.desiredSize = { ...doc.designResolution };
  return doc;
}
