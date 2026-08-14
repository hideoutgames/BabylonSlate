import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Engine } from "@babylonjs/core";
import {
  createDefaultPlayHud,
  describeUiControls,
  layoutUserInterface,
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
    const present = vi.fn(() => {
      throw new Error("ADT blit size is 0");
    });
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
    expect(screen.queryByTestId("ui-gui-preview-error")).toBeNull();
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
});
