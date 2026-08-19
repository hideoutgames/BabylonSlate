import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { CompilerResultsPanel } from "./compiler-results-panel";

const selectActor = vi.hoisted(() => vi.fn());
const setDiagnostics = vi.hoisted(() => vi.fn());
const setFocusDiagnostic = vi.hoisted(() => vi.fn());
const setActiveDocument = vi.hoisted(() => vi.fn());
const clearFocusedNode = vi.hoisted(() => vi.fn());

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
    diagnostics: [
      {
        severity: "warning",
        code: "physics.body_without_collider",
        message: "RigidBodyComponent needs a ColliderComponent on the same actor.",
        assetGuid: "assets/Main.scene.babasset",
        graphId: "scene:assets/Main.scene.babasset",
        actorId: "hero",
        componentId: "rb",
      },
    ],
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

afterEach(() => {
  cleanup();
  selectActor.mockClear();
  setDiagnostics.mockClear();
  setFocusDiagnostic.mockClear();
});

describe("CompilerResultsPanel", () => {
  it("selects the actor when a physics pairing warning is tapped", () => {
    render(<CompilerResultsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByTestId("compiler-result-row"));
    expect(selectActor).toHaveBeenCalledWith("hero");
    expect(setFocusDiagnostic).toHaveBeenCalled();
  });
});
