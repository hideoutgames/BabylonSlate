import { describe, expect, it } from "vitest";
import {
  createDefaultUserInterface,
  createWidget,
  describeUiControls,
  layoutUserInterface,
  pinLayout,
} from "@babylonslate/ui-runtime";
import {
  applyUiControls,
  applyUiControlsIfUnfrozen,
  applyWidgetVisible,
  joystickAxesFromLocal,
  joystickAxisValue,
  RecordingUiHost,
  resetUiHostStats,
  uiHostStats,
} from "./ui-apply";

describe("UI apply", () => {
  it("pushes laid-out controls to the host and can hide a widget", () => {
    const doc = createDefaultUserInterface();
    const stick = createWidget(
      "stick",
      "TouchJoystick",
      "Move Stick",
      pinLayout("left", "bottom", 160, 160, 40, 0),
    );
    doc.widgets.canvas!.children = ["stick"];
    doc.widgets.stick = stick;
    const layout = layoutUserInterface(doc, { width: 1920, height: 1080 });
    const controls = describeUiControls(doc, layout);
    const host = new RecordingUiHost();
    applyUiControls(host, controls);
    expect(host.controls.some((row) => row.kind === "TouchJoystick")).toBe(true);
    applyWidgetVisible(host, "stick", false);
    expect(host.visibility.get("stick")).toBe(false);
    expect(host.dirtyCount).toBeGreaterThan(0);
  });

  it("applies the same dead zone the input resolver uses", () => {
    expect(joystickAxisValue(0.1, 0.15)).toBe(0);
    expect(joystickAxisValue(1, 0.15)).toBeCloseTo(1, 5);
    expect(joystickAxisValue(-0.575, 0.15)).toBeCloseTo(-0.5, 5);
  });

  it("maps a local pointer on a stick into dead-zoned axes", () => {
    expect(joystickAxesFromLocal(80, 80, 160, 160, 0.15)).toEqual({ x: 0, y: 0 });
    const right = joystickAxesFromLocal(160, 80, 160, 160, 0.15);
    expect(right.x).toBeCloseTo(1, 5);
    expect(right.y).toBe(0);
  });

  it("skips apply work while the surface is frozen", () => {
    const host = new RecordingUiHost();
    const doc = createDefaultUserInterface();
    const layout = layoutUserInterface(doc, { width: 400, height: 300 });
    const controls = describeUiControls(doc, layout);
    applyUiControlsIfUnfrozen(true, host, controls);
    expect(host.controls).toEqual([]);
    expect(host.dirtyCount).toBe(0);
    applyUiControlsIfUnfrozen(false, host, controls);
    expect(host.controls.length).toBeGreaterThan(0);
  });

  it("counts applies for regression fixtures", () => {
    resetUiHostStats();
    const host = new RecordingUiHost();
    const doc = createDefaultUserInterface();
    const layout = layoutUserInterface(doc, { width: 400, height: 300 });
    applyUiControls(host, describeUiControls(doc, layout));
    expect(uiHostStats.apply).toBe(1);
  });
});
