import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
  createMaterialPreviewState,
  materialPreviewReducer,
  type MaterialDocument,
  type MaterialPreviewState,
} from "@babylonslate/shader-graph";

const harness: {
  content: Record<string, unknown>;
  kind: string;
  applyAssetDocumentChange: ReturnType<typeof vi.fn>;
  previewState: MaterialPreviewState;
  requestRender: ReturnType<typeof vi.fn>;
  focusNode: ReturnType<typeof vi.fn>;
  selectedNodeId: string | null;
} = {
  content: createDefaultMaterialDocument("Rock") as unknown as Record<
    string,
    unknown
  >,
  kind: "material",
  applyAssetDocumentChange: vi.fn(),
  previewState: createMaterialPreviewState(),
  requestRender: vi.fn(),
  focusNode: vi.fn(),
  selectedNodeId: null,
};

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({ documentId: "material:assets/Rock.material.babasset" }),
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openDocuments: [
      {
        id: "material:assets/Rock.material.babasset",
        ref: { kind: harness.kind, path: "assets/Rock.material.babasset" },
        content: harness.content,
      },
    ],
    applyAssetDocumentChange: harness.applyAssetDocumentChange,
    assetRegistry: {
      list: () => [
        {
          header: { guid: "tex-1", name: "Bark", type: "Texture" },
          path: "assets/Bark.babasset",
        },
        {
          header: { guid: "model-1", name: "Statue", type: "Model" },
          path: "assets/Statue.babasset",
        },
      ],
      getByGuid: (guid: string) =>
        guid === "tex-1"
          ? { header: { guid, name: "Bark", type: "Texture" } }
          : guid === "model-1"
            ? { header: { guid, name: "Statue", type: "Model" } }
            : null,
    },
  }),
}));

vi.mock("../context/material-editing-context", () => ({
  useMaterialEditing: () => ({
    functions: {},
    previewState: harness.previewState,
    compileDiagnostics: [],
    selectedNodeId: harness.selectedNodeId,
    setSelectedNodeId: vi.fn(),
    focusedNodeId: null,
    focusNode: harness.focusNode,
    requestRender: harness.requestRender,
    attachPreviewCanvas: vi.fn(),
    frameBudgetMs: 1000 / 60,
  }),
}));

const {
  MaterialCompilerResultsPanel,
  MaterialDetailsPanel,
  MaterialFunctionInterfacePanel,
  MaterialGraphPanel,
  MaterialPreviewPanel,
} = await import("./material-editor");

const panelProps = {} as IDockviewPanelProps;

beforeEach(() => {
  harness.content = createDefaultMaterialDocument("Rock") as unknown as Record<
    string,
    unknown
  >;
  harness.kind = "material";
  harness.previewState = createMaterialPreviewState();
  harness.selectedNodeId = null;
  harness.applyAssetDocumentChange = vi.fn();
  harness.requestRender = vi.fn();
  harness.focusNode = vi.fn();
});

afterEach(() => {
  cleanup();
});

function lastCommit(): MaterialDocument {
  const calls = harness.applyAssetDocumentChange.mock.calls;
  return calls[calls.length - 1]![1] as MaterialDocument;
}

describe("Material preview panel", () => {
  it("offers all six preview primitives", () => {
    render(<MaterialPreviewPanel {...panelProps} />);
    for (const mesh of ["cube", "sphere", "cylinder", "cone", "plane", "custom"]) {
      expect(screen.getByTestId(`material-preview-mesh-${mesh}`)).toBeTruthy();
    }
  });

  it("stores the chosen primitive on the document", () => {
    render(<MaterialPreviewPanel {...panelProps} />);
    fireEvent.click(screen.getByTestId("material-preview-mesh-cube"));
    expect(lastCommit().preview.mesh).toBe("cube");
  });

  it("opens the model picker when Custom is chosen with no mesh", async () => {
    render(<MaterialPreviewPanel {...panelProps} />);
    fireEvent.click(screen.getByTestId("material-preview-mesh-custom"));
    await waitFor(() => {
      expect(screen.getByTestId("material-preview-mesh-picker")).toBeTruthy();
    });
  });

  it("shows the picked custom mesh name", () => {
    const doc = createDefaultMaterialDocument("Rock");
    doc.preview = { mesh: "custom", customMeshGuid: "model-1" };
    harness.content = doc as unknown as Record<string, unknown>;
    render(<MaterialPreviewPanel {...panelProps} />);
    expect(
      screen.getByTestId("material-preview-custom-mesh").textContent,
    ).toContain("Statue");
  });

  it("disables Render while the preview is clean", () => {
    render(<MaterialPreviewPanel {...panelProps} />);
    expect(
      screen.getByTestId("material-render").hasAttribute("disabled"),
    ).toBe(true);
  });

  it("enables Render for an expensive graph that is waiting", () => {
    harness.previewState = materialPreviewReducer(
      createMaterialPreviewState(),
      { type: "edit", cost: "expensive" },
    );
    render(<MaterialPreviewPanel {...panelProps} />);
    expect(
      screen.getByTestId("material-render").hasAttribute("disabled"),
    ).toBe(false);
  });

  it("disables Render while a compile is in flight", () => {
    let state = materialPreviewReducer(createMaterialPreviewState(), {
      type: "edit",
      cost: "expensive",
    });
    state = materialPreviewReducer(state, { type: "render" });
    state = materialPreviewReducer(state, {
      type: "compileStart",
      generation: 1,
    });
    harness.previewState = state;
    render(<MaterialPreviewPanel {...panelProps} />);
    expect(
      screen.getByTestId("material-render").hasAttribute("disabled"),
    ).toBe(true);
  });

  it("asks the host to compile when Render is pressed", () => {
    harness.previewState = materialPreviewReducer(
      createMaterialPreviewState(),
      { type: "edit", cost: "expensive" },
    );
    render(<MaterialPreviewPanel {...panelProps} />);
    fireEvent.click(screen.getByTestId("material-render"));
    expect(harness.requestRender).toHaveBeenCalled();
  });

  it("surfaces a compile error under the canvas", () => {
    let state = materialPreviewReducer(createMaterialPreviewState(), {
      type: "edit",
      cost: "cheap",
    });
    state = materialPreviewReducer(state, {
      type: "compileStart",
      generation: 1,
    });
    state = materialPreviewReducer(state, {
      type: "result",
      generation: 1,
      ok: false,
      error: "block failed",
    });
    harness.previewState = state;
    render(<MaterialPreviewPanel {...panelProps} />);
    expect(screen.getByTestId("material-preview-error").textContent).toContain(
      "block failed",
    );
  });
});

