import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { UiWidgetCatalog } from "./ui-widget-catalog";

afterEach(() => {
  cleanup();
});

describe("UiWidgetCatalog", () => {
  it("lists cycle-filtered UserInterface assets as bound slots, not an empty rectangle", () => {
    const onSelect = vi.fn();
    render(
      <UiWidgetCatalog
        open
        onOpenChange={() => {}}
        onSelect={onSelect}
        nestedUiAssets={[{ guid: "chip-guid", name: "Chip" }]}
      />,
    );
    expect(screen.queryByTestId("ui-add-widget-UserInterface")).toBeNull();
    fireEvent.click(screen.getByTestId("ui-add-widget-UserInterface-chip-guid"));
    expect(onSelect).toHaveBeenCalledWith({
      kind: "UserInterface",
      isVertical: undefined,
      nestedUiGuid: "chip-guid",
      label: "Chip",
    });
  });

  it("offers Vertical Stack and Horizontal Stack presets", () => {
    const onSelect = vi.fn();
    render(
      <UiWidgetCatalog open onOpenChange={() => {}} onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByTestId("ui-add-widget-StackPanel-vertical"));
    expect(onSelect).toHaveBeenCalledWith({
      kind: "StackPanel",
      isVertical: true,
      nestedUiGuid: undefined,
      label: "Vertical Stack",
    });
  });
});
