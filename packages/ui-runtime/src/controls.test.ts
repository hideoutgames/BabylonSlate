import { describe, expect, it } from "vitest";
import {
  SAFE_AREA_CONTROL_ID,
  createDefaultUserInterface,
  createWidget,
  describeUiControls,
  layoutUserInterface,
  pinLayout,
} from "./index";

describe("describeUiControls", () => {
  it("keeps GUI top-left coordinates and parents children", () => {
    const doc = createDefaultUserInterface();
    const button = createWidget(
      "play",
      "Button",
      "Play",
      pinLayout("left", "bottom", 80, 32, 0, 0),
    );
    button.props.text = "Play";
    doc.widgets.canvas!.children = ["play"];
    doc.widgets.play = button;
    const layout = layoutUserInterface(doc, { width: 1920, height: 1080 });
    const controls = describeUiControls(doc, layout);
    const play = controls.find((row) => row.id === "play");
    expect(play?.text).toBe("Play");
    expect(play?.parentId).toBe(SAFE_AREA_CONTROL_ID);
    expect(play?.guiRect.y).toBeGreaterThan(0);
  });

  it("parents Canvas children into SafeArea unless ignoreSafeArea is set", () => {
    const doc = createDefaultUserInterface();
    const pin = createWidget("pin", "Button", "Pin", pinLayout("left", "top", 80, 32));
    const bleed = createWidget(
      "bleed",
      "Image",
      "Bleed",
      pinLayout("left", "top", 80, 32),
    );
    bleed.ignoreSafeArea = true;
    doc.widgets.canvas!.children = ["pin", "bleed"];
    doc.widgets.pin = pin;
    doc.widgets.bleed = bleed;
    const layout = layoutUserInterface(doc, { width: 800, height: 600 });
    const controls = describeUiControls(doc, layout);
    expect(controls.find((row) => row.id === "pin")?.parentId).toBe(
      SAFE_AREA_CONTROL_ID,
    );
    expect(controls.find((row) => row.id === "bleed")?.parentId).toBe("canvas");
    expect(controls.find((row) => row.id === "bleed")?.ignoreSafeArea).toBe(true);
  });

  it("assigns Grid cells and stack layoutMode from the parent kind", () => {
    const doc = createDefaultUserInterface();
    const grid = createWidget("grid", "Grid", "Grid");
    grid.props.columns = 2;
    grid.props.rows = 2;
    const a = createWidget("a", "Button", "A");
    const b = createWidget("b", "Button", "B");
    const c = createWidget("c", "Button", "C");
    doc.widgets.canvas!.children = ["grid"];
    doc.widgets.grid = grid;
    grid.children = ["a", "b", "c"];
    doc.widgets.a = a;
    doc.widgets.b = b;
    doc.widgets.c = c;
    const layout = layoutUserInterface(doc, { width: 800, height: 600 });
    const controls = describeUiControls(doc, layout);
    expect(controls.find((row) => row.id === "a")?.layoutMode).toBe("grid");
    expect(controls.find((row) => row.id === "a")?.gridColumn).toBe(0);
    expect(controls.find((row) => row.id === "a")?.gridRow).toBe(0);
    expect(controls.find((row) => row.id === "c")?.gridColumn).toBe(0);
    expect(controls.find((row) => row.id === "c")?.gridRow).toBe(1);
  });

  it("emits a prefixed nested UserInterface subtree with nested text and parent", () => {
    const chip = createDefaultUserInterface("Chip");
    const label = createWidget(
      "label",
      "Text",
      "HP",
      pinLayout("left", "top", 80, 20),
    );
    label.props.text = "HP";
    label.style.color = "#ff0000";
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

    const layout = layoutUserInterface(
      hud,
      { width: 1920, height: 1080 },
      { resolveNested: (guid) => (guid === "chip-guid" ? chip : null) },
    );
    const controls = describeUiControls(hud, layout);
    const ids = controls.map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining(["chip", "chip/canvas", "chip/label"]));
    const nestedLabel = controls.find((row) => row.id === "chip/label");
    expect(nestedLabel?.text).toBe("HP");
    expect(nestedLabel?.style.color).toBe("#ff0000");
    expect(nestedLabel?.parentId).toBe("chip/canvas");
    expect(nestedLabel?.parentId).not.toBe(SAFE_AREA_CONTROL_ID);
    expect(nestedLabel?.parentId).not.toBe("canvas");
  });
});
