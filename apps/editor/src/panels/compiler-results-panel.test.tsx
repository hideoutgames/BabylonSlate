import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  WINDOWED_LIST_TOUCH_ROW_HEIGHT,
  WINDOWED_SLICE_OVERSCAN,
} from "@babylonslate/editor-kit";
import type { Diagnostic } from "@babylonslate/scripting";
import { CompilerResultsPanel } from "./compiler-results-panel";

const selectActor = vi.hoisted(() => vi.fn());
const setDiagnostics = vi.hoisted(() => vi.fn());
const setFocusDiagnostic = vi.hoisted(() => vi.fn());
const setActiveDocument = vi.hoisted(() => vi.fn());
const clearFocusedNode = vi.hoisted(() => vi.fn());
const pairingWarning: Diagnostic = {
  severity: "warning",
  code: "physics.body_without_collider",
  message: "RigidBodyComponent needs a ColliderComponent on the same actor.",
  assetGuid: "assets/Main.scene.babasset",
  graphId: "scene:assets/Main.scene.babasset",
  actorId: "hero",
  componentId: "rb",
};
const diagnostics = vi.hoisted(() => ({
  current: [] as Diagnostic[],
}));
diagnostics.current = [pairingWarning];

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({
    documentId: "scene:assets/Main.scene.babasset",
  }),
  useOptionalDocumentWorkspace: () => ({
    documentId: "scene:assets/Main.scene.babasset",
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
          label: "Main",
        },
        content: {
          name: "Main",
          actors: [
            {
              id: "hero",
              components: [{ id: "rb", classId: "RigidBodyComponent" }],
            },
          ],
        },
      },
    ],
    setActiveDocument,
    activeDocumentId: "scene:assets/Main.scene.babasset",
  }),
}));

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
  clearFocusedNode.mockClear();
  diagnostics.current = [pairingWarning];
});

describe("CompilerResultsPanel", () => {
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
      assetGuid: "assets/Hero.class.babasset",
      graphId: "class:assets/Hero.class.babasset",
      nodeId: "tick",
    };
    diagnostics.current = [graphDiagnostic];
    render(<CompilerResultsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByTestId("compiler-result-row"));
    expect(setFocusDiagnostic).toHaveBeenCalledWith(graphDiagnostic);
    expect(clearFocusedNode).toHaveBeenCalled();
  });

  it("windows a large diagnostic set to the viewport plus overscan", () => {
    diagnostics.current = Array.from({ length: 200 }, (_, i) => ({
      severity: "error" as const,
      code: `graph.error.${i}`,
      message: `Diagnostic ${i}`,
      assetGuid: "assets/Mannequin.class.babasset",
      graphId: "class:assets/Mannequin.class.babasset",
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
