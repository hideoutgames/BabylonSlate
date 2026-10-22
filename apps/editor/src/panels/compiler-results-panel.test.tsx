import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  WINDOWED_LIST_TOUCH_ROW_HEIGHT,
  WINDOWED_SLICE_OVERSCAN,
} from "@haptic/editor-kit";
import type { Diagnostic } from "@haptic/scripting";
import { CompilerResultsPanel } from "./compiler-results-panel";

const selectActor = vi.hoisted(() => vi.fn());
const setDiagnostics = vi.hoisted(() => vi.fn());
const setFocusDiagnostic = vi.hoisted(() => vi.fn());
const setActiveDocument = vi.hoisted(() => vi.fn());
const clearFocusedNode = vi.hoisted(() => vi.fn());
const pairingWarning: Diagnostic = {
  severity: "warning",
  code: "physics.body_without_collider",
  message: "Rigid Body needs a Collider on the same actor.",
  assetGuid: "assets/Main.scene.hasset",
  graphId: "scene:assets/Main.scene.hasset",
  actorId: "hero",
  componentId: "rb",
};
const diagnostics = vi.hoisted(() => ({
  current: [] as Diagnostic[],
}));
const scene = vi.hoisted(() => ({ physicsWorld: "3d" as "2d" | "3d" }));
// A Model with no simple collision shapes, and one with a shape.
const registry = vi.hoisted(() => ({
  getByGuid: (guid: string) => guid === "hollow" || guid === "solid"
    ? { path: `assets/${guid}.model.hasset`, header: { type: "Model", payload: { simpleColliders: guid === "solid" ? [{ id: "box" }] : [] } } }
    : undefined,
}));
diagnostics.current = [pairingWarning];

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({
    documentId: "scene:assets/Main.scene.hasset",
  }),
  useOptionalDocumentWorkspace: () => ({
    documentId: "scene:assets/Main.scene.hasset",
  }),
}));

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: [
    {
      id: "scene:assets/Main.scene.hasset",
      ref: {
        kind: "scene",
        path: "assets/Main.scene.hasset",
        label: "Main",
      },
      content: {
        name: "Main",
        settings: {
          get physicsWorld() {
            return scene.physicsWorld;
          },
        },
        actors: [
          {
            id: "hero",
            components: [{ id: "rb", classId: "RigidBodyComponent" }],
          },
          { id: "statue", components: [{ id: "mesh", classId: "MeshComponent", properties: { collisionMode: "simple", assetGuid: "hollow" } }] },
          { id: "crate", components: [{ id: "mesh", classId: "MeshComponent", properties: { collisionMode: "simple", assetGuid: "solid" } }] },
          // Nonuniform parent scale: a quarter-turned child stays shear-free,
          // a 45 degree child is sheared.
          { id: "arm", parentId: null, components: [], transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [2, 1, 1] } },
          { id: "wrist", parentId: "arm", components: [], transform: { position: [0, 0, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], scale: [1, 1, 1] } },
          { id: "hand", parentId: "arm", components: [], transform: { position: [1, 0, 0], rotation: [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)], scale: [1, 1, 1] } },
        ],
      },
    },
    {
      id: "graph:assets/Hero.class.hasset",
      ref: { kind: "graph", path: "assets/Hero.class.hasset", label: "Hero" },
      content: { nodes: [], edges: [] },
    },
  ],
  setActiveDocument,
  assetRegistry: registry,
  activeDocumentId: "scene:assets/Main.scene.hasset",
})));

vi.mock("../context/validation-context", () => ({
  useValidation: () => ({
    diagnostics: diagnostics.current,
    setDiagnostics,
    setFocusDiagnostic,
  }),
}));

vi.mock("../context/play-context", () => ({
  usePlay: () => ({ clearFocusedNode }),
}));

vi.mock("../context/scene-editing-context", () => ({
  useOptionalSceneEditing: () => ({ selectActor }),
}));

const VIEWPORT = '[data-slot="scroll-area-viewport"]';

function stubScrollViewportHeight(height: number): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      if ((this as HTMLElement).matches?.(VIEWPORT)) {
        return height;
      }
      return descriptor?.get?.call(this) ?? 0;
    },
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, "clientHeight", descriptor);
    }
  };
}

