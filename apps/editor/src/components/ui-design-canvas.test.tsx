import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Engine } from "@babylonjs/core";
import { resetUiHostStats, uiHostStats } from "@babylonslate/render";
import {
  createDefaultPlayHud,
  createDefaultUserInterface,
  createWidget,
  describeUiControls,
  layoutUserInterface,
  pinLayout,
} from "@babylonslate/ui-runtime";
import { UiDesignCanvas } from "./ui-design-canvas";

const { createUiSurfaceMock } = vi.hoisted(() => ({
  createUiSurfaceMock: vi.fn(),
}));

vi.mock("@babylonslate/render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@babylonslate/render")>();
  return {
    ...actual,
    createUiSurface: (...args: unknown[]) => createUiSurfaceMock(...args),
  };
});

afterEach(() => {
  cleanup();
  createUiSurfaceMock.mockReset();
  resetUiHostStats();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

function hudCanvasProps() {
  const ui = createDefaultPlayHud("HUD");
  const viewport = {
    id: "desktop-16-9",
    width: 1920,
    height: 1080,
    safeArea: { left: 0, right: 0, top: 0, bottom: 0 },
  };
  const layout = layoutUserInterface(ui, viewport, {
    designSpace: true,
    safeArea: viewport.safeArea,
  });
  return {
    ui,
    viewport,
    layout,
    controls: describeUiControls(ui, layout),
    selectedId: ui.rootId,
    view: { zoom: 1, panX: 0, panY: 0 },
    previewScale: 1,
    bitmapScale: 1,
    sharedEngine: {} as Engine,
    onSelect: () => {},
    onViewChange: () => {},
    onLayoutChange: () => {},
  };
}

function mockSurface() {
  return {
    present: vi.fn(),
    setFrozen: vi.fn(),
    dispose: vi.fn(),
    host: {
      measureControls: () => ({}),
      clear: vi.fn(),
      addControl: vi.fn(),
      markAsDirty: vi.fn(),
    },
    resizeDesign: vi.fn(),
    resizeGizmos: vi.fn(),
    presentGizmos: vi.fn(),
    designAdt: { markAsDirty: vi.fn() },
    gizmoAdt: null,
  };
}

describe("UiDesignCanvas preview fallback", () => {
  it("shows an error instead of a silent black canvas when the surface fails", () => {
    createUiSurfaceMock.mockImplementation(() => {
      throw new Error("standalone ADT failed");
    });
    render(<UiDesignCanvas {...hudCanvasProps()} />);
    expect(screen.getByTestId("ui-gui-preview-error")).toBeTruthy();
    expect(screen.getByTestId("ui-gui-preview-error").textContent).toMatch(
      /unavailable/i,
    );
  });

  it("does not show Preview Unavailable when present skips a zero-size ADT", () => {
    const present = vi.fn();
    createUiSurfaceMock.mockReturnValue({
      present,
      setFrozen: vi.fn(),
      dispose: vi.fn(),
      host: {
        measureControls: () => ({}),
        clear: vi.fn(),
        addControl: vi.fn(),
        markAsDirty: vi.fn(),
      },
      resizeDesign: vi.fn(),
      resizeGizmos: vi.fn(),
      presentGizmos: vi.fn(),
      designAdt: { markAsDirty: vi.fn() },
      gizmoAdt: null,
    });
    render(<UiDesignCanvas {...hudCanvasProps()} />);
    expect(present).toHaveBeenCalled();
    expect(screen.queryByTestId("ui-gui-preview-error")).toBeNull();
    const options = createUiSurfaceMock.mock.calls[0]?.[2] as {
      resolveImageUrl?: (guid: string) => string | null;
    };
    expect(typeof options.resolveImageUrl).toBe("function");
  });

  it("skips present when the Design dock tab is hidden", () => {
    const present = vi.fn();
    const setFrozen = vi.fn();
    createUiSurfaceMock.mockReturnValue({
      present,
      setFrozen,
      dispose: vi.fn(),
      host: {
        measureControls: () => ({}),
        clear: vi.fn(),
        addControl: vi.fn(),
        markAsDirty: vi.fn(),
      },
      resizeDesign: vi.fn(),
      resizeGizmos: vi.fn(),
      presentGizmos: vi.fn(),
      designAdt: { markAsDirty: vi.fn() },
      gizmoAdt: null,
    });
    render(
      <UiDesignCanvas
        {...hudCanvasProps()}
        panelVisible={false}
        documentActive
      />,
    );
    expect(present).not.toHaveBeenCalled();
    expect(setFrozen).toHaveBeenCalledWith(true);
    expect(screen.queryByTestId("ui-gui-preview-error")).toBeNull();
  });

  it("skips apply while the Design tab is frozen", () => {
    const addControl = vi.fn();
    createUiSurfaceMock.mockReturnValue({
      present: vi.fn(),
      setFrozen: vi.fn(),
      dispose: vi.fn(),
      host: {
        measureControls: () => ({}),
        clear: vi.fn(),
        addControl,
        markAsDirty: vi.fn(),
      },
      resizeDesign: vi.fn(),
      resizeGizmos: vi.fn(),
      presentGizmos: vi.fn(),
      designAdt: { markAsDirty: vi.fn() },
      gizmoAdt: null,
    });
    render(
      <UiDesignCanvas
        {...hudCanvasProps()}
        panelVisible={false}
        documentActive={false}
      />,
    );
    expect(addControl).not.toHaveBeenCalled();
  });

  it("resizes the existing surface when the device viewport changes", () => {
    const dispose = vi.fn();
    const resizeDesign = vi.fn();
    createUiSurfaceMock.mockReturnValue({
      present: vi.fn(),
      setFrozen: vi.fn(),
      dispose,
      host: {
        measureControls: () => ({}),
        clear: vi.fn(),
        addControl: vi.fn(),
        markAsDirty: vi.fn(),
      },
      resizeDesign,
      resizeGizmos: vi.fn(),
      presentGizmos: vi.fn(),
      designAdt: { markAsDirty: vi.fn() },
      gizmoAdt: null,
    });
    const props = hudCanvasProps();
    const { rerender } = render(<UiDesignCanvas {...props} />);
    expect(createUiSurfaceMock).toHaveBeenCalledTimes(1);
    rerender(
      <UiDesignCanvas
        {...props}
        viewport={{ ...props.viewport, width: 800, height: 600 }}
      />,
    );
    expect(createUiSurfaceMock).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    expect(resizeDesign).toHaveBeenCalledWith(800, 600, "shortestSide", {
      width: 800,
      height: 600,
    });
  });

  it("re-applies when returning from Logic to Designer", () => {
    const addControl = vi.fn();
    createUiSurfaceMock.mockReturnValue({
      present: vi.fn(),
      setFrozen: vi.fn(),
      dispose: vi.fn(),
      host: {
        measureControls: () => ({}),
        clear: vi.fn(),
        addControl,
        markAsDirty: vi.fn(),
      },
      resizeDesign: vi.fn(),
      resizeGizmos: vi.fn(),
      presentGizmos: vi.fn(),
      designAdt: { markAsDirty: vi.fn() },
      gizmoAdt: null,
    });
    const props = hudCanvasProps();
    const { rerender } = render(
      <UiDesignCanvas {...props} panelVisible documentActive={false} />,
    );
    expect(addControl).not.toHaveBeenCalled();
    rerender(<UiDesignCanvas {...props} panelVisible documentActive />);
    expect(addControl).toHaveBeenCalled();
  });

  it("commits a widget drag once on pointer up", () => {
    createUiSurfaceMock.mockReturnValue({
      present: vi.fn(),
      setFrozen: vi.fn(),
      dispose: vi.fn(),
      host: {
        measureControls: () => ({}),
        clear: vi.fn(),
        addControl: vi.fn(),
        markAsDirty: vi.fn(),
      },
      resizeDesign: vi.fn(),
      resizeGizmos: vi.fn(),
      presentGizmos: vi.fn(),
      designAdt: { markAsDirty: vi.fn() },
      gizmoAdt: null,
    });
    const onLayoutChange = vi.fn();
    const props = hudCanvasProps();
    render(
      <UiDesignCanvas
        {...props}
        selectedId="stick"
        onLayoutChange={onLayoutChange}
      />,
    );
    const stick = screen.getByTestId("ui-widget-stick");
    dispatchPointerEvent(stick, "pointerdown", { clientX: 10, clientY: 10 });
    dispatchPointerEvent(stick, "pointermove", { clientX: 55, clientY: 10 });
    dispatchPointerEvent(stick, "pointermove", { clientX: 90, clientY: 12 });
    expect(onLayoutChange).not.toHaveBeenCalled();
    dispatchPointerEvent(stick, "pointerup", { clientX: 90, clientY: 12 });
    expect(onLayoutChange).toHaveBeenCalledTimes(1);
    const [id, layout] = onLayoutChange.mock.calls[0] as [
      string,
      { left: number },
    ];
    expect(id).toBe("stick");
    expect(layout.left).not.toBe(props.ui.widgets.stick?.layout.left);
    expect(uiHostStats.commit).toBe(1);
  });

  it("moves the widget under the pointer when selected handles overlap it", () => {
    createUiSurfaceMock.mockReturnValue(mockSurface());
    const ui = createDefaultUserInterface();
    const button = createWidget(
      "btn",
      "Button",
      "Play",
      pinLayout("left", "top", 160, 36, 40, 40),
    );
    const checkbox = createWidget(
      "box",
      "CheckBox",
      "On",
      pinLayout("left", "top", 28, 28, 400, 400),
    );
    ui.widgets.canvas!.children = ["btn", "box"];
    ui.widgets.btn = button;
    ui.widgets.box = checkbox;
    const viewport = {
      id: "desktop-16-9",
      width: 800,
      height: 600,
      safeArea: { left: 0, right: 0, top: 0, bottom: 0 },
    };
    const layout = layoutUserInterface(ui, viewport, {
      designSpace: true,
      safeArea: viewport.safeArea,
    });
    const onLayoutChange = vi.fn();
    render(
      <UiDesignCanvas
        ui={ui}
        viewport={viewport}
        layout={layout}
        controls={describeUiControls(ui, layout)}
        selectedId="box"
        view={{ zoom: 1, panX: 0, panY: 0 }}
        previewScale={1}
        bitmapScale={1}
        sharedEngine={{} as Engine}
        onSelect={() => {}}
        onViewChange={() => {}}
        onLayoutChange={onLayoutChange}
      />,
    );
    const host = screen.getByTestId("ui-design-viewport");
    dispatchPointerEvent(host, "pointerdown", { clientX: 120, clientY: 58 });
    dispatchPointerEvent(host, "pointermove", { clientX: 200, clientY: 58 });
    dispatchPointerEvent(host, "pointerup", { clientX: 200, clientY: 58 });
    expect(onLayoutChange).toHaveBeenCalledTimes(1);
    const [id, next] = onLayoutChange.mock.calls[0] as [
      string,
      { left: number; width: number; height: number },
    ];
    expect(id).toBe("btn");
    expect(next.left).toBeGreaterThan(button.layout.left);
    expect(next.width).toBe(160);
    expect(next.height).toBe(36);
  });

  it("moves a small selected widget from the center instead of resizing", () => {
    createUiSurfaceMock.mockReturnValue(mockSurface());
    const ui = createDefaultUserInterface();
    const button = createWidget(
      "btn",
      "Button",
      "Play",
      pinLayout("left", "top", 160, 36, 40, 40),
    );
    ui.widgets.canvas!.children = ["btn"];
    ui.widgets.btn = button;
    const viewport = {
      id: "desktop-16-9",
      width: 800,
      height: 600,
      safeArea: { left: 0, right: 0, top: 0, bottom: 0 },
    };
    const layout = layoutUserInterface(ui, viewport, {
      designSpace: true,
      safeArea: viewport.safeArea,
    });
    const onLayoutChange = vi.fn();
    render(
      <UiDesignCanvas
        ui={ui}
        viewport={viewport}
        layout={layout}
        controls={describeUiControls(ui, layout)}
        selectedId="btn"
        view={{ zoom: 1, panX: 0, panY: 0 }}
        previewScale={1}
        bitmapScale={1}
        sharedEngine={{} as Engine}
        onSelect={() => {}}
        onViewChange={() => {}}
        onLayoutChange={onLayoutChange}
      />,
    );
    const overlapping = screen.getByTestId("ui-resize-n");
    dispatchPointerEvent(overlapping, "pointerdown", { clientX: 120, clientY: 58 });
    dispatchPointerEvent(overlapping, "pointermove", { clientX: 200, clientY: 58 });
    dispatchPointerEvent(overlapping, "pointerup", { clientX: 200, clientY: 58 });
    expect(onLayoutChange).toHaveBeenCalledTimes(1);
    const [, next] = onLayoutChange.mock.calls[0] as [
      string,
      { left: number; width: number; height: number },
    ];
    expect(next.left).toBeGreaterThan(button.layout.left);
    expect(next.width).toBe(160);
    expect(next.height).toBe(36);
  });

  it("resizes from a corner handle that is outside the widget center", () => {
    createUiSurfaceMock.mockReturnValue(mockSurface());
    const ui = createDefaultUserInterface();
    const button = createWidget(
      "btn",
      "Button",
      "Play",
      pinLayout("left", "top", 160, 36, 40, 40),
    );
    ui.widgets.canvas!.children = ["btn"];
    ui.widgets.btn = button;
    const viewport = {
      id: "desktop-16-9",
      width: 800,
      height: 600,
      safeArea: { left: 0, right: 0, top: 0, bottom: 0 },
    };
    const layout = layoutUserInterface(ui, viewport, {
      designSpace: true,
      safeArea: viewport.safeArea,
    });
    const onLayoutChange = vi.fn();
    render(
      <UiDesignCanvas
        ui={ui}
        viewport={viewport}
        layout={layout}
        controls={describeUiControls(ui, layout)}
        selectedId="btn"
        view={{ zoom: 1, panX: 0, panY: 0 }}
        previewScale={1}
        bitmapScale={1}
        sharedEngine={{} as Engine}
        onSelect={() => {}}
        onViewChange={() => {}}
        onLayoutChange={onLayoutChange}
      />,
    );
    const corner = screen.getByTestId("ui-resize-se");
    dispatchPointerEvent(corner, "pointerdown", { clientX: 200, clientY: 76 });
    dispatchPointerEvent(corner, "pointermove", { clientX: 240, clientY: 96 });
    dispatchPointerEvent(corner, "pointerup", { clientX: 240, clientY: 96 });
    expect(onLayoutChange).toHaveBeenCalledTimes(1);
    const [, next] = onLayoutChange.mock.calls[0] as [
      string,
      { width: number; height: number },
    ];
    expect(next.width).toBeGreaterThan(160);
    expect(next.height).toBeGreaterThan(36);
  });

  it("surfaces missing texture chunk feedback instead of a silent blank Image", () => {
    createUiSurfaceMock.mockReturnValue(mockSurface());
    render(
      <UiDesignCanvas
        {...hudCanvasProps()}
        imageIssues={[
          { guid: "tex-1", reason: "missing-chunk" },
        ]}
      />,
    );
    const issue = screen.getByTestId("ui-image-issue");
    expect(issue.textContent).toMatch(/tex-1/i);
    expect(issue.textContent).toMatch(/chunk/i);
  });
});

function dispatchPointerEvent(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  init: {
    pointerId?: number;
    pointerType?: "touch" | "mouse" | "pen";
    clientX?: number;
    clientY?: number;
  } = {},
): void {
  const {
    pointerId = 1,
    pointerType = "touch",
    clientX = 0,
    clientY = 0,
  } = init;
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
  });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  target.dispatchEvent(event);
}
