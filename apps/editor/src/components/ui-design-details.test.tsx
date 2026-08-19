import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  createDefaultUserInterface,
  createWidget,
  defaultAddLayout,
} from "@babylonslate/ui-runtime";
import { UiDesignDetails } from "./ui-design-details";

afterEach(() => {
  cleanup();
});

const viewport = {
  width: 800,
  height: 600,
  safeArea: { left: 0, right: 0, top: 0, bottom: 0 },
};

function renderDetails(selected: ReturnType<typeof createWidget>) {
  const ui = createDefaultUserInterface();
  ui.widgets[selected.id] = selected;
  ui.widgets.canvas!.children = [selected.id];
  render(
    <UiDesignDetails
      ui={ui}
      selected={selected}
      viewport={viewport}
      actionNames={[]}
      assetLabels={{}}
      onPatchWidget={() => {}}
      onPatchLayout={() => {}}
      onPickAsset={() => {}}
    />,
  );
}

describe("UiDesignDetails layout fields", () => {
  it("authors left/top units next to offsets", () => {
    const button = createWidget("btn", "Button", "Play", defaultAddLayout("Button"));
    renderDetails(button);
    expect(screen.getByTestId("property-left-unit").textContent).toMatch(/px/i);
    expect(screen.getByTestId("property-top-unit").textContent).toMatch(/px/i);
  });

  it("does not treat style.padding as layout", () => {
    const button = createWidget("btn", "Button", "Play", defaultAddLayout("Button"));
    renderDetails(button);
    expect(screen.queryByTestId("property-padding-left")).toBeNull();
    expect(screen.getByTestId("property-layout-padding-left")).toBeTruthy();
  });

  it("keeps stack-axis size on slot-owned children and hides position", () => {
    const ui = createDefaultUserInterface();
    const stack = createWidget("stack", "StackPanel", "Stack", defaultAddLayout("StackPanel"));
    const button = createWidget("btn", "Button", "Play", defaultAddLayout("Button", 0, "StackPanel"));
    stack.children = ["btn"];
    ui.widgets.stack = stack;
    ui.widgets.btn = button;
    ui.widgets.canvas!.children = ["stack"];
    render(
      <UiDesignDetails
        ui={ui}
        selected={button}
        viewport={viewport}
        actionNames={[]}
        assetLabels={{}}
        onPatchWidget={() => {}}
        onPatchLayout={() => {}}
        onPickAsset={() => {}}
      />,
    );
    expect(screen.getByTestId("ui-slot-layout-note")).toBeTruthy();
    expect(screen.queryByTestId("property-left")).toBeNull();
    expect(screen.getByTestId("property-height")).toBeTruthy();
  });

  it("authors z-index, rotation, and scale", () => {
    const button = createWidget("btn", "Button", "Play", defaultAddLayout("Button"));
    renderDetails(button);
    expect(screen.getByTestId("property-z-index")).toBeTruthy();
    expect(screen.getByTestId("property-rotation")).toBeTruthy();
    expect(screen.getByTestId("property-scale-x")).toBeTruthy();
    expect(screen.getByTestId("property-scale-y")).toBeTruthy();
  });
});

describe("UiDesignDetails style colors", () => {
  it("shows the authored Button background instead of a fake default", () => {
    const button = createWidget("btn", "Button", "Play", defaultAddLayout("Button"));
    renderDetails(button);
    const hex = screen.getByTestId("property-background-hex") as HTMLInputElement;
    expect(hex.value.toLowerCase()).toBe("#333333");
  });

  it("shows an empty Background when a loaded Button omitted one", () => {
    const button = createWidget("btn", "Button", "Play", defaultAddLayout("Button"));
    delete button.style.background;
    renderDetails(button);
    const hex = screen.getByTestId("property-background-hex") as HTMLInputElement;
    expect(hex.value).toBe("");
    expect(hex.value.toLowerCase()).not.toBe("#333333");
  });
});

describe("UiDesignDetails Hit Testable", () => {
  it("shows Enabled for a Button and Disabled for an Image", () => {
    const button = createWidget("btn", "Button", "Play", defaultAddLayout("Button"));
    renderDetails(button);
    expect(screen.getByTestId("property-hitTestable").textContent).toContain(
      "Enabled",
    );
    cleanup();
    const image = createWidget("art", "Image", "Logo", defaultAddLayout("Image"));
    renderDetails(image);
    expect(screen.getByTestId("property-hitTestable").textContent).toContain(
      "Disabled",
    );
  });

  it("shows an Interface Material picker for a Material widget", () => {
    const glow = createWidget("fx", "Material", "Glow", defaultAddLayout("Image"));
    glow.props.materialGuid = "mat-glow";
    renderDetails(glow);
    expect(screen.getByTestId("property-material").textContent).toContain(
      "mat-glow",
    );
  });
});
