import { describe, expect, it, vi } from "vitest";
import {
  SAFE_AREA_CONTROL_ID,
  createDefaultUserInterface,
  createWidget,
  describeUiControls,
  guiSpecFromDescriptor,
  layoutUserInterface,
  pinLayout,
  stretchLayout,
  type UiControlDescriptor,
} from "@babylonslate/ui-runtime";
import { applyUiControls, RecordingUiHost } from "./ui-apply";
import { Vector2 } from "@babylonjs/core";
import { Control as GuiControl } from "@babylonjs/gui/2D/controls/control";
import { Container } from "@babylonjs/gui/2D/controls/container";
import { Ellipse } from "@babylonjs/gui/2D/controls/ellipse";
import { Grid } from "@babylonjs/gui/2D/controls/grid";
import { ScrollViewer } from "@babylonjs/gui/2D/controls/scrollViewers/scrollViewer";
import { Slider } from "@babylonjs/gui/2D/controls/sliders/slider";
import { StackPanel } from "@babylonjs/gui/2D/controls/stackPanel";
import { Vector2WithInfo } from "@babylonjs/gui/2D/math2D";
import {
  BabylonUiApplyHost,
  applyAdtIdeal,
  bindDescriptorTouchInput,
  createAdtControlFactory,
  createBabylonControl,
  createDesignerGizmoControls,
  type GuiControlHandle,
  type GuiControlFactory,
} from "./babylon-ui-host";

function descriptor(
  partial: Partial<UiControlDescriptor> & Pick<UiControlDescriptor, "id" | "kind">,
): UiControlDescriptor {
  return {
    name: partial.kind,
    parentId: null,
    layoutMode: "absolute",
    guiRect: { x: 0, y: 0, width: 40, height: 20 },
    visible: true,
    style: {},
    props: {},
    layout: pinLayout("left", "top", 40, 20),
    ...partial,
  };
}

class RecordingFactory implements GuiControlFactory {
  created: GuiControlHandle[] = [];

  create(spec: ReturnType<typeof guiSpecFromDescriptor>): GuiControlHandle {
    const handle = { id: spec.id, type: spec.type, spec, dispose() {} };
    this.created.push(handle);
    return handle;
  }

  clear(): void {
    this.created = [];
  }
}

function applyDocument(
  doc: ReturnType<typeof createDefaultUserInterface>,
  options: { safeArea?: { left: number; right: number; top: number; bottom: number } } = {},
) {
  const root = new Container("adt-root");
  const factory = createAdtControlFactory(root, { safeArea: options.safeArea });
  const host = new BabylonUiApplyHost(factory, { interactive: false });
  const layout = layoutUserInterface(
    doc,
    { width: 800, height: 600 },
    { safeArea: options.safeArea },
  );
  applyUiControls(host, describeUiControls(doc, layout));
  return { root, host };
}

function named(root: Container, id: string) {
  if (root.name === id) return root;
  return root.getDescendants(false).find((row) => row.name === id);
}

