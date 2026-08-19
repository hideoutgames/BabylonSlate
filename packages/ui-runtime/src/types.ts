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
  "Rectangle",
  "StackPanel",
  "Grid",
  "ScrollViewer",
  "Ellipse",
  "Container",
  "Button",
  "TextBlock",
  "InputText",
  "Slider",
  "Checkbox",
  "Image",
  "Material",
  "ProgressBar",
  "TouchJoystick",
  "TouchButton",
  "TouchDPad",
  "UserInterface",
] as const;

export type WidgetKind = (typeof WIDGET_KINDS)[number];

/** v2 payload aliases rewritten by schema v3. */
export const LEGACY_WIDGET_KIND_ALIASES: Record<string, WidgetKind> = {
  HorizontalBox: "StackPanel",
  VerticalBox: "StackPanel",
  ScrollBox: "ScrollViewer",
  Text: "TextBlock",
  TextInput: "InputText",
  CheckBox: "Checkbox",
  Border: "Rectangle",
  Overlay: "Rectangle",
  SizeBox: "Rectangle",
  Spacer: "Container",
};

export function canonicalWidgetKind(value: unknown): WidgetKind {
  if (typeof value === "string" && (WIDGET_KINDS as readonly string[]).includes(value)) {
    return value as WidgetKind;
  }
  if (typeof value === "string" && value in LEGACY_WIDGET_KIND_ALIASES) {
    return LEGACY_WIDGET_KIND_ALIASES[value]!;
  }
  return "Rectangle";
}

export const CONTAINER_KINDS: ReadonlySet<WidgetKind> = new Set([
  "Canvas",
  "Rectangle",
  "StackPanel",
  "Grid",
  "ScrollViewer",
  "Ellipse",
  "Container",
  "UserInterface",
]);

export interface GridTrackDef {
  value: number;
  isPixel: boolean;
}

/** Keep existing Grid track defs and fill new tracks as star `1`. */
export function resizeGridTracks(
  current: readonly GridTrackDef[] | null | undefined,
  count: number,
): GridTrackDef[] {
  const n = Math.max(1, Math.floor(Number(count)) || 1);
  const src = Array.isArray(current) ? current : [];
  const next: GridTrackDef[] = [];
  for (let i = 0; i < n; i++) {
    const row = src[i];
    next.push(
      row ? { value: row.value, isPixel: row.isPixel } : { value: 1, isPixel: false },
    );
  }
  return next;
}

export interface WidgetLayout {
  horizontalAlignment: HorizontalAlignment;
  verticalAlignment: VerticalAlignment;
  width: number;
  height: number;
  widthUnit: SizeUnit;
  heightUnit: SizeUnit;
  /** Offset from the aligned edge (Babylon `left`, always added). */
  left: number;
  top: number;
  leftUnit: SizeUnit;
  topUnit: SizeUnit;
  /** Layout insets on the control (`Control.padding*`). */
  padding: EdgeInsets;
  /** Babylon `transformCenterX/Y` in [0, 1]. */
  transformCenter: Vec2;
  /** Authored rotation in degrees (Babylon `rotation` is radians). */
  rotation: number;
  scaleX: number;
  scaleY: number;
}

export interface WidgetStyle {
  background?: string;
  color?: string;
  borderRadius?: number;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number | string;
  imageGuid?: string | null;
  opacity?: number;
  pressedBackground?: string;
  disabledBackground?: string;
  hoverBackground?: string;
}

export interface WidgetExposedProperty {
  key: string;
  label: string;
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
  /** Nested UserInterface asset guid (instance slot). */
  nestedUiGuid?: string | null;
  /** @deprecated Migrated onto Button image/style or a nested Touch skin. */
  visualOverrideGuid?: string | null;
  /** When true, a Canvas child parents to the full-bleed canvas, not the SafeArea container. */
  ignoreSafeArea?: boolean;
  /** When true, the control can receive GUI pointer hits and block widgets behind it. */
  hitTestable: boolean;
  gridColumn?: number;
  gridRow?: number;
  zIndex?: number;
  /** Host-document opt-in for instance Details overrides. */
  exposed?: WidgetExposedProperty | null;
  /** Instance-slot patches keyed by nested widget id. */
  overrides?: Record<string, Record<string, unknown>>;
}

/** Slim `loadUserInterfaces` row — nested logic needs `nestedUiGuid` / overrides. */
export function widgetRuntimeMeta(widget: WidgetNode): {
  id: string;
  kind: WidgetKind;
  name?: string;
  nestedUiGuid?: string;
  exposed?: WidgetExposedProperty;
  overrides?: Record<string, Record<string, unknown>>;
} {
  return {
    id: widget.id,
    kind: widget.kind,
    ...(widget.name ? { name: widget.name } : {}),
    ...(widget.nestedUiGuid ? { nestedUiGuid: widget.nestedUiGuid } : {}),
    ...(widget.exposed ? { exposed: widget.exposed } : {}),
    ...(widget.overrides && Object.keys(widget.overrides).length > 0
      ? { overrides: widget.overrides }
      : {}),
  };
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
    leftUnit: "px",
    topUnit: "px",
    padding: { ...insets },
    transformCenter: { x: 0.5, y: 0.5 },
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
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
    leftUnit: "px",
    topUnit: "px",
    padding: { ...ZERO_INSETS },
    transformCenter: { x: 0.5, y: 0.5 },
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
  };
}

export const DEFAULT_BUTTON_BACKGROUND = "#333333";

export function defaultWidgetStyle(): WidgetStyle {
  return {
    fontSize: 18,
    opacity: 1,
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
    case "TextBlock":
      return { text: "Text" };
    case "Button":
      return { text: "Button" };
    case "InputText":
      return { text: "", placeholder: "Enter Text" };
    case "Slider":
      return { value: 0, min: 0, max: 1 };
    case "Checkbox":
      return { checked: false };
    case "ProgressBar":
      return { value: 0 };
    case "Image":
      return { imageGuid: null, stretch: 0 };
    case "Material":
      return { materialGuid: null };
    case "Grid":
      return {
        columns: 2,
        rows: 2,
        gap: 8,
        gridColumns: [
          { value: 1, isPixel: false },
          { value: 1, isPixel: false },
        ],
        gridRows: [
          { value: 1, isPixel: false },
          { value: 1, isPixel: false },
        ],
      };
    case "StackPanel":
      return { gap: 8, isVertical: true };
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
  const header = createWidget("header", "TextBlock", "Title", {
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
