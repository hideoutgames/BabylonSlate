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
  gizmoTool: "translate" as "translate" | "rotate" | "scale",
  setGizmoTool: vi.fn(),
  snapEnabled: false,
  setSnapEnabled: vi.fn(),
  joystickEnabled: false,
  setJoystickEnabled: vi.fn(),
  gridVisible: true,
  setGridVisible: vi.fn(),
  navmeshVisible: false,
  setNavmeshVisible: vi.fn(),
  collisionsVisible: false,
  setCollisionsVisible: vi.fn(),
  dragSelectActive: false,
  setDragSelectActive: vi.fn(),
  viewportMode: "3d" as const,
  setViewportMode: vi.fn(),
  previewGameCamera: false,
  setPreviewGameCamera: vi.fn(),
  pivotAroundCenter: false,
  setPivotAroundCenter: vi.fn(),
  viewportShadingMode: "pbr" as "pbr" | "unlit" | "wireframe",
  setViewportShadingMode: vi.fn(),
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
    navmeshVisible: harness.navmeshVisible,
    setNavmeshVisible: harness.setNavmeshVisible,
    collisionsVisible: harness.collisionsVisible,
    setCollisionsVisible: harness.setCollisionsVisible,
    dragSelectActive: harness.dragSelectActive,
    setDragSelectActive: harness.setDragSelectActive,
    viewportMode: harness.viewportMode,
    setViewportMode: harness.setViewportMode,
    previewGameCamera: harness.previewGameCamera,
    setPreviewGameCamera: harness.setPreviewGameCamera,
    pivotAroundCenter: harness.pivotAroundCenter,
    setPivotAroundCenter: harness.setPivotAroundCenter,
    viewportShadingMode: harness.viewportShadingMode,
    setViewportShadingMode: harness.setViewportShadingMode,
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
  harness.navmeshVisible = false;
  harness.collisionsVisible = false;
  harness.dragSelectActive = false;
  harness.viewportMode = "3d";
  harness.previewGameCamera = false;
  harness.pivotAroundCenter = false;
  harness.viewportShadingMode = "pbr";
  harness.scene = createDefaultScene();
  harness.setGizmoTool.mockClear();
  harness.setSnapEnabled.mockClear();
  harness.setJoystickEnabled.mockClear();
  harness.setGridVisible.mockClear();
  harness.setNavmeshVisible.mockClear();
  harness.setCollisionsVisible.mockClear();
  harness.setDragSelectActive.mockClear();
  harness.setViewportMode.mockClear();
  harness.setPreviewGameCamera.mockClear();
  harness.setPivotAroundCenter.mockClear();
  harness.setViewportShadingMode.mockClear();
  harness.applySceneChange.mockClear();
});

afterEach(() => {
  cleanup();
});

function renderToolbar(
  props: {
    showDragSelect?: boolean;
    showViewportModeToggle?: boolean;
    showGizmoTools?: boolean;
  } = {},
) {
  return render(
    <TooltipProvider>
      <ViewportToolbar {...props} />
    </TooltipProvider>,
  );
}

const GIZMO_LABELS = [
  { id: "translate", label: "Move" },
  { id: "rotate", label: "Rotate" },
  { id: "scale", label: "Scale" },
] as const;

