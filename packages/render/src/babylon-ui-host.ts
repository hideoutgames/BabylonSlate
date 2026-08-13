import type { Control } from "@babylonjs/gui/2D/controls/control";
import { Control as GuiControl } from "@babylonjs/gui/2D/controls/control";
import { Rectangle } from "@babylonjs/gui/2D/controls/rectangle";
import { StackPanel } from "@babylonjs/gui/2D/controls/stackPanel";
import { Grid } from "@babylonjs/gui/2D/controls/grid";
import { ScrollViewer } from "@babylonjs/gui/2D/controls/scrollViewers/scrollViewer";
import { Button } from "@babylonjs/gui/2D/controls/button";
import { TextBlock } from "@babylonjs/gui/2D/controls/textBlock";
import { InputText } from "@babylonjs/gui/2D/controls/inputText";
import { Slider } from "@babylonjs/gui/2D/controls/sliders/slider";
import { Checkbox } from "@babylonjs/gui/2D/controls/checkbox";
import { Image } from "@babylonjs/gui/2D/controls/image";
import { Ellipse } from "@babylonjs/gui/2D/controls/ellipse";
import { Container } from "@babylonjs/gui/2D/controls/container";
import type { AdvancedDynamicTexture } from "@babylonjs/gui/2D/advancedDynamicTexture";
import type {
  EdgeInsets,
  GuiControlSpec,
  HorizontalAlignment,
  ScaleRule,
  SizeUnit,
  UiControlDescriptor,
  VerticalAlignment,
} from "@babylonslate/ui-runtime";
import {
  guiSpecFromDescriptor,
  SAFE_AREA_CONTROL_ID,
  ZERO_INSETS,
} from "@babylonslate/ui-runtime";
import { joystickAxesFromLocal, type UiApplyHost } from "./ui-apply";

export interface GuiControlHandle {
  id: string;
  type: GuiControlSpec["type"];
  spec: GuiControlSpec;
  dispose: () => void;
  control?: Control;
}

export interface GuiControlFactory {
  create(spec: GuiControlSpec): GuiControlHandle;
  clear(): void;
}

export interface BabylonUiHostOptions {
  interactive: boolean;
  resolveImageUrl?: (guid: string) => string | null;
  onTouchAxis?: (controlId: string, value: number) => void;
  markDirty?: () => void;
}

export class BabylonUiApplyHost implements UiApplyHost {
  readonly visibility = new Map<string, boolean>();
  private handles: GuiControlHandle[] = [];
  private readonly factory: GuiControlFactory;
  private readonly options: BabylonUiHostOptions;

  constructor(factory: GuiControlFactory, options: BabylonUiHostOptions) {
    this.factory = factory;
    this.options = options;
  }

  clear(): void {
    for (const handle of this.handles) handle.dispose();
    this.handles = [];
    this.visibility.clear();
    this.factory.clear();
  }

  addControl(descriptor: UiControlDescriptor): void {
    const spec = guiSpecFromDescriptor(descriptor, {
      interactive: this.options.interactive,
    });
    if (this.visibility.get(descriptor.id) === false) {
      spec.hitTestVisible = false;
    }
    const handle = this.factory.create(spec);
    this.handles.push(handle);
    this.visibility.set(descriptor.id, descriptor.visible);
    if (
      this.options.interactive &&
      this.options.onTouchAxis &&
      handle.control &&
      descriptor.visible
    ) {
      bindDescriptorTouchInput(handle.control, descriptor, this.options.onTouchAxis);
    }
  }

  setVisible(widgetId: string, visible: boolean): void {
    this.visibility.set(widgetId, visible);
  }

  markAsDirty(): void {
    this.options.markDirty?.();
  }

  /** ADT bitmap bounds after layout; empty when a control has not measured yet. */
  measureControls(): Record<string, { x: number; y: number; width: number; height: number }> {
    const out: Record<string, { x: number; y: number; width: number; height: number }> = {};
    for (const handle of this.handles) {
      const control = handle.control;
      if (!control) continue;
      const width = control.widthInPixels;
      const height = control.heightInPixels;
      if (!(width > 0) || !(height > 0)) continue;
      out[handle.id] = {
        x: control.centerX - width / 2,
        y: control.centerY - height / 2,
        width,
        height,
      };
    }
    return out;
  }
}

function sizeValue(value: number, unit: SizeUnit): string {
  if (unit === "percent") return `${value}%`;
  return `${value}px`;
}

