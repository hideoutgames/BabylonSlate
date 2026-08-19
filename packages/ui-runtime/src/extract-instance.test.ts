import { describe, expect, it } from "vitest";
import { createDefaultUserInterface, createWidget, pinLayout } from "./types";
import { extractWidgetAsPrefab } from "./extract-instance";

describe("extractWidgetAsPrefab", () => {
  it("replaces the selection with a viewport-layer-false instance slot", () => {
    const hud = createDefaultUserInterface("HUD");
    const chip = createWidget(
      "chip",
      "Rectangle",
      "Chip",
      pinLayout("left", "top", 80, 24, 8, 8),
    );
    const label = createWidget("label", "TextBlock", "HP", pinLayout("left", "top", 80, 20));
    label.props.text = "HP";
    chip.children = ["label"];
    hud.widgets.canvas!.children = ["chip"];
    hud.widgets.chip = chip;
    hud.widgets.label = label;

    const { prefab, nextHost, slotId } = extractWidgetAsPrefab(hud, "chip", "Health Chip");
    expect(prefab.viewportLayer).toBe(false);
    expect(prefab.name).toBe("Health Chip");
    expect(prefab.widgets.canvas?.children).toEqual(["chip"]);
    expect(prefab.widgets.label?.props.text).toBe("HP");
    expect(nextHost.widgets[slotId]?.kind).toBe("UserInterface");
    expect(nextHost.widgets[slotId]?.layout.width).toBe(80);
    expect(nextHost.widgets.label).toBeUndefined();
    expect(nextHost.widgets.chip).toBeUndefined();
  });
});