describe("ViewportToolbar", () => {
  it.each(GIZMO_LABELS)(
    "shows $label only on the enabled $id gizmo",
    ({ id }) => {
      harness.gizmoTool = id;
      renderToolbar();
      for (const tool of GIZMO_LABELS) {
        const button = screen.getByTestId(`gizmo-tool-${tool.id}`);
        if (tool.id === id) {
          const label = button.querySelector(
            '[data-testid="gizmo-tool-label"]',
          ) as HTMLElement | null;
          expect(label?.style.gridTemplateColumns).toBe("1fr");
          expect(button.textContent).toContain(tool.label);
        } else {
          const label = button.querySelector(
            '[data-testid="gizmo-tool-label"]',
          ) as HTMLElement | null;
          expect(label?.style.gridTemplateColumns).toBe("0fr");
        }
      }
    },
  );

  it("keeps Drag Select and Viewport Settings icon-only", () => {
    renderToolbar();
    expect(screen.getByTestId("viewport-drag-select").textContent).not.toContain(
      "Drag Select",
    );
    expect(screen.getByTestId("viewport-settings").textContent).not.toContain(
      "Viewport Settings",
    );
    expect(screen.getByTestId("viewport-mode-3d").textContent).toContain("3D");
    expect(screen.getByTestId("viewport-mode-2d").textContent).toContain("2D");
  });

  it("exposes Drag Select beside gizmo tools and hides snap on the island", () => {
    renderToolbar();
    expect(screen.getByTestId("viewport-drag-select")).toBeTruthy();
    expect(screen.getByTestId("viewport-settings")).toBeTruthy();
    expect(screen.queryByTestId("gizmo-snap-toggle")).toBeNull();
    expect(screen.queryByTestId("gizmo-joystick-toggle")).toBeNull();
  });

  it("opens a settings menu with Viewport Mode, Snap, Show Grid, Show Navmesh, Show Collisions, Joystick, Pivot Around Center, Game Camera, and Settings", () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("viewport-settings"));
    expect(screen.getByTestId("viewport-shading-mode")).toBeTruthy();
    expect(screen.getByTestId("gizmo-snap-toggle")).toBeTruthy();
    expect(screen.getByTestId("viewport-show-grid-toggle")).toBeTruthy();
    expect(screen.getByTestId("viewport-show-navmesh-toggle")).toBeTruthy();
    expect(screen.getByTestId("viewport-show-collisions-toggle")).toBeTruthy();
    expect(
      screen
        .getByTestId("viewport-show-collisions-toggle")
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.getByTestId("gizmo-joystick-toggle")).toBeTruthy();
    expect(screen.getByTestId("viewport-pivot-around-center-toggle")).toBeTruthy();
    expect(screen.getByTestId("viewport-game-camera-toggle")).toBeTruthy();
    expect(screen.getByTestId("viewport-settings-submenu")).toBeTruthy();
  });

  it("opens Grid Size from Settings with the saved scene tile size", () => {
    harness.scene = {
      ...createDefaultScene(),
      settings: {
        ...createDefaultScene().settings,
        grid: { ...createDefaultScene().settings.grid, tileSize: 2 },
      },
    };
    renderToolbar();
    fireEvent.click(screen.getByTestId("viewport-settings"));
    fireEvent.click(screen.getByTestId("viewport-settings-submenu"));
    fireEvent.click(screen.getByTestId("viewport-grid-size"));
    expect(screen.getByTestId("viewport-grid-size-dialog")).toBeTruthy();
    expect(screen.getByTestId("number-prompt-input")).toHaveProperty(
      "value",
      "2",
    );
  });

  it("writes Grid Size to tileSize and snapTranslate", () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("viewport-settings"));
    fireEvent.click(screen.getByTestId("viewport-settings-submenu"));
    fireEvent.click(screen.getByTestId("viewport-grid-size"));
    fireEvent.change(screen.getByTestId("number-prompt-input"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByTestId("number-prompt-confirm"));
    expect(harness.applySceneChange).toHaveBeenCalledWith(
      "scene:assets/Main.scene.babasset",
      expect.objectContaining({
        settings: expect.objectContaining({
          grid: expect.objectContaining({
            tileSize: 4,
            snapTranslate: 4,
          }),
        }),
      }),
    );
  });

  it("sizes the island menu wider than the gear trigger", () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("viewport-settings"));
    const classes = screen.getByTestId("viewport-settings-menu").className;
    expect(classes).toContain("w-max");
    expect(classes).toContain("min-w-56");
    expect(classes).not.toContain("w-(--anchor-width)");
  });

  it("persists Show Navmesh onto the scene document", () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("viewport-settings"));
    fireEvent.click(screen.getByTestId("viewport-show-navmesh-toggle"));
    expect(harness.setNavmeshVisible).toHaveBeenCalledWith(true);
    expect(harness.applySceneChange).toHaveBeenCalledWith(
      "scene:assets/Main.scene.babasset",
      expect.objectContaining({
        settings: expect.objectContaining({ showNavmesh: true }),
      }),
    );
  });

  it("toggles Show Collisions without writing the scene document", () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("viewport-settings"));
    fireEvent.click(screen.getByTestId("viewport-show-collisions-toggle"));
    expect(harness.setCollisionsVisible).toHaveBeenCalledWith(true);
    expect(harness.applySceneChange).not.toHaveBeenCalled();
  });

  it("toggles Pivot Around Center without writing the scene document", () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("viewport-settings"));
    fireEvent.click(screen.getByTestId("viewport-pivot-around-center-toggle"));
    expect(harness.setPivotAroundCenter).toHaveBeenCalledWith(true);
    expect(harness.applySceneChange).not.toHaveBeenCalled();
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

  it("hides the 3D / 2D toggle on SceneLayer viewports", () => {
    renderToolbar({ showViewportModeToggle: false });
    expect(screen.queryByTestId("viewport-mode-toggle")).toBeNull();
    expect(screen.getByTestId("viewport-settings")).toBeTruthy();
  });

  it("hides Move / Rotate / Scale when showGizmoTools is false", () => {
    renderToolbar({ showGizmoTools: false });
    expect(screen.queryByTestId("gizmo-tool-translate")).toBeNull();
    expect(screen.queryByTestId("gizmo-tool-rotate")).toBeNull();
    expect(screen.queryByTestId("gizmo-tool-scale")).toBeNull();
    expect(screen.getByTestId("viewport-drag-select")).toBeTruthy();
    expect(screen.getByTestId("viewport-settings")).toBeTruthy();
  });

  it("opens Viewport Mode radios and keeps PBR selected by default", () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("viewport-settings"));
    fireEvent.click(screen.getByTestId("viewport-shading-mode"));
    expect(screen.getByTestId("viewport-shading-pbr").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByTestId("viewport-shading-unlit")).toBeTruthy();
    expect(screen.getByTestId("viewport-shading-wireframe")).toBeTruthy();
    expect(screen.queryByTestId("viewport-shading-points-cloud")).toBeNull();
    expect(screen.getByTestId("viewport-mode-toggle").getAttribute("aria-label")).toBe(
      "2D / 3D",
    );
  });

  it("sets Unlit shading without writing the scene document", () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("viewport-settings"));
    fireEvent.click(screen.getByTestId("viewport-shading-mode"));
    fireEvent.click(screen.getByTestId("viewport-shading-unlit"));
    expect(harness.setViewportShadingMode).toHaveBeenCalledWith("unlit");
    expect(harness.applySceneChange).not.toHaveBeenCalled();
  });
});