function horizontalAlignmentValue(value: HorizontalAlignment): number {
  if (value === "center") return GuiControl.HORIZONTAL_ALIGNMENT_CENTER;
  if (value === "right") return GuiControl.HORIZONTAL_ALIGNMENT_RIGHT;
  return GuiControl.HORIZONTAL_ALIGNMENT_LEFT;
}

function verticalAlignmentValue(value: VerticalAlignment): number {
  if (value === "center") return GuiControl.VERTICAL_ALIGNMENT_CENTER;
  if (value === "bottom") return GuiControl.VERTICAL_ALIGNMENT_BOTTOM;
  return GuiControl.VERTICAL_ALIGNMENT_TOP;
}

function applyCommon(control: Control, spec: GuiControlSpec): void {
  control.horizontalAlignment = horizontalAlignmentValue(spec.horizontalAlignment);
  control.verticalAlignment = verticalAlignmentValue(spec.verticalAlignment);
  control.left = `${spec.left}px`;
  control.top = `${spec.top}px`;
  control.width = sizeValue(spec.width, spec.widthUnit);
  control.height = sizeValue(spec.height, spec.heightUnit);
  control.paddingLeft = `${spec.padding.left}px`;
  control.paddingRight = `${spec.padding.right}px`;
  control.paddingTop = `${spec.padding.top}px`;
  control.paddingBottom = `${spec.padding.bottom}px`;
  control.transformCenterX = spec.transformCenter.x;
  control.transformCenterY = spec.transformCenter.y;
  control.isVisible = spec.alpha !== 0;
  if (typeof spec.alpha === "number") control.alpha = spec.alpha;
  control.isHitTestVisible = spec.hitTestVisible;
  control.isPointerBlocker = spec.isPointerBlocker;
  if (spec.fontFamily) control.fontFamily = spec.fontFamily;
  if (typeof spec.fontSize === "number") control.fontSize = spec.fontSize;
  if (spec.color) control.color = spec.color;
}

function createProgressBar(spec: GuiControlSpec): Control {
  const track = new Rectangle(`${spec.id}:track`);
  applyCommon(track, spec);
  track.thickness = 0;
  track.background = spec.background ?? "#333333";
  const fill = new Rectangle(`${spec.id}:fill`);
  fill.horizontalAlignment = GuiControl.HORIZONTAL_ALIGNMENT_LEFT;
  fill.verticalAlignment = GuiControl.VERTICAL_ALIGNMENT_CENTER;
  fill.height = "100%";
  const progress = Math.max(0, Math.min(1, spec.progress ?? 0));
  fill.width = `${progress * 100}%`;
  fill.thickness = 0;
  fill.background = spec.color ?? "#4ade80";
  track.addControl(fill);
  return track;
}

function createTouchDPad(spec: GuiControlSpec): Control {
  const root = new Rectangle(spec.id);
  applyCommon(root, spec);
  root.thickness = spec.thickness ?? 0;
  if (spec.background) root.background = spec.background;
  const spots: Array<{
    name: string;
    horizontal: number;
    vertical: number;
    size: string;
  }> = [
    {
      name: "up",
      horizontal: GuiControl.HORIZONTAL_ALIGNMENT_CENTER,
      vertical: GuiControl.VERTICAL_ALIGNMENT_TOP,
      size: "28%",
    },
    {
      name: "down",
      horizontal: GuiControl.HORIZONTAL_ALIGNMENT_CENTER,
      vertical: GuiControl.VERTICAL_ALIGNMENT_BOTTOM,
      size: "28%",
    },
    {
      name: "left",
      horizontal: GuiControl.HORIZONTAL_ALIGNMENT_LEFT,
      vertical: GuiControl.VERTICAL_ALIGNMENT_CENTER,
      size: "28%",
    },
    {
      name: "right",
      horizontal: GuiControl.HORIZONTAL_ALIGNMENT_RIGHT,
      vertical: GuiControl.VERTICAL_ALIGNMENT_CENTER,
      size: "28%",
    },
    {
      name: "center",
      horizontal: GuiControl.HORIZONTAL_ALIGNMENT_CENTER,
      vertical: GuiControl.VERTICAL_ALIGNMENT_CENTER,
      size: "34%",
    },
  ];
  for (const spot of spots) {
    const ellipse = new Ellipse(`${spec.id}:${spot.name}`);
    ellipse.width = spot.size;
    ellipse.height = spot.size;
    ellipse.horizontalAlignment = spot.horizontal;
    ellipse.verticalAlignment = spot.vertical;
    ellipse.thickness = 0;
    ellipse.background = spec.color ?? "#e5e5e5";
    ellipse.isHitTestVisible = false;
    ellipse.isPointerBlocker = false;
    root.addControl(ellipse);
  }
  return root;
}

