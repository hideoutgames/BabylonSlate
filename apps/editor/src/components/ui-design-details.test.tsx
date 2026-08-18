import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  createDefaultUserInterface,
  createWidget,
  defaultAddLayout,
  layoutUserInterface,
} from "@babylonslate/ui-runtime";
import { UiDesignDetails } from "./ui-design-details";

afterEach(() => {
  cleanup();
});

function renderDetails(selected: ReturnType<typeof createWidget>) {
  const ui = createDefaultUserInterface();
  ui.widgets[selected.id] = selected;
  ui.widgets.canvas!.children = [selected.id];
  const layout = layoutUserInterface(
    ui,
    { width: 800, height: 600 },
    { designSpace: true },
  );
  render(
    <UiDesignDetails
      ui={ui}
      selected={selected}
      layout={layout}
      actionNames={[]}
      assetLabels={{}}
      onPatchWidget={() => {}}
      onPatchLayout={() => {}}
      onPickAsset={() => {}}
    />,
  );
}

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
});
