import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createDefaultScene, type SerializedScene } from "@babylonslate/core";
import { TooltipProvider } from "@babylonslate/ui/components/tooltip";
import { ViewportToolbar } from "./viewport-toolbar";

if (
  typeof window !== "undefined" &&
  typeof window.PointerEvent === "undefined"
) {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: PointerEventInit) {
      super(type, init);
      Object.defineProperties(this, {
        pointerId: { value: init?.pointerId ?? 1 },
        pointerType: { value: init?.pointerType ?? "mouse" },
        isPrimary: { value: init?.isPrimary ?? true },
      });
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
  viewportMode: "3d" as "2d" | "3d",
  setViewportMode: vi.fn(),
  previewGameCamera: false,
  setPreviewGameCamera: vi.fn(),
  pivotAroundCenter: false,
  setPivotAroundCenter: vi.fn(),
  viewportShadingMode: "pbr" as "pbr" | "unlit" | "wireframe",
  setViewportShadingMode: vi.fn(),
  scene: null as SerializedScene | null,
  documentKind: "scene" as "scene" | "scene-layer" | "graph",
  gridSize: 1,
  snapRotateDeg: 15,
  snapScale: 0.25,
  patchPrefs: vi.fn(async () => {}),
  applySceneChange: vi.fn(async () => true),
}));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({
    documentId: "scene:assets/Main.scene.babasset",
  }),
}));

vi.mock("../lib/viewport-engine-prefs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/viewport-engine-prefs")>()),
  patchEngineViewportPrefs: harness.patchPrefs,
  useEditorViewportPrefs: () => ({
    gridSize: harness.gridSize,
    snapRotateDeg: harness.snapRotateDeg,
    snapScale: harness.snapScale,
    flySpeed: 8,
    editorTextureLodEnabled: true,
    editorTextureLodQuality: 1,
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
          kind: harness.documentKind,
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
  harness.documentKind = "scene";
  harness.gridSize = 1;
  harness.snapRotateDeg = 15;
  harness.snapScale = 0.25;
  harness.patchPrefs.mockClear();
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
  vi.useRealTimers();
});