export function createBabylonControl(
  spec: GuiControlSpec,
  options: Pick<BabylonUiHostOptions, "resolveImageUrl"> = {},
): Control {
  switch (spec.type) {
    case "Button": {
      const button = Button.CreateSimpleButton(spec.id, spec.text ?? "");
      applyCommon(button, spec);
      button.thickness = spec.thickness ?? 0;
      if (spec.background) button.background = spec.background;
      if (typeof spec.cornerRadius === "number") button.cornerRadius = spec.cornerRadius;
      return button;
    }
    case "TextBlock": {
      const text = new TextBlock(spec.id, spec.text ?? "");
      applyCommon(text, spec);
      return text;
    }
    case "InputText": {
      const input = new InputText(spec.id, spec.text ?? "");
      applyCommon(input, spec);
      if (spec.background) input.background = spec.background;
      return input;
    }
    case "Slider": {
      const slider = new Slider(spec.id);
      applyCommon(slider, spec);
      slider.minimum = spec.sliderMin ?? 0;
      slider.maximum = spec.sliderMax ?? 1;
      slider.value = spec.sliderValue ?? 0;
      return slider;
    }
    case "Checkbox": {
      const box = new Checkbox(spec.id);
      applyCommon(box, spec);
      box.isChecked = spec.checked ?? false;
      return box;
    }
    case "Image": {
      const url = spec.imageGuid
        ? (options.resolveImageUrl?.(spec.imageGuid) ?? "")
        : "";
      const image = new Image(spec.id, url);
      applyCommon(image, spec);
      return image;
    }
    case "Ellipse": {
      const ellipse = new Ellipse(spec.id);
      applyCommon(ellipse, spec);
      ellipse.thickness = spec.thickness ?? 2;
      ellipse.background = spec.background ?? "#000000";
      return ellipse;
    }
    case "StackPanel": {
      const panel = new StackPanel(spec.id);
      applyCommon(panel, spec);
      panel.isVertical = spec.isVertical ?? true;
      panel.spacing = spec.spacing ?? 0;
      if (spec.background) panel.background = spec.background;
      return panel;
    }
    case "Grid": {
      const grid = new Grid(spec.id);
      applyCommon(grid, spec);
      const columns = Math.max(1, spec.gridColumns ?? 2);
      const rows = Math.max(1, spec.gridRows ?? 2);
      for (let column = 0; column < columns; column++) {
        grid.addColumnDefinition(1 / columns, false);
      }
      for (let row = 0; row < rows; row++) {
        grid.addRowDefinition(1 / rows, false);
      }
      if (spec.background) grid.background = spec.background;
      return grid;
    }
    case "ScrollViewer": {
      const scroll = new ScrollViewer(spec.id);
      applyCommon(scroll, spec);
      return scroll;
    }
    case "ProgressBar":
      return createProgressBar(spec);
    case "Container": {
      const container = new Container(spec.id);
      applyCommon(container, spec);
      return container;
    }
    default: {
      if (spec.kind === "TouchDPad") {
        return createTouchDPad(spec);
      }
      const rect = new Rectangle(spec.id);
      applyCommon(rect, spec);
      rect.thickness = spec.thickness ?? 0;
      if (spec.background) rect.background = spec.background;
      if (typeof spec.cornerRadius === "number") rect.cornerRadius = spec.cornerRadius;
      return rect;
    }
  }
}

export interface GuiTextureHost {
  addControl(control: Control): unknown;
  removeControl(control: Control): unknown;
}

export interface AdtFactoryOptions extends Pick<
  BabylonUiHostOptions,
  "resolveImageUrl" | "onTouchAxis"
> {
  safeArea?: EdgeInsets;
}

