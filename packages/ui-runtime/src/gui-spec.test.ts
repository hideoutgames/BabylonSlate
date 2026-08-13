import { describe, expect, it } from "vitest";
import { createWidget, pinLayout } from "./types";
import { describeUiControls } from "./controls";
import { layoutUserInterface } from "./layout";
import { createDefaultUserInterface } from "./types";
import { guiControlType, guiSpecFromDescriptor } from "./gui-spec";

describe("guiSpecFromDescriptor", () => {
  it("maps widget kinds onto Babylon GUI control types", () => {
    expect(guiControlType("Button")).toBe("Button");
    expect(guiControlType("Text")).toBe("TextBlock");
    expect(guiControlType("TextInput")).toBe("InputText");
    expect(guiControlType("Slider")).toBe("Slider");
    expect(guiControlType("CheckBox")).toBe("Checkbox");
    expect(guiControlType("Image")).toBe("Image");
    expect(guiControlType("Canvas")).toBe("Rectangle");
    expect(guiControlType("HorizontalBox")).toBe("StackPanel");
    expect(guiControlType("VerticalBox")).toBe("StackPanel");
    expect(guiControlType("Grid")).toBe("Grid");
    expect(guiControlType("ScrollBox")).toBe("ScrollViewer");
    expect(guiControlType("ProgressBar")).toBe("ProgressBar");
    expect(guiControlType("Spacer")).toBe("Container");
    expect(guiControlType("TouchJoystick")).toBe("Ellipse");
    expect(guiControlType("TouchButton")).toBe("Button");
    expect(guiControlType("TouchDPad")).toBe("Rectangle");
    expect(guiControlType("UserInterface")).toBe("Rectangle");
  });

  it("writes absolute left/top/width/height from the laid-out GUI rect", () => {
    const doc = createDefaultUserInterface();
    const button = createWidget(
      "btn",
      "Button",
      "Play",
      pinLayout({ x: 0, y: 1 }, { x: 160, y: 40 }, { x: 0, y: 1 }),
    );
    button.props.text = "Play";
    button.style.background = "#336699";
    button.style.color = "#ffffff";
    button.style.fontSize = 20;
    button.style.opacity = 0.8;
    button.style.borderRadius = 8;
    doc.widgets.canvas!.children = ["btn"];
    doc.widgets.btn = button;
    const layout = layoutUserInterface(doc, { width: 800, height: 600 });
    const controls = describeUiControls(doc, layout, 600);
    const control = controls.find((row) => row.id === "btn")!;
    const spec = guiSpecFromDescriptor(control, {
      interactive: false,
    });
    expect(spec.type).toBe("Button");
    expect(spec.left).toBe(control.guiRect.x);
    expect(spec.top).toBe(control.guiRect.y);
    expect(spec.width).toBe(160);
    expect(spec.height).toBe(40);
    expect(spec.text).toBe("Play");
    expect(spec.background).toBe("#336699");
    expect(spec.color).toBe("#ffffff");
    expect(spec.fontSize).toBe(20);
    expect(spec.alpha).toBe(0.8);
    expect(spec.cornerRadius).toBe(8);
    expect(spec.hitTestVisible).toBe(false);
    expect(spec.horizontalAlignment).toBe("left");
    expect(spec.verticalAlignment).toBe("top");
  });

  it("enables pointer hits in interactive Play mode", () => {
    const doc = createDefaultUserInterface();
    const stick = createWidget(
      "stick",
      "TouchJoystick",
      "Move",
      pinLayout({ x: 0.2, y: 0.2 }, { x: 160, y: 160 }),
    );
    doc.widgets.canvas!.children = ["stick"];
    doc.widgets.stick = stick;
    const layout = layoutUserInterface(doc, { width: 800, height: 600 });
    const controls = describeUiControls(doc, layout, 600);
    const spec = guiSpecFromDescriptor(controls.find((row) => row.id === "stick")!, {
      interactive: true,
    });
    expect(spec.type).toBe("Ellipse");
    expect(spec.hitTestVisible).toBe(true);
    expect(spec.isPointerBlocker).toBe(true);
  });
});