afterEach(() => {
  cleanup();
  selectActor.mockClear();
  setDiagnostics.mockClear();
  setFocusDiagnostic.mockClear();
  setActiveDocument.mockClear();
  clearFocusedNode.mockClear();
  diagnostics.current = [pairingWarning];
  scene.physicsWorld = "3d";
});

describe("CompilerResultsPanel", () => {
  it("reveals and copies the complete selected diagnostic while retaining navigation", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      render(<CompilerResultsPanel {...({} as IDockviewPanelProps)} />);
      fireEvent.click(screen.getByTestId("compiler-result-row"));
      const details = within(screen.getByRole("region", { name: "Diagnostic Details" }));
      expect(details.getByText(/Rigid Body needs a Collider on the same actor/)).toBeTruthy();
      fireEvent.click(details.getByRole("button", { name: "Copy" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining(pairingWarning.message)));
      expect(selectActor).toHaveBeenCalledWith("hero");
    } finally {
      if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });
  it("publishes the active scene's pairing and sheared transform warnings", () => {
    render(<CompilerResultsPanel {...({} as IDockviewPanelProps)} />);
    const published = setDiagnostics.mock.lastCall![0] as Diagnostic[];
    expect(published.map(({ code, actorId, severity }) => ({ code, actorId, severity }))).toEqual([
      { code: "physics.body_without_collider", actorId: "hero", severity: "warning" },
      { code: "physics.mesh_collision_empty", actorId: "statue", severity: "warning" },
      { code: "scene.sheared_actor_transform", actorId: "hand", severity: "warning" },
    ]);
  });

  it("reports Mesh collision a 2D scene ignores instead of the Model's missing shapes", () => {
    scene.physicsWorld = "2d";
    render(<CompilerResultsPanel {...({} as IDockviewPanelProps)} />);
    const published = setDiagnostics.mock.lastCall![0] as Diagnostic[];
    expect(published.filter((entry) => entry.code.startsWith("physics.mesh_")).map(({ code, actorId }) => ({ code, actorId }))).toEqual([
      { code: "physics.mesh_collision_2d", actorId: "statue" },
      { code: "physics.mesh_collision_2d", actorId: "crate" },
    ]);
  });

  it("selects the actor when a physics pairing warning is tapped", () => {
    render(<CompilerResultsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByTestId("compiler-result-row"));
    expect(selectActor).toHaveBeenCalledWith("hero");
    expect(setFocusDiagnostic).toHaveBeenCalled();
  });

  it("focuses the graph node when a diagnostic with a nodeId is tapped", () => {
    const graphDiagnostic: Diagnostic = {
      severity: "error",
      code: "graph.missing_exec",
      message: "Exec pin is not connected.",
      assetGuid: "assets/Hero.class.hasset",
      graphId: "graph:assets/Hero.class.hasset",
      nodeId: "tick",
    };
    diagnostics.current = [graphDiagnostic];
    render(<CompilerResultsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByTestId("compiler-result-row"));
    expect(setFocusDiagnostic).toHaveBeenCalledWith(graphDiagnostic, graphDiagnostic.graphId);
    expect(setActiveDocument).toHaveBeenCalledWith(graphDiagnostic.graphId);
    expect(clearFocusedNode).toHaveBeenCalled();
  });

  it("windows a large diagnostic set to the viewport plus overscan", () => {
    diagnostics.current = Array.from({ length: 200 }, (_, i) => ({
      severity: "error" as const,
      code: `graph.error.${i}`,
      message: `Diagnostic ${i}`,
      assetGuid: "assets/Mannequin.class.hasset",
      graphId: "class:assets/Mannequin.class.hasset",
      nodeId: `n${i}`,
    }));
    const restore = stubScrollViewportHeight(440);
    try {
      render(<CompilerResultsPanel {...({} as IDockviewPanelProps)} />);
      const mounted = screen.getAllByTestId("compiler-result-row");
      expect(mounted.length).toBeGreaterThan(0);
      expect(mounted.length).toBeLessThan(40);
      expect(mounted.length).toBeLessThanOrEqual(
        Math.ceil(440 / WINDOWED_LIST_TOUCH_ROW_HEIGHT) +
          WINDOWED_SLICE_OVERSCAN * 2,
      );
      expect(screen.queryByText(/Diagnostic 0/)).toBeTruthy();
      expect(screen.queryByText(/Diagnostic 199/)).toBeNull();
    } finally {
      restore();
    }
  });
});
