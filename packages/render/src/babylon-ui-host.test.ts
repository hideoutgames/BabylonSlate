import { describe, expect, it, vi } from "vitest";
import {
  SAFE_AREA_CONTROL_ID,
  createDefaultUserInterface,
  createWidget,
  defaultHitTestableFor,
  describeUiControls,
  guiSpecFromDescriptor,
  layoutUserInterface,
  pinLayout,
  scopeUiControlIds,
  stretchLayout,
  type UiControlDescriptor,
} from "@babylonslate/ui-runtime";
import { applyUiControls, RecordingUiHost } from "./ui-apply";
import { NullEngine, Scene, Vector2 } from "@babylonjs/core";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { Control as GuiControl } from "@babylonjs/gui/2D/controls/control";
import { Container } from "@babylonjs/gui/2D/controls/container";
import { Ellipse } from "@babylonjs/gui/2D/controls/ellipse";
import { Image } from "@babylonjs/gui/2D/controls/image";
import { Grid } from "@babylonjs/gui/2D/controls/grid";
import { ScrollViewer } from "@babylonjs/gui/2D/controls/scrollViewers/scrollViewer";
import { Slider } from "@babylonjs/gui/2D/controls/sliders/slider";
import { Checkbox } from "@babylonjs/gui/2D/controls/checkbox";
import { InputText } from "@babylonjs/gui/2D/controls/inputText";
import { StackPanel } from "@babylonjs/gui/2D/controls/stackPanel";
import { TextBlock } from "@babylonjs/gui/2D/controls/textBlock";
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
    hitTestable: defaultHitTestableFor(partial.kind),
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
  options: {
    safeArea?: { left: number; right: number; top: number; bottom: number };
    resolveNested?: (guid: string) => ReturnType<typeof createDefaultUserInterface> | null;
  } = {},
) {
  const root = new Container("adt-root");
  const factory = createAdtControlFactory(root, { safeArea: options.safeArea });
  const host = new BabylonUiApplyHost(factory, { interactive: false });
  applyUiControls(
    host,
    describeUiControls(doc, {
      parentSize: { width: 800, height: 600 },
      resolveNested: options.resolveNested,
    }),
  );
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

  it("sets isVisible from the widget visible flag, not alpha", () => {
    const hidden = createBabylonControl(
      guiSpecFromDescriptor(
        descriptor({
          id: "btn",
          kind: "Button",
          visible: false,
          style: { opacity: 1 },
        }),
        { interactive: false },
      ),
    );
    expect(hidden.isVisible).toBe(false);
    expect(hidden.alpha).toBe(1);
    hidden.dispose();
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

  it("paints Text and Button with a light color when the document omits color", () => {
    const text = createBabylonControl(
      guiSpecFromDescriptor(
        descriptor({ id: "label", kind: "TextBlock", text: "Score" }),
        { interactive: false },
      ),
    );
    expect(text.color.toLowerCase()).not.toBe("#000000");
    expect(text.color.toLowerCase()).not.toBe("black");
    expect(text.color).toBe("#ffffff");
    text.dispose();
    const button = createBabylonControl(
      guiSpecFromDescriptor(
        descriptor({ id: "btn", kind: "Button", text: "Play" }),
        { interactive: false },
      ),
    );
    expect(button.color).toBe("#ffffff");
    button.dispose();
  });

  it("does not fill TouchJoystick with opaque black", () => {
    const stick = createBabylonControl(
      guiSpecFromDescriptor(
        descriptor({
          id: "stick",
          kind: "TouchJoystick",
          layout: pinLayout("left", "bottom", 160, 160, 40, 0),
        }),
        { interactive: false },
      ),
    ) as Ellipse;
    expect(stick.background.toLowerCase()).not.toBe("#000000");
    expect(stick.background.toLowerCase()).not.toBe("black");
    stick.dispose();
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
    const column = createWidget("column", "StackPanel", "Col", stretchLayout());
    const label = createWidget("label", "TextBlock", "Label");
    const grid = createWidget("grid", "Grid", "Grid", stretchLayout());
    grid.props.columns = 2;
    grid.props.rows = 1;
    const cellA = createWidget("cellA", "Button", "A");
    const cellB = createWidget("cellB", "Button", "B");
    const scroll = createWidget("scroll", "ScrollViewer", "Scroll", stretchLayout());
    const inner = createWidget(
      "inner", "TextBlock",
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

  it("applies Grid gap as padding between Grid cells", () => {
    const doc = createDefaultUserInterface();
    const grid = createWidget("grid", "Grid", "Grid", stretchLayout());
    grid.props.gap = 12;
    const cellA = createWidget("cellA", "Button", "A");
    const cellB = createWidget("cellB", "Button", "B");
    const cellC = createWidget("cellC", "Button", "C");
    doc.widgets.canvas!.children = ["grid"];
    grid.children = ["cellA", "cellB", "cellC"];
    doc.widgets.grid = grid;
    doc.widgets.cellA = cellA;
    doc.widgets.cellB = cellB;
    doc.widgets.cellC = cellC;
    const { root } = applyDocument(doc);
    const gridControl = named(root, "grid") as Grid;
    const first = gridControl.cells["0:0"];
    const nextCol = gridControl.cells["0:1"];
    const nextRow = gridControl.cells["1:0"];
    expect(first?.paddingLeft).toBe("0px");
    expect(first?.paddingTop).toBe("0px");
    expect(nextCol?.paddingLeft).toBe("12px");
    expect(nextCol?.paddingTop).toBe("0px");
    expect(nextRow?.paddingLeft).toBe("0px");
    expect(nextRow?.paddingTop).toBe("12px");
  });

  it("rebuilds Grid track defs when column count grows", () => {
    const doc = createDefaultUserInterface();
    const grid = createWidget("grid", "Grid", "Grid", stretchLayout());
    doc.widgets.canvas!.children = ["grid"];
    doc.widgets.grid = grid;
    const root = new Container("adt-root");
    const factory = createAdtControlFactory(root);
    const host = new BabylonUiApplyHost(factory, { interactive: false });
    applyUiControls(
      host,
      describeUiControls(doc, { parentSize: { width: 800, height: 600 } }),
    );
    expect((named(root, "grid") as Grid).columnCount).toBe(2);
    grid.props.columns = 3;
    grid.props.gridColumns = [
      { value: 1, isPixel: false },
      { value: 1, isPixel: false },
      { value: 1, isPixel: false },
    ];
    applyUiControls(
      host,
      describeUiControls(doc, { parentSize: { width: 800, height: 600 } }),
    );
    expect((named(root, "grid") as Grid).columnCount).toBe(3);
  });

  it("keeps Grid cells when column count grows", () => {
    const doc = createDefaultUserInterface();
    const grid = createWidget("grid", "Grid", "Grid", stretchLayout());
    grid.props.columns = 2;
    grid.props.rows = 2;
    const cellA = createWidget("cellA", "Button", "A");
    const cellB = createWidget("cellB", "Button", "B");
    const cellC = createWidget("cellC", "Button", "C");
    doc.widgets.canvas!.children = ["grid"];
    grid.children = ["cellA", "cellB", "cellC"];
    doc.widgets.grid = grid;
    doc.widgets.cellA = cellA;
    doc.widgets.cellB = cellB;
    doc.widgets.cellC = cellC;
    const root = new Container("adt-root");
    const factory = createAdtControlFactory(root);
    const host = new BabylonUiApplyHost(factory, { interactive: false });
    applyUiControls(
      host,
      describeUiControls(doc, { parentSize: { width: 800, height: 600 } }),
    );
    const first = named(root, "grid") as Grid;
    expect(first.getChildrenAt(0, 0)?.some((row) => row.name === "cellA")).toBe(true);
    expect(first.getChildrenAt(0, 1)?.some((row) => row.name === "cellB")).toBe(true);
    expect(first.getChildrenAt(1, 0)?.some((row) => row.name === "cellC")).toBe(true);
    grid.props.columns = 3;
    grid.props.gridColumns = [
      { value: 1, isPixel: false },
      { value: 1, isPixel: false },
      { value: 1, isPixel: false },
    ];
    applyUiControls(
      host,
      describeUiControls(doc, { parentSize: { width: 800, height: 600 } }),
    );
    const live = named(root, "grid") as Grid;
    expect(live).toBe(first);
    expect(live.columnCount).toBe(3);
    expect(live.getChildrenAt(0, 0)?.some((row) => row.name === "cellA")).toBe(true);
    expect(live.getChildrenAt(0, 1)?.some((row) => row.name === "cellB")).toBe(true);
    expect(live.getChildrenAt(0, 2)?.some((row) => row.name === "cellC")).toBe(true);
  });

  it("keeps Grid cells when column count shrinks", () => {
    const doc = createDefaultUserInterface();
    const grid = createWidget("grid", "Grid", "Grid", stretchLayout());
    grid.props.columns = 3;
    grid.props.rows = 2;
    grid.props.gridColumns = [
      { value: 1, isPixel: false },
      { value: 1, isPixel: false },
      { value: 1, isPixel: false },
    ];
    const cellA = createWidget("cellA", "Button", "A");
    const cellB = createWidget("cellB", "Button", "B");
    const cellC = createWidget("cellC", "Button", "C");
    doc.widgets.canvas!.children = ["grid"];
    grid.children = ["cellA", "cellB", "cellC"];
    doc.widgets.grid = grid;
    doc.widgets.cellA = cellA;
    doc.widgets.cellB = cellB;
    doc.widgets.cellC = cellC;
    const root = new Container("adt-root");
    const factory = createAdtControlFactory(root);
    const host = new BabylonUiApplyHost(factory, { interactive: false });
    applyUiControls(
      host,
      describeUiControls(doc, { parentSize: { width: 800, height: 600 } }),
    );
    const first = named(root, "grid") as Grid;
    expect(first.getChildrenAt(0, 2)?.some((row) => row.name === "cellC")).toBe(true);
    grid.props.columns = 2;
    grid.props.gridColumns = [
      { value: 1, isPixel: false },
      { value: 1, isPixel: false },
    ];
    applyUiControls(
      host,
      describeUiControls(doc, { parentSize: { width: 800, height: 600 } }),
    );
    const live = named(root, "grid") as Grid;
    expect(live).toBe(first);
    expect(live.columnCount).toBe(2);
    expect(live.getChildrenAt(0, 0)?.some((row) => row.name === "cellA")).toBe(true);
    expect(live.getChildrenAt(0, 1)?.some((row) => row.name === "cellB")).toBe(true);
    expect(live.getChildrenAt(1, 0)?.some((row) => row.name === "cellC")).toBe(true);
  });

  it("updates Grid gap padding without recreating the Grid", () => {
    const doc = createDefaultUserInterface();
    const grid = createWidget("grid", "Grid", "Grid", stretchLayout());
    grid.props.gap = 12;
    const cellA = createWidget("cellA", "Button", "A");
    const cellB = createWidget("cellB", "Button", "B");
    doc.widgets.canvas!.children = ["grid"];
    grid.children = ["cellA", "cellB"];
    doc.widgets.grid = grid;
    doc.widgets.cellA = cellA;
    doc.widgets.cellB = cellB;
    const root = new Container("adt-root");
    const factory = createAdtControlFactory(root);
    const host = new BabylonUiApplyHost(factory, { interactive: false });
    applyUiControls(
      host,
      describeUiControls(doc, { parentSize: { width: 800, height: 600 } }),
    );
    const first = named(root, "grid") as Grid;
    expect(first.cells["0:1"]?.paddingLeft).toBe("12px");
    grid.props.gap = 24;
    applyUiControls(
      host,
      describeUiControls(doc, { parentSize: { width: 800, height: 600 } }),
    );
    const live = named(root, "grid") as Grid;
    expect(live).toBe(first);
    expect(live.columnCount).toBe(2);
    expect(live.cells["0:0"]?.paddingLeft).toBe("0px");
    expect(live.cells["0:1"]?.paddingLeft).toBe("24px");
    expect(live.getChildrenAt(0, 0)?.some((row) => row.name === "cellA")).toBe(true);
    expect(live.getChildrenAt(0, 1)?.some((row) => row.name === "cellB")).toBe(true);
  });

  it("parents default Canvas children into a padded SafeArea container", () => {
    const doc = createDefaultUserInterface();
    const pin = createWidget("pin", "Button", "Pin", pinLayout("left", "top", 80, 32));
    const bleed = createWidget(
      "bleed",
      "Rectangle",
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

  it("parents scoped HUD children into a per-instance SafeArea", () => {
    const doc = createDefaultUserInterface();
    const pin = createWidget("pin", "Button", "Pin", pinLayout("left", "top", 80, 32));
    doc.widgets.canvas!.children = ["pin"];
    doc.widgets.pin = pin;
    const root = new Container("adt-root");
    const factory = createAdtControlFactory(root, {
      safeArea: { left: 10, right: 0, top: 20, bottom: 0 },
    });
    const host = new BabylonUiApplyHost(factory, { interactive: false });
    applyUiControls(
      host,
      scopeUiControlIds(
        describeUiControls(doc, { parentSize: { width: 800, height: 600 } }),
        "ui-1",
      ),
    );
    const safe = named(root, `ui-1:${SAFE_AREA_CONTROL_ID}`);
    expect(safe).toBeInstanceOf(Container);
    expect(safe?.paddingTop).toBe("20px");
    expect(safe?.getDescendants(false).some((row) => row.name === "ui-1:pin")).toBe(
      true,
    );
    expect(root.children.some((row) => row.name === "ui-1:pin")).toBe(false);
  });

  it("gives stacked HUDs separate SafeArea containers", () => {
    const first = createDefaultUserInterface("A");
    const second = createDefaultUserInterface("B");
    const a = createWidget("a", "Button", "A", pinLayout("left", "top", 80, 32));
    const b = createWidget("b", "Button", "B", pinLayout("left", "top", 80, 32));
    first.widgets.canvas!.children = ["a"];
    first.widgets.a = a;
    second.widgets.canvas!.children = ["b"];
    second.widgets.b = b;
    const root = new Container("adt-root");
    const factory = createAdtControlFactory(root, {
      safeArea: { left: 8, right: 8, top: 16, bottom: 16 },
    });
    const host = new BabylonUiApplyHost(factory, { interactive: false });
    applyUiControls(host, [
      ...scopeUiControlIds(
        describeUiControls(first, { parentSize: { width: 800, height: 600 } }),
        "ui-1",
      ),
      ...scopeUiControlIds(
        describeUiControls(second, { parentSize: { width: 800, height: 600 } }),
        "ui-2",
      ),
    ]);
    const safe1 = named(root, `ui-1:${SAFE_AREA_CONTROL_ID}`);
    const safe2 = named(root, `ui-2:${SAFE_AREA_CONTROL_ID}`);
    expect(safe1).toBeInstanceOf(Container);
    expect(safe2).toBeInstanceOf(Container);
    expect(safe1).not.toBe(safe2);
    expect(safe1?.getDescendants(false).some((row) => row.name === "ui-1:a")).toBe(
      true,
    );
    expect(safe2?.getDescendants(false).some((row) => row.name === "ui-2:b")).toBe(
      true,
    );
  });

  it("parents a nested UserInterface label under the host slot, not the ADT root", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const chip = createDefaultUserInterface("Chip");
    const label = createWidget(
      "label", "TextBlock",
      "HP",
      pinLayout("left", "top", 80, 20),
    );
    label.props.text = "HP";
    chip.widgets.canvas!.children = ["label"];
    chip.widgets.label = label;

    const hud = createDefaultUserInterface("HUD");
    const host = createWidget(
      "chip",
      "UserInterface",
      "Chip",
      pinLayout("left", "top", 80, 20, 0, 0),
    );
    host.nestedUiGuid = "chip-guid";
    hud.widgets.canvas!.children = ["chip"];
    hud.widgets.chip = host;

    const root = new Container("adt-root");
    const factory = createAdtControlFactory(root);
    const applyHost = new BabylonUiApplyHost(factory, { interactive: false });
    applyUiControls(
      applyHost,
      describeUiControls(hud, {
        parentSize: { width: 800, height: 600 },
        resolveNested: (guid) => (guid === "chip-guid" ? chip : null),
      }),
    );

    const nestedLabel = named(root, "chip/label");
    expect(nestedLabel).toBeInstanceOf(TextBlock);
    expect((nestedLabel as TextBlock).text).toBe("HP");
    expect(nestedLabel?.parent?.name).toBe("chip");
    expect(nestedLabel?.parent?.name).not.toBe("chip/canvas");
    expect(nestedLabel?.parent?.name).not.toBe("adt-root");
    expect(named(root, "chip")?.getDescendants(false).some((row) => row.name === "chip/label")).toBe(
      true,
    );
    applyHost.clear();
    scene.dispose();
    engine.dispose();
  });

  it("queues reconcile while a designer gesture is locked", () => {
    const factory = new RecordingFactory();
    const host = new BabylonUiApplyHost(factory, { interactive: false });
    const first = descriptor({ id: "btn", kind: "Button" });
    host.reconcile([first]);
    expect(factory.created).toHaveLength(1);
    host.setGestureLocked(true);
    host.reconcile([first, descriptor({ id: "other", kind: "TextBlock" })]);
    expect(factory.created).toHaveLength(1);
    host.setGestureLocked(false);
    expect(factory.created.some((row) => row.id === "other")).toBe(true);
  });

  it("patches live left/top during a gesture without recreating the control", () => {
    const factory = new RecordingFactory();
    const host = new BabylonUiApplyHost(factory, { interactive: false });
    const control = { left: "0px", top: "0px", width: "80px", height: "32px" };
    factory.create = (spec) => {
      const handle = {
        id: spec.id,
        type: spec.type,
        spec,
        control: control as never,
        dispose() {},
      };
      factory.created.push(handle);
      return handle;
    };
    host.addControl(descriptor({ id: "btn", kind: "Button" }));
    host.patchLiveLayout("btn", { ...pinLayout("left", "top", 80, 32), left: 12, top: 24 });
    expect(control.left).toBe("12px");
    expect(control.top).toBe("24px");
    expect(factory.created).toHaveLength(1);
  });

  it("patches live padding and alignment during a stretch resize", () => {
    const factory = new RecordingFactory();
    const host = new BabylonUiApplyHost(factory, { interactive: false });
    const control = {
      left: "0px",
      top: "0px",
      width: "100%",
      height: "100%",
      paddingLeft: "0px",
      paddingRight: "0px",
      paddingTop: "0px",
      paddingBottom: "0px",
      horizontalAlignment: 0,
      verticalAlignment: 0,
    };
    factory.create = (spec) => {
      const handle = {
        id: spec.id,
        type: spec.type,
        spec,
        control: control as never,
        dispose() {},
      };
      factory.created.push(handle);
      return handle;
    };
    host.addControl(descriptor({ id: "btn", kind: "Button" }));
    host.patchLiveLayout(
      "btn",
      stretchLayout({ left: 16, right: 24, top: 8, bottom: 12 }),
    );
    expect(control.width).toBe("100%");
    expect(control.paddingLeft).toBe("16px");
    expect(control.paddingRight).toBe("24px");
    expect(control.paddingTop).toBe("8px");
    expect(control.paddingBottom).toBe("12px");
    expect(control.horizontalAlignment).toBe(GuiControl.HORIZONTAL_ALIGNMENT_LEFT);
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
      "TextBlock",
      "InputText",
      "Slider",
      "Checkbox",
      "ProgressBar",
      "StackPanel",
      "Grid",
      "ScrollViewer",
      "Container",
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

  it("disposes each ADT control once when the host clears", () => {
    const doc = createDefaultUserInterface();
    const { root, host } = applyDocument(doc);
    const canvas = named(root, "canvas");
    expect(canvas).toBeTruthy();
    const dispose = vi.spyOn(canvas!, "dispose");
    host.clear();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("removes stale controls through the factory without also disposing the handle", () => {
    const dispose = vi.fn();
    const remove = vi.fn();
    const factory: GuiControlFactory = {
      create(spec) {
        return { id: spec.id, type: spec.type, spec, dispose };
      },
      clear() {},
      remove,
      update: () => true,
    };
    const host = new BabylonUiApplyHost(factory, { interactive: false });
    const keep = descriptor({ id: "keep", kind: "Button" });
    const drop = descriptor({ id: "drop", kind: "Button" });
    host.reconcile([keep, drop]);
    host.reconcile([keep]);
    expect(remove).toHaveBeenCalledWith("drop");
    expect(dispose).not.toHaveBeenCalled();
  });

  it("reuses unchanged Babylon controls on a second apply", () => {
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
    const { root, host } = applyDocument(doc);
    const first = named(root, "btn");
    expect(first).toBeTruthy();
    const layout = layoutUserInterface(doc, { width: 800, height: 600 });
    applyUiControls(host, describeUiControls(doc, layout));
    expect(named(root, "btn")).toBe(first);
  });

  it("emits click, value, checked, and text widget events", () => {
    const onWidgetEvent = vi.fn();
    const buttonDesc = descriptor({
      id: "btn",
      kind: "Button",
      text: "Play",
    });
    const sliderDesc = descriptor({
      id: "slider",
      kind: "Slider",
      hitTestable: true,
      props: { value: 0.2, min: 0, max: 1 },
    });
    const checkDesc = descriptor({
      id: "check",
      kind: "Checkbox",
      hitTestable: true,
      props: { checked: false },
    });
    const inputDesc = descriptor({
      id: "input",
      kind: "InputText",
      hitTestable: true,
      props: { text: "" },
    });
    const button = createBabylonControl(
      guiSpecFromDescriptor(buttonDesc, { interactive: true }),
    );
    const slider = createBabylonControl(
      guiSpecFromDescriptor(sliderDesc, { interactive: true }),
    ) as Slider;
    const box = createBabylonControl(
      guiSpecFromDescriptor(checkDesc, { interactive: true }),
    ) as Checkbox;
    const input = createBabylonControl(
      guiSpecFromDescriptor(inputDesc, { interactive: true }),
    ) as InputText;
    const byId = new Map<string, ReturnType<typeof createBabylonControl>>([
      ["btn", button],
      ["slider", slider],
      ["check", box],
      ["input", input],
    ]);
    const factory: GuiControlFactory = {
      create(spec) {
        const control = byId.get(spec.id);
        return {
          id: spec.id,
          type: spec.type,
          spec,
          control,
          dispose() {},
        };
      },
      clear() {},
    };
    const host = new BabylonUiApplyHost(factory, {
      interactive: true,
      onWidgetEvent,
    });
    host.addControl(buttonDesc);
    host.addControl(sliderDesc);
    host.addControl(checkDesc);
    host.addControl(inputDesc);
    button.onPointerClickObservable.notifyObservers(
      new Vector2WithInfo(new Vector2(0, 0)),
    );
    slider.value = 0.75;
    box.onIsCheckedChangedObservable.notifyObservers(true);
    input.onTextChangedObservable.notifyObservers(input);
    expect(onWidgetEvent).toHaveBeenCalledWith({
      kind: "click",
      widgetId: "btn",
    });
    expect(onWidgetEvent).toHaveBeenCalledWith({
      kind: "value",
      widgetId: "slider",
      value: 0.75,
    });
    expect(onWidgetEvent).toHaveBeenCalledWith({
      kind: "checked",
      widgetId: "check",
      value: true,
    });
    expect(onWidgetEvent).toHaveBeenCalledWith({
      kind: "text",
      widgetId: "input",
      value: expect.any(String),
    });
    host.clear();
    button.dispose();
    slider.dispose();
    box.dispose();
    input.dispose();
  });

  it("emits mouse enter, exit, press, and release on interactive buttons", () => {
    const onWidgetEvent = vi.fn();
    const buttonDesc = descriptor({
      id: "btn",
      kind: "Button",
      text: "Play",
    });
    const button = createBabylonControl(
      guiSpecFromDescriptor(buttonDesc, { interactive: true }),
    );
    const factory: GuiControlFactory = {
      create(spec) {
        return {
          id: "btn",
          type: spec.type,
          spec: guiSpecFromDescriptor(buttonDesc, { interactive: true }),
          control: button,
          dispose() {},
        };
      },
      clear() {},
    };
    const host = new BabylonUiApplyHost(factory, {
      interactive: true,
      onWidgetEvent,
    });
    host.addControl(buttonDesc);
    const info = new Vector2WithInfo(new Vector2(0, 0));
    button.onPointerEnterObservable.notifyObservers(button);
    button.onPointerOutObservable.notifyObservers(button);
    button.onPointerDownObservable.notifyObservers(info);
    button.onPointerUpObservable.notifyObservers(info);
    expect(onWidgetEvent).toHaveBeenCalledWith({
      kind: "pointerEnter",
      widgetId: "btn",
    });
    expect(onWidgetEvent).toHaveBeenCalledWith({
      kind: "pointerExit",
      widgetId: "btn",
    });
    expect(onWidgetEvent).toHaveBeenCalledWith({
      kind: "pointerDown",
      widgetId: "btn",
    });
    expect(onWidgetEvent).toHaveBeenCalledWith({
      kind: "pointerUp",
      widgetId: "btn",
    });
    host.clear();
    button.dispose();
  });

  it("does not emit pointer events from the Canvas root", () => {
    const onWidgetEvent = vi.fn();
    const canvasDesc = descriptor({
      id: "canvas",
      kind: "Canvas",
    });
    const canvas = createBabylonControl(
      guiSpecFromDescriptor(canvasDesc, { interactive: true }),
    );
    const factory: GuiControlFactory = {
      create(spec) {
        return {
          id: "canvas",
          type: spec.type,
          spec: guiSpecFromDescriptor(canvasDesc, { interactive: true }),
          control: canvas,
          dispose() {},
        };
      },
      clear() {},
    };
    const host = new BabylonUiApplyHost(factory, {
      interactive: true,
      onWidgetEvent,
    });
    host.addControl(canvasDesc);
    canvas.onPointerDownObservable.notifyObservers(
      new Vector2WithInfo(new Vector2(0, 0)),
    );
    expect(onWidgetEvent).not.toHaveBeenCalled();
    host.clear();
    canvas.dispose();
  });

  it("does not emit pointer events when Hit Testable is Disabled", () => {
    const onWidgetEvent = vi.fn();
    const artDesc = descriptor({
      id: "art",
      kind: "Image",
    });
    const art = createBabylonControl(
      guiSpecFromDescriptor(artDesc, { interactive: true }),
    );
    const factory: GuiControlFactory = {
      create(spec) {
        return {
          id: "art",
          type: spec.type,
          spec,
          control: art,
          dispose() {},
        };
      },
      clear() {},
    };
    const host = new BabylonUiApplyHost(factory, {
      interactive: true,
      onWidgetEvent,
    });
    host.addControl(artDesc);
    art.onPointerDownObservable.notifyObservers(
      new Vector2WithInfo(new Vector2(0, 0)),
    );
    expect(onWidgetEvent).not.toHaveBeenCalled();
    expect(art.isHitTestVisible).toBe(false);
    expect(art.isPointerBlocker).toBe(false);
    host.clear();
    art.dispose();
  });

  it("lets a Button receive hits through an overlapping Image that defaults off", () => {
    const { root, host } = applyInteractiveOverlap("btn", "art", false);
    const button = named(root, "btn")!;
    const image = named(root, "art")!;
    expect(image.isHitTestVisible).toBe(false);
    expect(image.isPointerBlocker).toBe(false);
    expect(button.isHitTestVisible).toBe(true);
    expect(button.isPointerBlocker).toBe(true);
    expect(siblingIndex(root, "art")).toBeGreaterThan(siblingIndex(root, "btn"));
    host.clear();
  });

  it("blocks a Button when an overlapping Image is Hit Testable", () => {
    const { root, host } = applyInteractiveOverlap("btn", "art", true);
    const image = named(root, "art")!;
    expect(image.isHitTestVisible).toBe(true);
    expect(image.isPointerBlocker).toBe(true);
    expect(siblingIndex(root, "art")).toBeGreaterThan(siblingIndex(root, "btn"));
    host.clear();
  });

  it("picks the later overlapping Button", () => {
    const doc = createDefaultUserInterface();
    const first = createWidget(
      "btn-1",
      "Button",
      "First",
      pinLayout("left", "top", 160, 40, 0, 0),
    );
    const second = createWidget(
      "btn-2",
      "Button",
      "Second",
      pinLayout("left", "top", 160, 40, 0, 0),
    );
    doc.widgets.canvas!.children = ["btn-1", "btn-2"];
    doc.widgets["btn-1"] = first;
    doc.widgets["btn-2"] = second;
    const root = new Container("adt-root");
    const factory = createAdtControlFactory(root);
    const host = new BabylonUiApplyHost(factory, { interactive: true });
    applyUiControls(
      host,
      describeUiControls(doc, layoutUserInterface(doc, { width: 800, height: 600 })),
    );
    const later = named(root, "btn-2")!;
    expect(later.isHitTestVisible).toBe(true);
    expect(later.isPointerBlocker).toBe(true);
    expect(siblingIndex(root, "btn-2")).toBeGreaterThan(siblingIndex(root, "btn-1"));
    host.clear();
  });

  it("does not let a full-screen Canvas eat hits in Play", () => {
    const doc = createDefaultUserInterface();
    const root = new Container("adt-root");
    const factory = createAdtControlFactory(root);
    const host = new BabylonUiApplyHost(factory, { interactive: true });
    applyUiControls(
      host,
      describeUiControls(doc, layoutUserInterface(doc, { width: 800, height: 600 })),
    );
    const canvas = named(root, "canvas")!;
    expect(canvas.isHitTestVisible).toBe(false);
    expect(canvas.isPointerBlocker).toBe(false);
    host.clear();
  });

  it("clears Button hit flags when GUI hits are disabled", () => {
    const doc = createDefaultUserInterface();
    const button = createWidget(
      "btn",
      "Button",
      "Play",
      pinLayout("left", "top", 160, 40, 0, 0),
    );
    doc.widgets.canvas!.children = ["btn"];
    doc.widgets.btn = button;
    const root = new Container("adt-root");
    const factory = createAdtControlFactory(root);
    const host = new BabylonUiApplyHost(factory, { interactive: true });
    applyUiControls(
      host,
      describeUiControls(doc, layoutUserInterface(doc, { width: 800, height: 600 })),
    );
    expect(named(root, "btn")!.isHitTestVisible).toBe(true);
    host.setAllowGuiHits(false);
    expect(named(root, "btn")!.isHitTestVisible).toBe(false);
    expect(named(root, "btn")!.isPointerBlocker).toBe(false);
    host.clear();
  });
});

function applyInteractiveOverlap(
  buttonId: string,
  imageId: string,
  imageHitTestable: boolean,
) {
  const doc = createDefaultUserInterface();
  const button = createWidget(
    buttonId,
    "Button",
    "Play",
    pinLayout("left", "top", 160, 40, 0, 0),
  );
  const art = createWidget(
    imageId,
    "Image",
    "Logo",
    pinLayout("left", "top", 160, 40, 0, 0),
  );
  art.hitTestable = imageHitTestable;
  doc.widgets.canvas!.children = [buttonId, imageId];
  doc.widgets[buttonId] = button;
  doc.widgets[imageId] = art;
  const root = new Container("adt-root");
  const factory = createAdtControlFactory(root);
  const host = new BabylonUiApplyHost(factory, { interactive: true });
  applyUiControls(
    host,
    describeUiControls(doc, layoutUserInterface(doc, { width: 800, height: 600 })),
  );
  return { root, host };
}

function siblingIndex(root: Container, id: string): number {
  const control = named(root, id);
  expect(control?.parent).toBeTruthy();
  const parent = control!.parent as Container;
  return parent.children.indexOf(control!);
}

describe("Babylon GUI Image widgets", () => {
  it("sets Image.source from resolveImageUrl", () => {
    const doc = createDefaultUserInterface();
    const image = createWidget("img", "Image", "Logo", pinLayout("left", "top", 64, 64));
    image.props.imageGuid = "tex-1";
    doc.widgets.canvas!.children = ["img"];
    doc.widgets.img = image;
    const root = new Container("adt-root");
    const factory = createAdtControlFactory(root, {
      resolveImageUrl: (guid) => (guid === "tex-1" ? "blob:tex-1" : null),
    });
    const host = new BabylonUiApplyHost(factory, { interactive: false });
    const layout = layoutUserInterface(doc, { width: 800, height: 600 });
    applyUiControls(host, describeUiControls(doc, layout));
    const control = named(root, "img");
    expect(control).toBeInstanceOf(Image);
    expect((control as Image).source).toBe("blob:tex-1");
    host.clear();
  });

  it("updates Image.source in place when imageGuid changes", () => {
    const doc = createDefaultUserInterface();
    const image = createWidget("img", "Image", "Logo", pinLayout("left", "top", 64, 64));
    image.props.imageGuid = "tex-1";
    doc.widgets.canvas!.children = ["img"];
    doc.widgets.img = image;
    const urls: Record<string, string> = {
      "tex-1": "blob:tex-1",
      "tex-2": "blob:tex-2",
    };
    const root = new Container("adt-root");
    const factory = createAdtControlFactory(root, {
      resolveImageUrl: (guid) => urls[guid] ?? null,
    });
    const host = new BabylonUiApplyHost(factory, { interactive: false });
    const layout = layoutUserInterface(doc, { width: 800, height: 600 });
    applyUiControls(host, describeUiControls(doc, layout));
    image.props.imageGuid = "tex-2";
    applyUiControls(host, describeUiControls(doc, layout));
    const control = named(root, "img") as Image;
    expect(control.source).toBe("blob:tex-2");
    host.clear();
  });

  it("does not reassign Image.source when the blob URL is unchanged", () => {
    const doc = createDefaultUserInterface();
    const image = createWidget("img", "Image", "Logo", pinLayout("left", "top", 64, 64));
    image.props.imageGuid = "tex-1";
    doc.widgets.canvas!.children = ["img"];
    doc.widgets.img = image;
    const root = new Container("adt-root");
    const factory = createAdtControlFactory(root, {
      resolveImageUrl: () => "blob:tex-1",
    });
    const host = new BabylonUiApplyHost(factory, { interactive: false });
    const layout = layoutUserInterface(doc, { width: 800, height: 600 });
    applyUiControls(host, describeUiControls(doc, layout));
    const control = named(root, "img") as Image;
    const proto = Object.getPrototypeOf(control) as Image;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "source");
    expect(descriptor?.set).toBeTypeOf("function");
    const assigned: string[] = [];
    Object.defineProperty(proto, "source", {
      configurable: true,
      get: descriptor!.get,
      set(this: Image, value: string) {
        assigned.push(value);
        descriptor!.set!.call(this, value);
      },
    });
    try {
      applyUiControls(host, describeUiControls(doc, layout));
      expect(assigned).toEqual([]);
      expect(control.source).toBe("blob:tex-1");
    } finally {
      Object.defineProperty(proto, "source", descriptor!);
    }
    host.clear();
  });

  it("calls onImageReady when Image.onImageLoadedObservable fires", () => {
    const onImageReady = vi.fn();
    const doc = createDefaultUserInterface();
    const image = createWidget("img", "Image", "Logo", pinLayout("left", "top", 64, 64));
    image.props.imageGuid = "tex-1";
    doc.widgets.canvas!.children = ["img"];
    doc.widgets.img = image;
    const root = new Container("adt-root");
    const factory = createAdtControlFactory(root, {
      resolveImageUrl: () => "blob:tex-1",
      onImageReady,
    });
    const host = new BabylonUiApplyHost(factory, { interactive: false });
    const layout = layoutUserInterface(doc, { width: 800, height: 600 });
    applyUiControls(host, describeUiControls(doc, layout));
    const control = named(root, "img") as Image;
    expect(onImageReady).not.toHaveBeenCalled();
    control.onImageLoadedObservable.notifyObservers(control);
    expect(onImageReady).toHaveBeenCalledTimes(1);
    host.clear();
  });

  it("drops the load observer on source replace, remove, and clear", () => {
    const onImageReady = vi.fn();
    const doc = createDefaultUserInterface();
    const image = createWidget("img", "Image", "Logo", pinLayout("left", "top", 64, 64));
    image.props.imageGuid = "tex-1";
    doc.widgets.canvas!.children = ["img"];
    doc.widgets.img = image;
    const urls: Record<string, string> = {
      "tex-1": "blob:tex-1",
      "tex-2": "blob:tex-2",
    };
    const root = new Container("adt-root");
    const factory = createAdtControlFactory(root, {
      resolveImageUrl: (guid) => urls[guid] ?? null,
      onImageReady,
    });
    const host = new BabylonUiApplyHost(factory, { interactive: false });
    const layout = layoutUserInterface(doc, { width: 800, height: 600 });
    applyUiControls(host, describeUiControls(doc, layout));
    const first = named(root, "img") as Image;
    const firstHasObservers = () => first.onImageLoadedObservable.hasObservers();
    expect(firstHasObservers()).toBe(true);

    image.props.imageGuid = "tex-2";
    applyUiControls(host, describeUiControls(doc, layout));
    const second = named(root, "img") as Image;
    expect(second).toBe(first);
    first.onImageLoadedObservable.notifyObservers(first);
    expect(onImageReady).toHaveBeenCalledTimes(1);

    factory.remove?.("img");
    onImageReady.mockClear();
    first.onImageLoadedObservable.notifyObservers(first);
    expect(onImageReady).not.toHaveBeenCalled();
    expect(firstHasObservers()).toBe(false);

    applyUiControls(host, describeUiControls(doc, layout));
    const recreated = named(root, "img") as Image;
    expect(recreated.onImageLoadedObservable.hasObservers()).toBe(true);
    host.clear();
    recreated.onImageLoadedObservable.notifyObservers(recreated);
    expect(onImageReady).not.toHaveBeenCalled();
    expect(recreated.onImageLoadedObservable.hasObservers()).toBe(false);
  });
});

describe("Babylon GUI Material widgets", () => {
  it("binds an Interface material blit canvas onto the Image", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const doc = createDefaultUserInterface();
    const panel = createWidget(
      "fx",
      "Material",
      "Glow",
      pinLayout("left", "top", 64, 32),
    );
    panel.props.materialGuid = "mat-glow";
    doc.widgets.canvas!.children = ["fx"];
    doc.widgets.fx = panel;
    const root = new Container("adt-root");
    const factory = createAdtControlFactory(root, {
      scene,
      resolveInterfaceMaterial: (guid) =>
        guid === "mat-glow"
          ? createDefaultMaterialDocument("Glow", "interface")
          : null,
    });
    const host = new BabylonUiApplyHost(factory, { interactive: false });
    applyUiControls(
      host,
      describeUiControls(doc, layoutUserInterface(doc, { width: 800, height: 600 })),
    );
    const control = named(root, "fx");
    expect(control).toBeInstanceOf(Image);
    const blit = (control as Image).domImage as unknown as {
      width: number;
      height: number;
    };
    expect(blit.width).toBe(64);
    expect(blit.height).toBe(32);
    host.clear();
    scene.dispose();
    engine.dispose();
  });

  it("rebuilds the presenter when materialGuid changes", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const doc = createDefaultUserInterface();
    const panel = createWidget(
      "fx",
      "Material",
      "Glow",
      pinLayout("left", "top", 32, 32),
    );
    panel.props.materialGuid = "mat-a";
    doc.widgets.canvas!.children = ["fx"];
    doc.widgets.fx = panel;
    const materials: Record<string, ReturnType<typeof createDefaultMaterialDocument>> = {
      "mat-a": createDefaultMaterialDocument("A", "interface"),
      "mat-b": createDefaultMaterialDocument("B", "interface"),
    };
    const root = new Container("adt-root");
    const factory = createAdtControlFactory(root, {
      scene,
      resolveInterfaceMaterial: (guid) => materials[guid] ?? null,
    });
    const host = new BabylonUiApplyHost(factory, { interactive: false });
    const layout = layoutUserInterface(doc, { width: 800, height: 600 });
    applyUiControls(host, describeUiControls(doc, layout));
    const first = (named(root, "fx") as Image).domImage;
    panel.props.materialGuid = "mat-b";
    applyUiControls(host, describeUiControls(doc, layout));
    const second = (named(root, "fx") as Image).domImage;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    host.clear();
    scene.dispose();
    engine.dispose();
  });
});
