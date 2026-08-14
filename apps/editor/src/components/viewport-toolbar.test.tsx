import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createDefaultScene, type SerializedScene } from "@babylonslate/core";
import { TooltipProvider } from "@babylonslate/ui/components/tooltip";
import { ViewportToolbar } from "./viewport-toolbar";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const harness = vi.hoisted(() => ({
  gizmoTool: "translate" as const,
  setGizmoTool: vi.fn(),
  snapEnabled: false,
  setSnapEnabled: vi.fn(),
  joystickEnabled: false,
  setJoystickEnabled: vi.fn(),
  gridVisible: true,
  setGridVisible: vi.fn(),
  dragSelectActive: false,
  setDragSelectActive: vi.fn(),
  viewportMode: "3d" as const,
  setViewportMode: vi.fn(),
  previewGameCamera: false,
  setPreviewGameCamera: vi.fn(),
  scene: null as SerializedScene | null,
  applySceneChange: vi.fn(async () => true),
}));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({
    documentId: "scene:assets/Main.scene.babasset",
  }),
}));

vi.mock("../context/scene-editing-context", () => ({
  useSceneEditing: () => ({
    gizmoTool: harness.gizmoTool,
    setGizmoTool: harness.setGizmoTool,
    snapEnabled: harness.snapEnabled,
    setSnapEnabled: harness.setSnapEnabled,
    joystickEnabled: harness.joystickEnabled,
    setJoystickEnabled: harness.setJoystickEnabled,
    gridVisible: harness.gridVisible,
    setGridVisible: harness.setGridVisible,
    dragSelectActive: harness.dragSelectActive,
    setDragSelectActive: harness.setDragSelectActive,
    viewportMode: harness.viewportMode,
    setViewportMode: harness.setViewportMode,
    previewGameCamera: harness.previewGameCamera,
    setPreviewGameCamera: harness.setPreviewGameCamera,
  }),
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openDocuments: [
      {
        id: "scene:assets/Main.scene.babasset",
        ref: {
          kind: "scene",
          path: "assets/Main.scene.babasset",
          label: "Main Scene",
        },
        content: harness.scene,
        layout: null,
        dirty: false,
      },
    ],
    applySceneChange: harness.applySceneChange,
  }),
}));

beforeEach(() => {
  harness.gizmoTool = "translate";
  harness.snapEnabled = false;
  harness.joystickEnabled = false;
  harness.gridVisible = true;
  harness.dragSelectActive = false;
  harness.viewportMode = "3d";
  harness.previewGameCamera = false;
  harness.scene = createDefaultScene();
  harness.setGizmoTool.mockClear();
  harness.setSnapEnabled.mockClear();
  harness.setJoystickEnabled.mockClear();
  harness.setGridVisible.mockClear();
  harness.setDragSelectActive.mockClear();
  harness.setViewportMode.mockClear();
  harness.setPreviewGameCamera.mockClear();
  harness.applySceneChange.mockClear();
});

afterEach(() => {
  cleanup();
});

function renderToolbar(props: { showDragSelect?: boolean } = {}) {
  return render(
    <TooltipProvider>
      <ViewportToolbar {...props} />
    </TooltipProvider>,
  );
}

describe("ViewportToolbar", () => {
  it("exposes Drag Select beside gizmo tools and hides snap on the island", () => {
    renderToolbar();
    expect(screen.getByTestId("viewport-drag-select")).toBeTruthy();
    expect(screen.getByTestId("viewport-settings")).toBeTruthy();
    expect(screen.queryByTestId("gizmo-snap-toggle")).toBeNull();
    expect(screen.queryByTestId("gizmo-joystick-toggle")).toBeNull();
  });

  it("opens a settings menu with Snap, Show Grid, Joystick, and Game Camera", () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("viewport-settings"));
    expect(screen.getByTestId("gizmo-snap-toggle")).toBeTruthy();
    expect(screen.getByTestId("viewport-show-grid-toggle")).toBeTruthy();
    expect(screen.getByTestId("gizmo-joystick-toggle")).toBeTruthy();
    expect(screen.getByTestId("viewport-game-camera-toggle")).toBeTruthy();
  });

  it("arms Drag Select without changing the gizmo tool", () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("viewport-drag-select"));
    expect(harness.setDragSelectActive).toHaveBeenCalledWith(true);
    expect(harness.setGizmoTool).not.toHaveBeenCalled();
  });

  it("hides Drag Select when the prefab viewport asks it off", () => {
    renderToolbar({ showDragSelect: false });
    expect(screen.queryByTestId("viewport-drag-select")).toBeNull();
    expect(screen.getByTestId("viewport-settings")).toBeTruthy();
  });
});