export function createAdtControlFactory(
  adt: GuiTextureHost,
  options: AdtFactoryOptions = {},
): GuiControlFactory {
  const byId = new Map<string, Control>();
  const handles: Control[] = [];
  let safeArea: Container | null = null;
  let rootCanvas: Container | null = null;

  const attach = (parent: Container | GuiTextureHost, child: Control): void => {
    if ("addControl" in parent) {
      parent.addControl(child);
    }
  };

  const ensureSafeArea = (canvas: Container): Container => {
    if (safeArea) return safeArea;
    const insets = options.safeArea ?? ZERO_INSETS;
    const box = new Container(SAFE_AREA_CONTROL_ID);
    box.horizontalAlignment = GuiControl.HORIZONTAL_ALIGNMENT_LEFT;
    box.verticalAlignment = GuiControl.VERTICAL_ALIGNMENT_TOP;
    box.width = "100%";
    box.height = "100%";
    box.paddingLeft = `${insets.left}px`;
    box.paddingRight = `${insets.right}px`;
    box.paddingTop = `${insets.top}px`;
    box.paddingBottom = `${insets.bottom}px`;
    box.isHitTestVisible = false;
    box.isPointerBlocker = false;
    canvas.addControl(box);
    byId.set(SAFE_AREA_CONTROL_ID, box);
    handles.push(box);
    safeArea = box;
    return box;
  };

  return {
    create(spec) {
      const control = createBabylonControl(spec, options);
      byId.set(spec.id, control);
      handles.push(control);
      if (!spec.parentId) {
        attach(adt, control);
        if (spec.kind === "Canvas" && control instanceof Container) {
          rootCanvas = control;
          ensureSafeArea(control);
        }
      } else if (spec.parentId === SAFE_AREA_CONTROL_ID) {
        const box =
          safeArea ?? (rootCanvas ? ensureSafeArea(rootCanvas) : null);
        if (box) box.addControl(control);
        else attach(adt, control);
      } else {
        const parent = byId.get(spec.parentId);
        if (parent instanceof Grid && spec.layoutMode === "grid") {
          parent.addControl(control, spec.gridRow ?? 0, spec.gridColumn ?? 0);
        } else if (parent instanceof Container) {
          parent.addControl(control);
        } else {
          attach(adt, control);
        }
      }
      return {
        id: spec.id,
        type: spec.type,
        spec,
        control,
        dispose: () => {
          const parent = control.parent;
          if (parent instanceof Container) {
            parent.removeControl(control);
          } else {
            adt.removeControl(control);
          }
          control.dispose();
        },
      };
    },
    clear() {
      for (const control of handles) {
        const parent = control.parent;
        if (parent instanceof Container) {
          parent.removeControl(control);
        } else {
          adt.removeControl(control);
        }
        control.dispose();
      }
      handles.length = 0;
      byId.clear();
      safeArea = null;
      rootCanvas = null;
    },
  };
}

export interface AdtIdealTarget {
  idealWidth: number;
  idealHeight: number;
  useSmallestIdeal: boolean;
}

export type ScreenRect = { x: number; y: number; width: number; height: number };

export interface DesignerGizmoState {
  selection?: ScreenRect | null;
  handles?: Partial<Record<string, ScreenRect>> | null;
  safeArea?: ScreenRect | null;
  pivot?: { x: number; y: number } | null;
}

function placeGizmo(control: Control, rect: ScreenRect): void {
  control.horizontalAlignment = GuiControl.HORIZONTAL_ALIGNMENT_LEFT;
  control.verticalAlignment = GuiControl.VERTICAL_ALIGNMENT_TOP;
  control.left = `${rect.x}px`;
  control.top = `${rect.y}px`;
  control.width = `${Math.max(1, rect.width)}px`;
  control.height = `${Math.max(1, rect.height)}px`;
  control.isHitTestVisible = false;
  control.isPointerBlocker = false;
}

