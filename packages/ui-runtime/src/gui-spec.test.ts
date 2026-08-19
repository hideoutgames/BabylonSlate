import { describe, expect, it } from "vitest";
import { createWidget, pinLayout } from "./types";
import { describeUiControls } from "./controls";
import { layoutUserInterface } from "./layout";
import { createDefaultUserInterface } from "./types";
import { guiControlType, guiSpecFromDescriptor } from "./gui-spec";
import { SAFE_AREA_CONTROL_ID } from "./layout";

describe("guiSpecFromDescriptor", () => {
  it("maps widget kinds onto Babylon GUI control types", () => {
    expect(guiControlType("Button")).toBe("Button");
    expect(guiControlType("TextBlock")).toBe("TextBlock");
    expect(guiControlType("InputText")).toBe("InputText");
    expect(guiControlType("Slider")).toBe("Slider");
    expect(guiControlType("Checkbox")).toBe("Checkbox");
    expect(guiControlType("Image")).toBe("Image");
    expect(guiControlType("Canvas")).toBe("Rectangle");
    expect(guiControlType("StackPanel")).toBe("StackPanel");
    expect(guiControlType("Grid")).toBe("Grid");
    expect(guiControlType("ScrollViewer")).toBe("ScrollViewer");
    expect(guiControlType("ProgressBar")).toBe("ProgressBar");
    expect(guiControlType("Container")).toBe("Container");
    expect(guiControlType("TouchJoystick")).toBe("Ellipse");
    expect(guiControlType("TouchButton")).toBe("Rectangle");
    expect(guiControlType("TouchDPad")).toBe("Rectangle");
    expect(guiControlType("UserInterface")).toBe("Rectangle");
    expect(guiControlType("Material")).toBe("Image");
  });

  it("copies Babylon alignment and size from the widget layout", () => {
    const doc = createDefaultUserInterface();
    const button = createWidget(
      "btn",
      "Button",
      "Play",
      pinLayout("left", "top", 160, 40, 8, 12),
    );
    button.props.text = "Play";
    button.style.background = "#336699";
    button.style.color = "#ffffff";
    button.style.fontSize = 20;
    button.style.opacity = 0.8;
    button.style.borderRadius = 8;
    doc.widgets.canvas!.children = ["btn"];
    doc.widgets.btn = button;
    const layout = layoutUserInterface(doc, { width: 1920, height: 1080 });
    const controls = describeUiControls(doc, layout);
    const control = controls.find((row) => row.id === "btn")!;
    const spec = guiSpecFromDescriptor(control, {
      interactive: false,
    });
    expect(spec.type).toBe("Button");
    expect(spec.horizontalAlignment).toBe("left");
    expect(spec.verticalAlignment).toBe("top");
    expect(spec.left).toBe(8);
    expect(spec.top).toBe(12);
    expect(spec.width).toBe(160);
    expect(spec.height).toBe(40);
    expect(spec.text).toBe("Play");
    expect(spec.background).toBe("#336699");
    expect(spec.color).toBe("#ffffff");
    expect(spec.fontSize).toBe(20);
    expect(spec.alpha).toBe(0.8);
    expect(spec.cornerRadius).toBe(8);
    expect(spec.hitTestVisible).toBe(false);
    expect(spec.parentId).toBe(SAFE_AREA_CONTROL_ID);
  });

  it("enables pointer hits in interactive Play mode", () => {
    const doc = createDefaultUserInterface();
    const stick = createWidget(
      "stick",
      "TouchJoystick",
      "Move",
      pinLayout("left", "bottom", 160, 160, 40, 0),
    );
    doc.widgets.canvas!.children = ["stick"];
    doc.widgets.stick = stick;
    const layout = layoutUserInterface(doc, { width: 1920, height: 1080 });
    const controls = describeUiControls(doc, layout);
    const spec = guiSpecFromDescriptor(controls.find((row) => row.id === "stick")!, {
      interactive: true,
    });
    expect(spec.type).toBe("Ellipse");
    expect(spec.hitTestVisible).toBe(true);
    expect(spec.isPointerBlocker).toBe(true);
  });

  it("does not hit-test Canvas, Image, or Text in interactive Play by default", () => {
    const doc = createDefaultUserInterface();
    const art = createWidget(
      "art",
      "Image",
      "Logo",
      pinLayout("left", "top", 64, 64),
    );
    const label = createWidget(
      "label", "TextBlock",
      "Score",
      pinLayout("left", "top", 80, 24, 80, 0),
    );
    doc.widgets.canvas!.children = ["art", "label"];
    doc.widgets.art = art;
    doc.widgets.label = label;
    const layout = layoutUserInterface(doc, { width: 1920, height: 1080 });
    const controls = describeUiControls(doc, layout);
    const canvas = guiSpecFromDescriptor(
      controls.find((row) => row.id === "canvas")!,
      { interactive: true },
    );
    const image = guiSpecFromDescriptor(
      controls.find((row) => row.id === "art")!,
      { interactive: true },
    );
    const text = guiSpecFromDescriptor(
      controls.find((row) => row.id === "label")!,
      { interactive: true },
    );
    expect(canvas.hitTestVisible).toBe(false);
    expect(canvas.isPointerBlocker).toBe(false);
    expect(image.hitTestVisible).toBe(false);
    expect(image.isPointerBlocker).toBe(false);
    expect(text.hitTestVisible).toBe(false);
    expect(text.isPointerBlocker).toBe(false);
  });

  it("maps a Material widget onto an Image spec with Hit Testable off by default", () => {
    const doc = createDefaultUserInterface();
    const panel = createWidget(
      "fx",
      "Material",
      "Glow",
      pinLayout("left", "top", 128, 64),
    );
    panel.props.materialGuid = "mat-hud";
    doc.widgets.canvas!.children = ["fx"];
    doc.widgets.fx = panel;
    const layout = layoutUserInterface(doc, { width: 800, height: 600 });
    const spec = guiSpecFromDescriptor(
      describeUiControls(doc, layout).find((row) => row.id === "fx")!,
      { interactive: true },
    );
    expect(spec.type).toBe("Image");
    expect(spec.kind).toBe("Material");
    expect(spec.materialGuid).toBe("mat-hud");
    expect(spec.hitTestVisible).toBe(false);
    expect(spec.isPointerBlocker).toBe(false);
    expect(createWidget("fx", "Material").props.materialGuid).toBeNull();
  });

  it("lets an Image block hits when Hit Testable is Enabled", () => {
    const doc = createDefaultUserInterface();
    const art = createWidget(
      "art",
      "Image",
      "Logo",
      pinLayout("left", "top", 64, 64),
    );
    art.hitTestable = true;
    doc.widgets.canvas!.children = ["art"];
    doc.widgets.art = art;
    const layout = layoutUserInterface(doc, { width: 800, height: 600 });
    const spec = guiSpecFromDescriptor(
      describeUiControls(doc, layout).find((row) => row.id === "art")!,
      { interactive: true },
    );
    expect(spec.hitTestVisible).toBe(true);
    expect(spec.isPointerBlocker).toBe(true);
  });

  it("does not hit-test a Button when Hit Testable is Disabled", () => {
    const doc = createDefaultUserInterface();
    const button = createWidget(
      "btn",
      "Button",
      "Play",
      pinLayout("center", "center", 160, 40),
    );
    button.hitTestable = false;
    doc.widgets.canvas!.children = ["btn"];
    doc.widgets.btn = button;
    const layout = layoutUserInterface(doc, { width: 800, height: 600 });
    const spec = guiSpecFromDescriptor(
      describeUiControls(doc, layout).find((row) => row.id === "btn")!,
      { interactive: true },
    );
    expect(spec.hitTestVisible).toBe(false);
    expect(spec.isPointerBlocker).toBe(false);
  });

  it("forces GUI hits off in Game input mode even for Buttons", () => {
    const doc = createDefaultUserInterface();
    const button = createWidget(
      "btn",
      "Button",
      "Play",
      pinLayout("center", "center", 160, 40),
    );
    doc.widgets.canvas!.children = ["btn"];
    doc.widgets.btn = button;
    const layout = layoutUserInterface(doc, { width: 800, height: 600 });
    const spec = guiSpecFromDescriptor(
      describeUiControls(doc, layout).find((row) => row.id === "btn")!,
      { interactive: true, allowGuiHits: false },
    );
    expect(spec.hitTestVisible).toBe(false);
    expect(spec.isPointerBlocker).toBe(false);
  });

  it("keeps percent size on Grid children instead of flattening to px", () => {
    const doc = createDefaultUserInterface();
    const grid = createWidget("grid", "Grid", "Grid");
    const cell = createWidget("cell", "Button", "Cell");
    doc.widgets.canvas!.children = ["grid"];
    doc.widgets.grid = grid;
    grid.children = ["cell"];
    doc.widgets.cell = cell;
    const layout = layoutUserInterface(doc, { width: 800, height: 600 });
    const controls = describeUiControls(doc, layout);
    const spec = guiSpecFromDescriptor(controls.find((row) => row.id === "cell")!, {
      interactive: false,
    });
    expect(spec.layoutMode).toBe("grid");
    expect(spec.left).toBe(0);
    expect(spec.top).toBe(0);
    expect(spec.widthUnit).toBe("percent");
    expect(spec.heightUnit).toBe("percent");
  });

  it("copies slider min/max and ignoreSafeArea onto the spec", () => {
    const doc = createDefaultUserInterface();
    const slider = createWidget(
      "slider",
      "Slider",
      "Look",
      pinLayout("left", "top", 200, 24),
    );
    slider.props.min = 0.25;
    slider.props.max = 0.75;
    slider.props.value = 0.5;
    slider.ignoreSafeArea = true;
    doc.widgets.canvas!.children = ["slider"];
    doc.widgets.slider = slider;
    const layout = layoutUserInterface(doc, { width: 800, height: 600 });
    const spec = guiSpecFromDescriptor(
      describeUiControls(doc, layout).find((row) => row.id === "slider")!,
      { interactive: false },
    );
    expect(spec.sliderMin).toBe(0.25);
    expect(spec.sliderMax).toBe(0.75);
    expect(spec.ignoreSafeArea).toBe(true);
  });
});
