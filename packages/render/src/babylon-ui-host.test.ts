import { describe, expect, it, vi } from "vitest";
import {
  createDefaultUserInterface,
  createWidget,
  describeUiControls,
  guiSpecFromDescriptor,
  layoutUserInterface,
  pinLayout,
} from "@babylonslate/ui-runtime";
import { applyUiControls, RecordingUiHost } from "./ui-apply";
import { Vector2 } from "@babylonjs/core/Maths/math.vector";
import { Vector2WithInfo } from "@babylonjs/gui/2D/math2D";
import {
  BabylonUiApplyHost,
  applyAdtIdeal,
  bindDescriptorTouchInput,
  createBabylonControl,
  createDesignerGizmoControls,
  type GuiControlHandle,
  type GuiControlFactory,
} from "./babylon-ui-host";

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

describe("BabylonUiApplyHost", () => {
  it("creates one Babylon control spec per laid-out widget", () => {
    const doc = createDefaultUserInterface();
    const button = createWidget(
      "btn",
      "Button",
      "Play",
      pinLayout({ x: 0.5, y: 0.5 }, { x: 160, y: 40 }),
    );
    button.props.text = "Play";
    doc.widgets.canvas!.children = ["btn"];
    doc.widgets.btn = button;
    const layout = layoutUserInterface(doc, { width: 800, height: 600 });
    const controls = describeUiControls(doc, layout, 600);
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
    applyUiControls(host, describeUiControls(doc, layout, 300));
    expect(host.controls.length).toBeGreaterThan(0);
  });

  it("constructs a Babylon Button from a spec without an ADT", () => {
    const spec = guiSpecFromDescriptor(
      {
        id: "btn",
        kind: "Button",
        name: "Play",
        guiRect: { x: 10, y: 20, width: 80, height: 32 },
        visible: true,
        text: "Play",
        style: {},
        props: {},
      },
      { interactive: false },
    );
    const control = createBabylonControl(spec);
    expect(control.name).toBe("btn");
    control.dispose();
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
    const descriptor = {
      id: "stick",
      kind: "TouchJoystick" as const,
      name: "Move",
      guiRect: { x: 0, y: 0, width: 160, height: 160 },
      visible: true,
      style: {},
      props: { deadZone: 0.15, controlIdX: "joystick-x", controlIdY: "joystick-y" },
    };
    const spec = guiSpecFromDescriptor(descriptor, { interactive: true });
    const control = createBabylonControl(spec);
    bindDescriptorTouchInput(control, descriptor, onTouchAxis);
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
      "Image",
      "ProgressBar",
      "HorizontalBox",
      "Grid",
      "ScrollBox",
      "Spacer",
      "TouchDPad",
    ] as const;
    for (const kind of kinds) {
      const spec = guiSpecFromDescriptor(
        {
          id: kind,
          kind,
          name: kind,
          guiRect: { x: 0, y: 0, width: 40, height: 20 },
          visible: true,
          style: { background: "#111111" },
          props: { value: 0.25, checked: true },
        },
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
      anchors: [{ x: 10, y: 20 }],
    });
    expect(controls.map((row) => row.name)).toEqual([
      "gizmo:safe",
      "gizmo:selection",
      "gizmo:handle:se",
      "gizmo:pivot",
      "gizmo:anchor:0",
    ]);
    for (const control of controls) control.dispose();
  });

  it("emits a TouchButton action and a Slider value from pointer observables", () => {
    const onTouchAxis = vi.fn();
    const button = createBabylonControl(
      guiSpecFromDescriptor(
        {
          id: "jump",
          kind: "TouchButton",
          name: "Jump",
          guiRect: { x: 0, y: 0, width: 72, height: 72 },
          visible: true,
          style: {},
          props: { action: "Jump" },
        },
        { interactive: true },
      ),
    );
    bindDescriptorTouchInput(
      button,
      {
        id: "jump",
        kind: "TouchButton",
        name: "Jump",
        guiRect: { x: 0, y: 0, width: 72, height: 72 },
        visible: true,
        style: {},
        props: { action: "Jump" },
      },
      onTouchAxis,
    );
    button.onPointerDownObservable.notifyObservers(
      new Vector2WithInfo(new Vector2(0, 0)),
    );
    expect(onTouchAxis).toHaveBeenCalledWith("Jump", 1);
    button.dispose();

    const slider = createBabylonControl(
      guiSpecFromDescriptor(
        {
          id: "slider",
          kind: "Slider",
          name: "Slider",
          guiRect: { x: 0, y: 0, width: 100, height: 20 },
          visible: true,
          style: {},
          props: { controlId: "look" },
        },
        { interactive: true },
      ),
    );
    bindDescriptorTouchInput(
      slider,
      {
        id: "slider",
        kind: "Slider",
        name: "Slider",
        guiRect: { x: 0, y: 0, width: 100, height: 20 },
        visible: true,
        style: {},
        props: { controlId: "look" },
      },
      onTouchAxis,
    );
    slider.onPointerDownObservable.notifyObservers(
      new Vector2WithInfo(new Vector2(100, 0)),
    );
    expect(onTouchAxis).toHaveBeenCalledWith("look", 1);
    slider.dispose();
  });

  it("binds touch input when the factory returns a live control", () => {
    const onTouchAxis = vi.fn();
    const descriptor = {
      id: "stick",
      kind: "TouchJoystick" as const,
      name: "Move",
      guiRect: { x: 0, y: 0, width: 160, height: 160 },
      visible: true,
      style: {},
      props: { deadZone: 0.15, controlIdX: "joystick-x", controlIdY: "joystick-y" },
    };
    const control = createBabylonControl(
      guiSpecFromDescriptor(descriptor, { interactive: true }),
    );
    const factory: GuiControlFactory = {
      create(spec) {
        return { id: spec.id, type: spec.type, spec, control, dispose() {} };
      },
      clear() {},
    };
    const host = new BabylonUiApplyHost(factory, { interactive: true, onTouchAxis });
    host.addControl(descriptor);
    control.onPointerDownObservable.notifyObservers(
      new Vector2WithInfo(new Vector2(160, 80)),
    );
    expect(onTouchAxis).toHaveBeenCalledWith("joystick-x", expect.closeTo(1, 5));
    host.clear();
    control.dispose();
  });
});