function renderToolbar(
  props: {
    testIdPrefix?: string;
    showDragSelect?: boolean;
    showViewportModeToggle?: boolean;
    showGizmoTools?: boolean;
    onDrop?: () => void;
    dropDisabled?: boolean;
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
  it("opens snap settings by right-click without toggling, and Cancel discards edits", () => {
    harness.scene!.settings.grid.snapRotateDeg = 45;
    harness.scene!.settings.grid.snapScale = 0.1;
    renderToolbar();
    const snap = screen.getByTestId("gizmo-snap-toggle");
    fireEvent.contextMenu(snap);
    expect(screen.getByLabelText("Rotation Snap (Degrees)")).toHaveProperty("value", "45");
    expect(screen.getByLabelText("Scale Snap")).toHaveProperty("value", "0.1");
    fireEvent.change(screen.getByLabelText("Scale Snap"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(harness.setSnapEnabled).not.toHaveBeenCalled();
    expect(harness.applySceneChange).not.toHaveBeenCalled();
    fireEvent.contextMenu(snap);
    expect(screen.getByLabelText("Scale Snap")).toHaveProperty("value", "0.1");
  });

  it("opens on a stationary touch hold and consumes its release click", () => {
    vi.useFakeTimers();
    renderToolbar();
    const snap = screen.getByTestId("gizmo-snap-toggle");
    fireEvent.pointerDown(snap, { pointerType: "touch", pointerId: 4, clientX: 20, clientY: 20 });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.pointerUp(snap, { pointerType: "touch", pointerId: 4 });
    fireEvent.click(snap);
    expect(harness.setSnapEnabled).not.toHaveBeenCalled();
    expect(harness.applySceneChange).not.toHaveBeenCalled();
  });

  it.each(["move", "cancel", "release", "scroll", "unmount"])("cancels a pending hold on %s", (reason) => {
    vi.useFakeTimers();
    const { unmount } = renderToolbar();
    const snap = screen.getByTestId("gizmo-snap-toggle");
    fireEvent.pointerDown(snap, { pointerType: "touch", pointerId: 4, clientX: 20, clientY: 20 });
    if (reason === "move") fireEvent.pointerMove(document, { pointerId: 4, clientX: 40, clientY: 20 });
    if (reason === "cancel") fireEvent.pointerCancel(document, { pointerId: 4 });
    if (reason === "release") fireEvent.pointerUp(document, { pointerId: 4 });
    if (reason === "scroll") fireEvent.scroll(document);
    if (reason === "unmount") unmount();
    act(() => vi.advanceTimersByTime(600));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(harness.setSnapEnabled).not.toHaveBeenCalled();
  });

  it("saves prefab snap steps to editor preferences without changing a scene", () => {
    harness.documentKind = "graph";
    harness.snapRotateDeg = 60;
    harness.snapScale = 0.2;
    renderToolbar({ testIdPrefix: "prefab-" });
    fireEvent.contextMenu(screen.getByTestId("prefab-gizmo-snap-toggle"));
    expect(screen.getByLabelText("Rotation Snap (Degrees)")).toHaveProperty("value", "60");
    fireEvent.change(screen.getByLabelText("Grid Size"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Rotation Snap (Degrees)"), { target: { value: "45" } });
    fireEvent.change(screen.getByLabelText("Scale Snap"), { target: { value: "0.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(harness.patchPrefs).toHaveBeenCalledWith({ viewportGridSize: 2, viewportSnapRotateDeg: 45, viewportSnapScale: 0.5 });
    expect(harness.applySceneChange).not.toHaveBeenCalled();
  });


  it("exposes current snap increment and nondefault view state without opening settings", () => {
    harness.snapEnabled = true;
    harness.previewGameCamera = true;
    harness.viewportShadingMode = "wireframe";
    harness.scene!.settings.grid.snapTranslate = 2;
    harness.scene!.settings.grid.snapEnabled = true;
    renderToolbar();
    const snap = screen.getByRole("button", { name: "Snap Grid" });
    expect(snap.textContent).toBe("2");
    expect(snap.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Wireframe")).toBeTruthy();
    expect(screen.getByText("Game Camera")).toBeTruthy();
    fireEvent.click(snap);
    expect(harness.setSnapEnabled).toHaveBeenCalledWith(false);
    expect(harness.applySceneChange).toHaveBeenCalledWith(
      "scene:assets/Main.scene.babasset",
      expect.objectContaining({
        settings: expect.objectContaining({
          grid: expect.objectContaining({ snapEnabled: false }),
        }),
      }),
    );
  });

  it("shows the prefab translation increment from editor grid preferences", () => {
    harness.documentKind = "graph";
    harness.scene = null;
    harness.gridSize = 4;
    renderToolbar();
    expect(screen.getByRole("button", { name: "Snap Grid" }).textContent).toBe(
      "4",
    );
  });

  it("shows 2D tile snapping and the selected tool increment", () => {
    harness.viewportMode = "2d";
    harness.scene!.settings.grid.tileSize = 3;
    harness.scene!.settings.grid.snapTranslate = 99;
    harness.scene!.settings.grid.snapRotateDeg = 30;
    harness.scene!.settings.grid.snapScale = 0.5;
    const { rerender } = renderToolbar();
    expect(screen.getByRole("button", { name: "Snap Grid" }).textContent).toBe(
      "3",
    );
    harness.gizmoTool = "rotate";
    rerender(
      <TooltipProvider>
        <ViewportToolbar />
      </TooltipProvider>,
    );
    expect(screen.getByRole("button", { name: "Snap Grid" }).textContent).toBe(
      "30°",
    );
    harness.gizmoTool = "scale";
    rerender(
      <TooltipProvider>
        <ViewportToolbar />
      </TooltipProvider>,
    );
    expect(screen.getByRole("button", { name: "Snap Grid" }).textContent).toBe(
      "0.5",
    );
  });

  it.each(GIZMO_LABELS)(
    "selects the $label gizmo from its named tool",
    ({ id, label }) => {
      harness.gizmoTool = id === "translate" ? "rotate" : "translate";
      renderToolbar();
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(harness.setGizmoTool).toHaveBeenCalledWith(id);
    },
  );

  it("keeps Drag Select and Viewport Settings icon-only", () => {
    renderToolbar();
    expect(
      screen.getByTestId("viewport-drag-select").textContent,
    ).not.toContain("Drag Select");
    expect(screen.getByTestId("viewport-settings").textContent).not.toContain(
      "Viewport Settings",
    );
    expect(screen.getByTestId("viewport-mode-toggle").textContent).toBe("3D");
  });

  it("toggles viewport mode in both directions with one current-mode button", () => {
    const { rerender } = renderToolbar();
    const mode = screen.getByRole("button", {
      name: "3D Viewport; Switch To 2D",
    });
    fireEvent.click(mode);
    expect(harness.setViewportMode).toHaveBeenCalledWith("2d");
    expect(harness.applySceneChange).toHaveBeenLastCalledWith(
      "scene:assets/Main.scene.babasset",
      expect.objectContaining({ viewportMode: "2d" }),
    );

    harness.viewportMode = "2d";
    harness.scene!.viewportMode = "2d";
    rerender(
      <TooltipProvider>
        <ViewportToolbar />
      </TooltipProvider>,
    );
    expect(mode.textContent).toBe("2D");
    expect(mode.getAttribute("aria-label")).toBe("2D Viewport; Switch To 3D");
    fireEvent.click(mode);
    expect(harness.setViewportMode).toHaveBeenLastCalledWith("3d");
    expect(harness.applySceneChange).toHaveBeenLastCalledWith(
      "scene:assets/Main.scene.babasset",
      expect.objectContaining({ viewportMode: "3d" }),
    );
  });

  it("places Snap Grid before Drag Select and Drop immediately before settings", () => {
    const onDrop = vi.fn();
    renderToolbar({ onDrop, dropDisabled: false });
    const tools = within(screen.getByTestId("viewport-toolbar"))
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    const snapIndex = tools.indexOf("Snap Grid");
    expect(snapIndex).toBeGreaterThanOrEqual(0);
    expect(tools.slice(snapIndex, snapIndex + 4)).toEqual([
      "Snap Grid",
      "Drag Select",
      "Drop",
      "Viewport Settings",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Drop" }));
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(harness.setDragSelectActive).not.toHaveBeenCalled();
    expect(screen.queryByTestId("gizmo-joystick-toggle")).toBeNull();
  });

  it.each(["scene", "scene-layer"] as const)(
    "toggles Snap Grid directly and persists it in a %s document",
    (documentKind) => {
      harness.documentKind = documentKind;
      renderToolbar();
      const snap = screen.getByRole("button", { name: "Snap Grid" });
      expect(snap.getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(snap);
      expect(harness.setSnapEnabled).toHaveBeenCalledWith(true);
      expect(harness.applySceneChange).toHaveBeenCalledWith(
        "scene:assets/Main.scene.babasset",
        expect.objectContaining({
          settings: expect.objectContaining({
            grid: expect.objectContaining({ snapEnabled: true }),
          }),
        }),
      );
    },
  );

  it("shows prefab Snap Grid pressed and disables it without writing a scene", () => {
    harness.documentKind = "graph";
    harness.snapEnabled = true;
    renderToolbar({ testIdPrefix: "prefab-", showDragSelect: false });
    const snap = screen.getByTestId("prefab-gizmo-snap-toggle");
    expect(snap.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(snap);
    expect(harness.setSnapEnabled).toHaveBeenCalledWith(false);
    expect(harness.applySceneChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Drop" })).toBeNull();
  });

  it.each([undefined, true])(
    "blocks Drop when dropDisabled is %s",
    (dropDisabled) => {
      const onDrop = vi.fn();
      renderToolbar({
        testIdPrefix: "prefab-",
        showDragSelect: false,
        onDrop,
        dropDisabled,
      });
      const drop = screen.getByRole("button", { name: "Drop" });
      expect(drop).toHaveProperty("disabled", true);
      fireEvent.click(drop);
      expect(onDrop).not.toHaveBeenCalled();
    },
  );

  it("opens a settings menu with Viewport Mode, Show Grid, Show Navmesh, Show Collisions, Joystick, Pivot Around Center, Game Camera, and Settings", () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("viewport-settings"));
    expect(screen.getByTestId("viewport-shading-mode")).toBeTruthy();
    expect(
      within(screen.getByTestId("viewport-settings-menu")).queryByTestId(
        "gizmo-snap-toggle",
      ),
    ).toBeNull();
    expect(screen.getByTestId("viewport-show-grid-toggle")).toBeTruthy();
    expect(screen.getByTestId("viewport-show-navmesh-toggle")).toBeTruthy();
    expect(screen.getByTestId("viewport-show-collisions-toggle")).toBeTruthy();
    expect(
      screen
        .getByTestId("viewport-show-collisions-toggle")
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.getByTestId("gizmo-joystick-toggle")).toBeTruthy();
    expect(
      screen.getByTestId("viewport-pivot-around-center-toggle"),
    ).toBeTruthy();
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

  it("saves all snap steps together, including arithmetic on Enter", () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("viewport-settings"));
    fireEvent.click(screen.getByTestId("viewport-settings-submenu"));
    fireEvent.click(screen.getByTestId("viewport-grid-size"));
    fireEvent.change(screen.getByTestId("number-prompt-input"), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByTestId("scale-snap-input"), { target: { value: "0.5" } });
    fireEvent.change(screen.getByTestId("rotation-snap-input"), { target: { value: "30/2" } });
    fireEvent.keyDown(screen.getByTestId("rotation-snap-input"), { key: "Enter" });
    expect(harness.applySceneChange).toHaveBeenCalledWith(
      "scene:assets/Main.scene.babasset",
      expect.objectContaining({
        settings: expect.objectContaining({
          grid: expect.objectContaining({
            tileSize: 4,
            snapTranslate: 4,
            snapRotateDeg: 15,
            snapScale: 0.5,
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
    expect(
      screen.getByTestId("viewport-shading-pbr").getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByTestId("viewport-shading-unlit")).toBeTruthy();
    expect(screen.getByTestId("viewport-shading-wireframe")).toBeTruthy();
    expect(screen.queryByTestId("viewport-shading-points-cloud")).toBeNull();
    expect(
      screen.getByTestId("viewport-mode-toggle").getAttribute("aria-label"),
    ).toBe("3D Viewport; Switch To 2D");
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