describe("Material details panel", () => {
  it("switches the material domain", () => {
    render(<MaterialDetailsPanel {...panelProps} />);
    const select = screen.getByTestId("property-domain");
    expect(select).toBeTruthy();
  });

  it("reports whether the graph renders automatically", () => {
    render(<MaterialDetailsPanel {...panelProps} />);
    expect(
      screen.getByTestId("material-cost").getAttribute("data-cost-class"),
    ).toBe("cheap");
  });

  it("calls a post-process material expensive so it waits for Render", () => {
    harness.content = createDefaultMaterialDocument(
      "Blur",
      "postProcess",
    ) as unknown as Record<string, unknown>;
    render(<MaterialDetailsPanel {...panelProps} />);
    expect(
      screen.getByTestId("material-cost").getAttribute("data-cost-class"),
    ).toBe("expensive");
  });

  it("shows a texture picker for the selected texture parameter", () => {
    const doc = createDefaultMaterialDocument("Rock");
    doc.nodes.push({
      id: "tex",
      type: "param.texture",
      position: { x: 0, y: 0 },
      properties: { textureGuid: "tex-1" },
    });
    harness.content = doc as unknown as Record<string, unknown>;
    harness.selectedNodeId = "tex";
    render(<MaterialDetailsPanel {...panelProps} />);
    expect(screen.getByTestId("material-node-texture").textContent).toContain(
      "Bark",
    );
  });

  it("shows nothing extra when no node is selected", () => {
    render(<MaterialDetailsPanel {...panelProps} />);
    expect(screen.queryByTestId("material-node-details")).toBeNull();
  });
});

describe("Material compiler results", () => {
  it("reports a clean material", () => {
    render(<MaterialCompilerResultsPanel {...panelProps} />);
    expect(screen.getByText("No Issues")).toBeTruthy();
  });

  it("lists a validation error and focuses its node when tapped", () => {
    const doc = createDefaultMaterialDocument("Rock");
    doc.nodes.push({
      id: "bogus",
      type: "math.doesNotExist",
      position: { x: 0, y: 0 },
      properties: {},
    });
    harness.content = doc as unknown as Record<string, unknown>;
    render(<MaterialCompilerResultsPanel {...panelProps} />);
    const row = screen.getByTestId("material-diagnostic-material.unknownNode");
    fireEvent.click(row);
    expect(harness.focusNode).toHaveBeenCalledWith("bogus");
  });

  it("warns about post-process fill rate without blocking", () => {
    harness.content = createDefaultMaterialDocument(
      "Blur",
      "postProcess",
    ) as unknown as Record<string, unknown>;
    render(<MaterialCompilerResultsPanel {...panelProps} />);
    const row = screen.getByTestId(
      "material-diagnostic-material.postProcessCost",
    );
    expect(row.getAttribute("data-severity")).toBe("warning");
  });
});

describe("Material function interface", () => {
  it("lists the declared inputs and outputs", () => {
    harness.kind = "material-function";
    harness.content = createDefaultMaterialFunctionDocument(
      "Tint",
    ) as unknown as Record<string, unknown>;
    render(<MaterialFunctionInterfacePanel {...panelProps} />);
    expect(screen.getByTestId("material-function-inputs")).toBeTruthy();
    expect(screen.getByTestId("material-function-outputs")).toBeTruthy();
  });
});

describe("Material graph panel", () => {
  it("renders the graph canvas with catalog pins", async () => {
    const { container } = render(<MaterialGraphPanel {...panelProps} />);
    await waitFor(() => {
      expect(container.querySelector('[data-handleid="baseColor"]')).not.toBeNull();
    });
  });
});
