import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  createDefaultUserInterface,
  createWidget,
  defaultAddLayout,
  stretchLayout,
} from "@babylonslate/ui-runtime";
import { createUiDesignerSession } from "../lib/ui-designer-session";
import { UiDesignDetails } from "./ui-design-details";

vi.mock("@babylonslate/render", () => ({
  uiHostStats: { apply: 0, create: 0, present: 0, commit: 0 },
}));

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

  it("shows stretch insets instead of a 100% width field", () => {
    const button = createWidget("btn", "Button", "Play", stretchLayout({ left: 16, right: 24, top: 8, bottom: 12 }));
    renderDetails(button);
    expect(screen.queryByTestId("property-width")).toBeNull();
    expect(screen.queryByTestId("property-height")).toBeNull();
    expect(screen.getByTestId("property-inset-left")).toBeTruthy();
    expect(screen.getByTestId("property-inset-right")).toBeTruthy();
    expect(screen.getByTestId("property-inset-top")).toBeTruthy();
    expect(screen.getByTestId("property-inset-bottom")).toBeTruthy();
  });

  it("does not expose Rectangle box width and height", () => {
    const box = createWidget("panel", "Rectangle", "Panel", defaultAddLayout("Rectangle"));
    renderDetails(box);
    expect(screen.queryByTestId("property-box-width")).toBeNull();
    expect(screen.queryByTestId("property-box-height")).toBeNull();
    expect(screen.getByTestId("property-width")).toBeTruthy();
  });

  it("previews a Width scrub and commits the previewed layout on blur", () => {
    const button = createWidget("btn", "Button", "Play", defaultAddLayout("Button"));
    const onPatchLayout = vi.fn();
    const onPreviewLayout = vi.fn();
    const onCommitLayout = vi.fn();
    const ui = createDefaultUserInterface();
    ui.widgets[button.id] = button;
    ui.widgets.canvas!.children = [button.id];
    render(
      <UiDesignDetails
        ui={ui}
        selected={button}
        viewport={viewport}
        actionNames={[]}
        assetLabels={{}}
        onPatchWidget={() => {}}
        onPatchLayout={onPatchLayout}
        onPreviewLayout={onPreviewLayout}
        onCommitLayout={onCommitLayout}
        onPickAsset={() => {}}
      />,
    );
    const width = screen.getByTestId("property-width");
    fireEvent.change(width, { target: { value: "240" } });
    expect(onPreviewLayout).toHaveBeenCalled();
    const origin = onPreviewLayout.mock.calls[0]![1] as { width: number };
    expect(origin.width).toBe(button.layout.width);
    const previewed = onPreviewLayout.mock.calls.at(-1)![1] as { width: number };
    expect(previewed.width).toBe(240);
    expect(onPatchLayout).not.toHaveBeenCalled();
    fireEvent.blur(width);
    expect(onCommitLayout).toHaveBeenCalledTimes(1);
    const committed = onCommitLayout.mock.calls[0]![1] as { width: number };
    expect(committed.width).toBe(240);
    expect(onPatchLayout).not.toHaveBeenCalled();
  });

  it("commits a previewed Width when Details unmounts without blur", () => {
    const button = createWidget("btn", "Button", "Play", defaultAddLayout("Button"));
    const onCommitLayout = vi.fn();
    const ui = createDefaultUserInterface();
    ui.widgets[button.id] = button;
    ui.widgets.canvas!.children = [button.id];
    const { unmount } = render(
      <UiDesignDetails
        ui={ui}
        selected={button}
        viewport={viewport}
        actionNames={[]}
        assetLabels={{}}
        onPatchWidget={() => {}}
        onPatchLayout={() => {}}
        onPreviewLayout={() => {}}
        onCommitLayout={onCommitLayout}
        onPickAsset={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId("property-width"), { target: { value: "240" } });
    unmount();
    expect(onCommitLayout).toHaveBeenCalledTimes(1);
    expect((onCommitLayout.mock.calls[0]![1] as { width: number }).width).toBe(240);
  });

  it("unlocks a layout session when Details unmounts after a Width preview", () => {
    const button = createWidget("btn", "Button", "Play", defaultAddLayout("Button"));
    const commitLayout = vi.fn();
    const session = createUiDesignerSession({
      getHost: () => null,
      present: () => {},
      schedule: (work) => work(),
      commitLayout,
    });
    const ui = createDefaultUserInterface();
    ui.widgets[button.id] = button;
    ui.widgets.canvas!.children = [button.id];
    const { unmount } = render(
      <UiDesignDetails
        ui={ui}
        selected={button}
        viewport={viewport}
        actionNames={[]}
        assetLabels={{}}
        onPatchWidget={() => {}}
        onPatchLayout={() => {}}
        onPreviewLayout={(id, layout) => session.preview(id, layout)}
        onCommitLayout={(id, layout) => session.commit(layout)}
        onPickAsset={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId("property-width"), { target: { value: "240" } });
    expect(session.locked).toBe(true);
    unmount();
    expect(session.locked).toBe(false);
    expect(commitLayout).toHaveBeenCalledTimes(1);
    expect((commitLayout.mock.calls[0]![1] as { width: number }).width).toBe(240);
  });

  it("lets session cancel restore the Width from before the scrub", () => {
    const button = createWidget("btn", "Button", "Play", defaultAddLayout("Button"));
    const originWidth = button.layout.width;
    const patchLiveLayout = vi.fn();
    const session = createUiDesignerSession({
      getHost: () => ({ patchLiveLayout, markAsDirty: vi.fn(), setGestureLocked: vi.fn() }),
      present: () => {},
      schedule: (work) => work(),
      commitLayout: vi.fn(),
    });
    const ui = createDefaultUserInterface();
    ui.widgets[button.id] = button;
    ui.widgets.canvas!.children = [button.id];
    render(
      <UiDesignDetails
        ui={ui}
        selected={button}
        viewport={viewport}
        actionNames={[]}
        assetLabels={{}}
        onPatchWidget={() => {}}
        onPatchLayout={() => {}}
        onPreviewLayout={(id, layout) => session.preview(id, layout)}
        onCommitLayout={(id, layout) => session.commit(layout)}
        onPickAsset={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId("property-width"), { target: { value: "240" } });
    fireEvent.change(screen.getByTestId("property-width"), { target: { value: "280" } });
    session.cancel();
    expect(session.locked).toBe(false);
    const restored = patchLiveLayout.mock.calls.at(-1)![1] as { width: number };
    expect(restored.width).toBe(originWidth);
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

describe("UiDesignDetails Grid tracks", () => {
  it("resizes gridColumns when Columns changes", () => {
    const grid = createWidget("grid", "Grid", "Grid", defaultAddLayout("Grid"));
    const onPatchWidget = vi.fn();
    const ui = createDefaultUserInterface();
    ui.widgets[grid.id] = grid;
    ui.widgets.canvas!.children = [grid.id];
    render(
      <UiDesignDetails
        ui={ui}
        selected={grid}
        viewport={viewport}
        actionNames={[]}
        assetLabels={{}}
        onPatchWidget={onPatchWidget}
        onPatchLayout={() => {}}
        onPickAsset={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId("property-columns"), { target: { value: "3" } });
    expect(onPatchWidget).toHaveBeenCalled();
    const patch = onPatchWidget.mock.calls.at(-1)![1] as {
      props: { columns: number; gridColumns: Array<{ value: number; isPixel: boolean }> };
    };
    expect(patch.props.columns).toBe(3);
    expect(patch.props.gridColumns).toHaveLength(3);
    expect(patch.props.gridColumns[2]).toEqual({ value: 1, isPixel: false });
  });

  it("resizes gridRows when Rows changes", () => {
    const grid = createWidget("grid", "Grid", "Grid", defaultAddLayout("Grid"));
    const onPatchWidget = vi.fn();
    const ui = createDefaultUserInterface();
    ui.widgets[grid.id] = grid;
    ui.widgets.canvas!.children = [grid.id];
    render(
      <UiDesignDetails
        ui={ui}
        selected={grid}
        viewport={viewport}
        actionNames={[]}
        assetLabels={{}}
        onPatchWidget={onPatchWidget}
        onPatchLayout={() => {}}
        onPickAsset={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId("property-rows"), { target: { value: "4" } });
    expect(onPatchWidget).toHaveBeenCalled();
    const patch = onPatchWidget.mock.calls.at(-1)![1] as {
      props: { rows: number; gridRows: Array<{ value: number; isPixel: boolean }> };
    };
    expect(patch.props.rows).toBe(4);
    expect(patch.props.gridRows).toHaveLength(4);
    expect(patch.props.gridRows[3]).toEqual({ value: 1, isPixel: false });
  });
});
