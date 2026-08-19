import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  createDefaultUserInterface,
  createWidget,
  pinLayout,
} from "@babylonslate/ui-runtime";
import { dispatchPointerEvent } from "../../../../packages/editor-kit/src/test-support/pointer-events";
import { UiDesignHierarchy } from "./ui-design-hierarchy";

afterEach(() => {
  cleanup();
});

describe("UiDesignHierarchy instances", () => {
  it("shows Open Asset and Extract, and maps nested names onto the slot", () => {
    const chip = createDefaultUserInterface("Chip");
    const label = createWidget("label", "TextBlock", "HP", pinLayout("left", "top", 80, 20));
    chip.widgets.canvas!.children = ["label"];
    chip.widgets.label = label;

    const hud = createDefaultUserInterface("HUD");
    const slot = createWidget("chip", "UserInterface", "Chip", pinLayout("left", "top", 80, 20));
    slot.nestedUiGuid = "chip-guid";
    hud.widgets.canvas!.children = ["chip"];
    hud.widgets.chip = slot;

    const onSelect = vi.fn();
    const onOpenAsset = vi.fn();
    render(
      <UiDesignHierarchy
        ui={hud}
        selectedId="chip"
        onSelect={onSelect}
        onChange={() => {}}
        resolveNested={(guid) => (guid === "chip-guid" ? chip : null)}
        onExtract={() => {}}
        onOpenAsset={onOpenAsset}
      />,
    );
    const nested = screen.getByTestId("tree-row-chip/label");
    dispatchPointerEvent(nested, "pointerdown", { clientX: 10, clientY: 10 });
    dispatchPointerEvent(nested, "pointerup", { clientX: 10, clientY: 10 });
    expect(onSelect).toHaveBeenCalledWith("chip");
    fireEvent.click(screen.getByTestId("ui-widget-menu-chip"));
    expect(screen.getByTestId("ui-widget-open-asset")).toBeTruthy();
    expect(screen.getByTestId("ui-widget-extract")).toBeTruthy();
  });
});