/** Editor-only gizmo controls (never written to the UserInterface asset). */
export function createDesignerGizmoControls(state: DesignerGizmoState): Control[] {
  const controls: Control[] = [];
  if (state.safeArea) {
    const safe = new Rectangle("gizmo:safe");
    placeGizmo(safe, state.safeArea);
    safe.thickness = 1;
    safe.color = "#60a5fa";
    safe.background = "transparent";
    safe.alpha = 0.85;
    controls.push(safe);
  }
  if (state.selection) {
    const outline = new Rectangle("gizmo:selection");
    placeGizmo(outline, state.selection);
    outline.thickness = 2;
    outline.color = "#3b82f6";
    outline.background = "transparent";
    controls.push(outline);
  }
  if (state.handles) {
    for (const [edge, rect] of Object.entries(state.handles)) {
      if (!rect) continue;
      const handle = new Rectangle(`gizmo:handle:${edge}`);
      placeGizmo(handle, rect);
      handle.thickness = 1;
      handle.color = "#3b82f6";
      handle.background = "#ffffff";
      controls.push(handle);
    }
  }
  if (state.pivot) {
    const pivot = new Ellipse("gizmo:pivot");
    placeGizmo(pivot, {
      x: state.pivot.x - 6,
      y: state.pivot.y - 6,
      width: 12,
      height: 12,
    });
    pivot.thickness = 2;
    pivot.color = "#f97316";
    pivot.background = "#ffffff";
    controls.push(pivot);
  }
  return controls;
}

export function paintDesignerGizmos(
  adt: AdvancedDynamicTexture,
  state: DesignerGizmoState,
): void {
  for (const child of [...adt.rootContainer.children]) {
    adt.removeControl(child);
    child.dispose();
  }
  for (const control of createDesignerGizmoControls(state)) {
    adt.addControl(control);
  }
  adt.markAsDirty();
}

export function applyAdtIdeal(
  adt: AdtIdealTarget,
  designResolution: { width: number; height: number },
  scaleRule: ScaleRule,
): void {
  if (scaleRule === "fitWidth") {
    adt.idealWidth = designResolution.width;
    adt.idealHeight = 0;
    adt.useSmallestIdeal = false;
    return;
  }
  if (scaleRule === "fitHeight") {
    adt.idealWidth = 0;
    adt.idealHeight = designResolution.height;
    adt.useSmallestIdeal = false;
    return;
  }
  adt.idealWidth = designResolution.width;
  adt.idealHeight = designResolution.height;
  adt.useSmallestIdeal = true;
}

function numberProp(
  props: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = props[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringProp(
  props: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = props[key];
  return typeof value === "string" && value !== "" ? value : fallback;
}

/** Wire Play pointer observables on a Babylon control from the widget descriptor. */
export function bindDescriptorTouchInput(
  control: Control,
  descriptor: UiControlDescriptor,
  onTouchAxis: (controlId: string, value: number) => void,
): void {
  const kind = descriptor.kind;
  if (kind === "TouchJoystick" || kind === "TouchDPad") {
    const deadZone = numberProp(descriptor.props, "deadZone", kind === "TouchDPad" ? 0.15 : 0.15);
    const controlIdX = stringProp(
      descriptor.props,
      "controlIdX",
      kind === "TouchDPad" ? "dpad-x" : "joystick-x",
    );
    const controlIdY = stringProp(
      descriptor.props,
      "controlIdY",
      kind === "TouchDPad" ? "dpad-y" : "joystick-y",
    );
    const emit = (localX: number, localY: number) => {
      const width = control.widthInPixels || descriptor.guiRect.width;
      const height = control.heightInPixels || descriptor.guiRect.height;
      const axes = joystickAxesFromLocal(localX, localY, width, height, deadZone);
      onTouchAxis(controlIdX, axes.x);
      onTouchAxis(controlIdY, axes.y);
    };
    control.onPointerDownObservable.add((info) => emit(info.x, info.y));
    control.onPointerMoveObservable.add((info) => emit(info.x, info.y));
    const release = () => {
      onTouchAxis(controlIdX, 0);
      onTouchAxis(controlIdY, 0);
    };
    control.onPointerUpObservable.add(release);
    control.onPointerOutObservable.add(release);
    return;
  }
  if (kind === "TouchButton") {
    const action = stringProp(descriptor.props, "action", "Jump");
    control.onPointerDownObservable.add(() => onTouchAxis(action, 1));
    const release = () => onTouchAxis(action, 0);
    control.onPointerUpObservable.add(release);
    control.onPointerOutObservable.add(release);
    return;
  }
  if (kind === "Slider") {
    const sliderId = stringProp(descriptor.props, "controlId", "slider");
    const emit = (localX: number) => {
      const width = control.widthInPixels || descriptor.guiRect.width;
      const t = width > 0 ? localX / width : 0;
      onTouchAxis(sliderId, Math.max(-1, Math.min(1, t * 2 - 1)));
    };
    control.onPointerDownObservable.add((info) => emit(info.x));
    control.onPointerMoveObservable.add((info) => emit(info.x));
  }
}
