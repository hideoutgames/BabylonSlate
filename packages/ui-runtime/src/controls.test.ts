import { describe, expect, it } from "vitest";
import {
  SAFE_AREA_CONTROL_ID,
  createDefaultUserInterface,
  createWidget,
  describeUiControls,
  layoutUserInterface,
  pinLayout,
  scopeUiControlIds,
} from "./index";

describe("describeUiControls", () => {
  it("walks the widget tree without a layout solver", () => {
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
    const controls = describeUiControls(doc);
    const play = controls.find((row) => row.id === "play");
    expect(play?.text).toBe("Play");
    expect(play?.parentId).toBe(SAFE_AREA_CONTROL_ID);
    expect(play?.layout.verticalAlignment).toBe("bottom");
  });

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

  it("parents nested instance children into the slot and skips the nested Canvas", () => {
    const chip = createDefaultUserInterface("Chip");
    const label = createWidget(
      "label", "TextBlock",
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

    const controls = describeUiControls(hud, {
      resolveNested: (guid) => (guid === "chip-guid" ? chip : null),
    });
    const ids = controls.map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining(["chip", "chip/label"]));
    expect(ids).not.toContain("chip/canvas");
    const nestedLabel = controls.find((row) => row.id === "chip/label");
    expect(nestedLabel?.text).toBe("HP");
    expect(nestedLabel?.style.color).toBe("#ff0000");
    expect(nestedLabel?.parentId).toBe("chip");
    expect(nestedLabel?.parentId).not.toBe(SAFE_AREA_CONTROL_ID);
    expect(nestedLabel?.parentId).not.toBe("canvas");
    expect(ids).not.toContain("chip/__safeArea");
  });

  it("applies slot overrides and drops unknown nested ids", () => {
    const chip = createDefaultUserInterface("Chip");
    const label = createWidget("label", "TextBlock", "HP", pinLayout("left", "top", 80, 20));
    label.props.text = "HP";
    label.exposed = { key: "label", label: "Label" };
    chip.widgets.canvas!.children = ["label"];
    chip.widgets.label = label;

    const hud = createDefaultUserInterface("HUD");
    const host = createWidget("chip", "UserInterface", "Chip", pinLayout("left", "top", 80, 20));
    host.nestedUiGuid = "chip-guid";
    host.overrides = {
      label: { text: "MP", color: "#00ff00" },
      gone: { text: "stale" },
    };
    hud.widgets.canvas!.children = ["chip"];
    hud.widgets.chip = host;

    const controls = describeUiControls(hud, {
      resolveNested: (guid) => (guid === "chip-guid" ? chip : null),
    });
    expect(controls.find((row) => row.id === "chip/label")?.text).toBe("MP");
    expect(controls.find((row) => row.id === "chip/label")?.style.color).toBe("#00ff00");
    expect(controls.some((row) => row.id === "chip/gone")).toBe(false);
  });

  it("nests a Touch skin without mounting a nested Canvas", () => {
    const skin = createDefaultUserInterface("Skin");
    const art = createWidget("art", "Image", "Art", pinLayout("left", "top", 64, 64));
    skin.widgets.canvas!.children = ["art"];
    skin.widgets.art = art;
    const hud = createDefaultUserInterface("HUD");
    const stick = createWidget(
      "stick",
      "TouchJoystick",
      "Move",
      pinLayout("left", "bottom", 160, 160),
    );
    stick.nestedUiGuid = "skin-guid";
    hud.widgets.canvas!.children = ["stick"];
    hud.widgets.stick = stick;
    const controls = describeUiControls(hud, {
      resolveNested: (guid) => (guid === "skin-guid" ? skin : null),
    });
    expect(controls.map((row) => row.id)).toEqual(
      expect.arrayContaining(["stick", "stick/art"]),
    );
    expect(controls.map((row) => row.id)).not.toContain("stick/canvas");
    expect(controls.find((row) => row.id === "stick/art")?.parentId).toBe("stick");
  });

  it("scopes instance ids and parent ids together", () => {
    const doc = createDefaultUserInterface();
    const button = createWidget("play", "Button", "Play");
    doc.widgets.canvas!.children = ["play"];
    doc.widgets.play = button;
    const scoped = scopeUiControlIds(describeUiControls(doc), "ui-1");
    expect(scoped.find((row) => row.id === "ui-1:play")?.parentId).toBe(
      `ui-1:${SAFE_AREA_CONTROL_ID}`,
    );
    expect(scoped.find((row) => row.id === "ui-1:canvas")?.parentId).toBeNull();
  });

  it("does not invent StackPanel child geometry", () => {
    const doc = createDefaultUserInterface();
    const stack = createWidget("stack", "StackPanel", "Stack");
    const a = createWidget("a", "Button", "A", pinLayout("left", "top", 80, 32));
    const b = createWidget("b", "Button", "B", pinLayout("left", "top", 80, 32));
    stack.children = ["a", "b"];
    doc.widgets.canvas!.children = ["stack"];
    doc.widgets.stack = stack;
    doc.widgets.a = a;
    doc.widgets.b = b;
    const controls = describeUiControls(doc);
    expect(controls.find((row) => row.id === "a")?.layoutMode).toBe("stack");
    expect(controls.find((row) => row.id === "a")?.guiRect.y).toBe(
      controls.find((row) => row.id === "b")?.guiRect.y,
    );
  });
});