describe("BabylonUiApplyHost", () => {
  it("creates one Babylon control spec per laid-out widget", () => {
    const doc = createDefaultUserInterface();
    const button = createWidget(
      "btn",
      "Button",
      "Play",
      pinLayout("center", "center", 160, 40),
    );
    button.props.text = "Play";
    doc.widgets.canvas!.children = ["btn"];
    doc.widgets.btn = button;
    const layout = layoutUserInterface(doc, { width: 800, height: 600 });
    const controls = describeUiControls(doc, layout);
    const factory = new RecordingFactory();
    const host = new BabylonUiApplyHost(factory, { interactive: false });
    applyUiControls(host, controls);
    expect(factory.created.some((row) => row.id === "btn" && row.type === "Button")).toBe(
      true,
    );
    expect(factory.created.some((row) => row.id === "canvas" && row.type === "Rectangle")).toBe(
      true,
    );
    host.setVisible("btn", false);
    expect(host.visibility.get("btn")).toBe(false);
  });

  it("rebuilds from a recorder-compatible apply path", () => {
    const host = new RecordingUiHost();
    const doc = createDefaultUserInterface();
    const layout = layoutUserInterface(doc, { width: 400, height: 300 });
    applyUiControls(host, describeUiControls(doc, layout));
    expect(host.controls.length).toBeGreaterThan(0);
  });

  it("maps alignment, percent size, padding, and transform center onto a control", () => {
    const spec = guiSpecFromDescriptor(
      descriptor({
        id: "btn",
        kind: "Button",
        layout: {
          ...pinLayout("center", "bottom", 50, 32),
          widthUnit: "percent",
          padding: { left: 8, right: 4, top: 2, bottom: 6 },
          transformCenter: { x: 0.25, y: 0.75 },
        },
      }),
      { interactive: false },
    );
    const control = createBabylonControl(spec);
    expect(control.horizontalAlignment).toBe(GuiControl.HORIZONTAL_ALIGNMENT_CENTER);
    expect(control.verticalAlignment).toBe(GuiControl.VERTICAL_ALIGNMENT_BOTTOM);
    expect(control.width).toBe("50%");
    expect(control.height).toBe("32px");
    expect(control.paddingLeft).toBe("8px");
    expect(control.paddingRight).toBe("4px");
    expect(control.paddingTop).toBe("2px");
    expect(control.paddingBottom).toBe("6px");
    expect(control.transformCenterX).toBe(0.25);
    expect(control.transformCenterY).toBe(0.75);
    control.dispose();
  });

  it("applies slider min and max from the spec", () => {
    const spec = guiSpecFromDescriptor(
      descriptor({
        id: "slider",
        kind: "Slider",
        props: { value: 3, min: 1, max: 9 },
      }),
      { interactive: false },
    );
    const control = createBabylonControl(spec) as Slider;
    expect(control.minimum).toBe(1);
    expect(control.maximum).toBe(9);
    expect(control.value).toBe(3);
    control.dispose();
  });

  it("builds TouchDPad as a Rectangle with composed Ellipses", () => {
    const spec = guiSpecFromDescriptor(
      descriptor({
        id: "pad",
        kind: "TouchDPad",
        layout: pinLayout("left", "bottom", 160, 160, 40, 0),
      }),
      { interactive: false },
    );
    const control = createBabylonControl(spec) as Container;
    const ellipses = control.getDescendants(false).filter((row) => row instanceof Ellipse);
    expect(ellipses.length).toBeGreaterThanOrEqual(4);
    control.dispose();
  });

  it("parents StackPanel, Grid, and ScrollViewer children off the ADT root", () => {
    const doc = createDefaultUserInterface();
    const column = createWidget("column", "VerticalBox", "Col", stretchLayout());
    const label = createWidget("label", "Text", "Label");
    const grid = createWidget("grid", "Grid", "Grid", stretchLayout());
    grid.props.columns = 2;
    grid.props.rows = 1;
    const cellA = createWidget("cellA", "Button", "A");
    const cellB = createWidget("cellB", "Button", "B");
    const scroll = createWidget("scroll", "ScrollBox", "Scroll", stretchLayout());
    const inner = createWidget(
      "inner",
      "Text",
      "Inner",
      pinLayout("left", "top", 200, 40),
    );
    doc.widgets.canvas!.children = ["column", "grid", "scroll"];
    column.children = ["label"];
    grid.children = ["cellA", "cellB"];
    scroll.children = ["inner"];
    doc.widgets.column = column;
    doc.widgets.label = label;
    doc.widgets.grid = grid;
    doc.widgets.cellA = cellA;
    doc.widgets.cellB = cellB;
    doc.widgets.scroll = scroll;
    doc.widgets.inner = inner;

    const { root } = applyDocument(doc);
    const rootNames = root.children.map((row) => row.name);
    expect(rootNames).not.toContain("label");
    expect(rootNames).not.toContain("inner");
    expect(rootNames).not.toContain("cellA");

    const panel = named(root, "column");
    expect(panel).toBeInstanceOf(StackPanel);
    expect((panel as StackPanel).isVertical).toBe(true);
    expect(panel?.getDescendants(false).some((row) => row.name === "label")).toBe(true);

    const gridControl = named(root, "grid");
    expect(gridControl).toBeInstanceOf(Grid);
    const gridKids = (gridControl as Grid).getChildrenAt(0, 0);
    expect(gridKids?.some((row) => row.name === "cellA")).toBe(true);
    expect((gridControl as Grid).getChildrenAt(0, 1)?.some((row) => row.name === "cellB")).toBe(
      true,
    );

    const scroller = named(root, "scroll");
    expect(scroller).toBeInstanceOf(ScrollViewer);
    expect(scroller?.getDescendants(false).some((row) => row.name === "inner")).toBe(true);
  });

  it("parents default Canvas children into a padded SafeArea container", () => {
    const doc = createDefaultUserInterface();
    const pin = createWidget("pin", "Button", "Pin", pinLayout("left", "top", 80, 32));
    const bleed = createWidget(
      "bleed",
      "Border",
      "Bleed",
      pinLayout("left", "top", 80, 32),
    );
    bleed.ignoreSafeArea = true;
    doc.widgets.canvas!.children = ["pin", "bleed"];
    doc.widgets.pin = pin;
    doc.widgets.bleed = bleed;
    const { root } = applyDocument(doc, {
      safeArea: { left: 10, right: 12, top: 20, bottom: 24 },
    });
    const safe = named(root, SAFE_AREA_CONTROL_ID);
    expect(safe).toBeInstanceOf(Container);
    expect(safe?.paddingTop).toBe("20px");
    expect(safe?.paddingBottom).toBe("24px");
    expect(safe?.getDescendants(false).some((row) => row.name === "pin")).toBe(true);
    expect(safe?.getDescendants(false).some((row) => row.name === "bleed")).toBe(false);
    const canvas = named(root, "canvas") as Container;
    expect(canvas.getDescendants(false).some((row) => row.name === "bleed")).toBe(true);
  });

  it("maps scale rules onto ADT ideal width/height", () => {
    const adt = { idealWidth: 0, idealHeight: 0, useSmallestIdeal: false };
    applyAdtIdeal(adt, { width: 1920, height: 1080 }, "shortestSide");
    expect(adt.idealWidth).toBe(1920);
    expect(adt.idealHeight).toBe(1080);
    expect(adt.useSmallestIdeal).toBe(true);
    applyAdtIdeal(adt, { width: 1920, height: 1080 }, "fitWidth");
    expect(adt.idealWidth).toBe(1920);
    expect(adt.idealHeight).toBe(0);
    expect(adt.useSmallestIdeal).toBe(false);
    applyAdtIdeal(adt, { width: 1920, height: 1080 }, "fitHeight");
    expect(adt.idealWidth).toBe(0);
    expect(adt.idealHeight).toBe(1080);
  });

  it("emits joystick axes from a Babylon pointer on a TouchJoystick", () => {
    const onTouchAxis = vi.fn();
    const desc = descriptor({
      id: "stick",
      kind: "TouchJoystick",
      name: "Move",
      guiRect: { x: 0, y: 0, width: 160, height: 160 },
      layout: pinLayout("left", "bottom", 160, 160, 40, 0),
      props: { deadZone: 0.15, controlIdX: "joystick-x", controlIdY: "joystick-y" },
    });
    const spec = guiSpecFromDescriptor(desc, { interactive: true });
    const control = createBabylonControl(spec);
    bindDescriptorTouchInput(control, desc, onTouchAxis);
    control.onPointerDownObservable.notifyObservers(
      new Vector2WithInfo(new Vector2(160, 80)),
    );
    expect(onTouchAxis).toHaveBeenCalledWith("joystick-x", expect.closeTo(1, 5));
    expect(onTouchAxis).toHaveBeenCalledWith("joystick-y", 0);
    control.onPointerUpObservable.notifyObservers(
      new Vector2WithInfo(new Vector2(160, 80)),
    );
    expect(onTouchAxis).toHaveBeenCalledWith("joystick-x", 0);
    expect(onTouchAxis).toHaveBeenCalledWith("joystick-y", 0);
    control.dispose();
  });

  it("constructs remaining widget kinds without an ADT", () => {
    const kinds = [
      "Text",
      "TextInput",
      "Slider",
      "CheckBox",
      "ProgressBar",
      "HorizontalBox",
      "Grid",
      "ScrollBox",
      "Spacer",
      "TouchDPad",
    ] as const;
    for (const kind of kinds) {
      const spec = guiSpecFromDescriptor(
        descriptor({
          id: kind,
          kind,
          style: { background: "#111111" },
          props: { value: 0.25, checked: true },
        }),
        { interactive: false },
      );
      const control = createBabylonControl(spec);
      expect(control.name).toBe(kind === "ProgressBar" ? `${kind}:track` : kind);
      control.dispose();
    }
  });

  it("builds selection, handle, pivot, and safe-area gizmo controls", () => {
    const controls = createDesignerGizmoControls({
      selection: { x: 10, y: 20, width: 80, height: 40 },
      handles: { se: { x: 80, y: 50, width: 44, height: 44 } },
      safeArea: { x: 8, y: 8, width: 200, height: 100 },
      pivot: { x: 50, y: 40 },
    });
    expect(controls.map((row) => row.name)).toEqual([
      "gizmo:safe",
      "gizmo:selection",
      "gizmo:handle:se",
      "gizmo:pivot",
    ]);
    for (const control of controls) control.dispose();
  });

  it("omits unmeasured controls from designer hit bounds", () => {
    const doc = createDefaultUserInterface();
    const { host } = applyDocument(doc);
    expect(host.measureControls()).toEqual({});
  });

  it("emits a TouchButton action and a Slider value from pointer observables", () => {
    const onTouchAxis = vi.fn();
    const buttonDesc = descriptor({
      id: "jump",
      kind: "TouchButton",
      name: "Jump",
      guiRect: { x: 0, y: 0, width: 72, height: 72 },
      layout: pinLayout("center", "center", 72, 72),
      props: { action: "Jump" },
    });
    const button = createBabylonControl(
      guiSpecFromDescriptor(buttonDesc, { interactive: true }),
    );
    bindDescriptorTouchInput(button, buttonDesc, onTouchAxis);
    button.onPointerDownObservable.notifyObservers(
      new Vector2WithInfo(new Vector2(0, 0)),
    );
    expect(onTouchAxis).toHaveBeenCalledWith("Jump", 1);
    button.dispose();

    const sliderDesc = descriptor({
      id: "slider",
      kind: "Slider",
      name: "Slider",
      guiRect: { x: 0, y: 0, width: 100, height: 20 },
      layout: pinLayout("left", "top", 100, 20),
      props: { controlId: "look" },
    });
    const slider = createBabylonControl(
      guiSpecFromDescriptor(sliderDesc, { interactive: true }),
    );
    bindDescriptorTouchInput(slider, sliderDesc, onTouchAxis);
    slider.onPointerDownObservable.notifyObservers(
      new Vector2WithInfo(new Vector2(100, 0)),
    );
    expect(onTouchAxis).toHaveBeenCalledWith("look", 1);
    slider.dispose();
  });

  it("binds touch input when the factory returns a live control", () => {
    const onTouchAxis = vi.fn();
    const desc = descriptor({
      id: "stick",
      kind: "TouchJoystick",
      name: "Move",
      guiRect: { x: 0, y: 0, width: 160, height: 160 },
      layout: pinLayout("left", "bottom", 160, 160),
      props: { deadZone: 0.15, controlIdX: "joystick-x", controlIdY: "joystick-y" },
    });
    const control = createBabylonControl(
      guiSpecFromDescriptor(desc, { interactive: true }),
    );
    const factory: GuiControlFactory = {
      create(spec) {
        return { id: spec.id, type: spec.type, spec, control, dispose() {} };
      },
      clear() {},
    };
    const host = new BabylonUiApplyHost(factory, { interactive: true, onTouchAxis });
    host.addControl(desc);
    control.onPointerDownObservable.notifyObservers(
      new Vector2WithInfo(new Vector2(160, 80)),
    );
    expect(onTouchAxis).toHaveBeenCalledWith("joystick-x", expect.closeTo(1, 5));
    host.clear();
    control.dispose();
  });
});
