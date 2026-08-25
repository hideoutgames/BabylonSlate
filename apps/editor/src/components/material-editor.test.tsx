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
  it("overlays compact mesh actions on the canvas instead of a toolbar strip", () => {
    const { container } = render(<MaterialPreviewPanel {...panelProps} />);
    expect(screen.getByTestId("material-preview-overlay")).toBeTruthy();
    expect(container.querySelector("[data-slot=toolbar]")).toBeNull();
    expect(screen.getByTestId("material-preview-mesh")).toBeTruthy();
    expect(screen.getByTestId("material-preview-mesh-cube")).toBeTruthy();
    expect(screen.queryByTestId("material-render")).toBeNull();
    expect(screen.queryByTestId("material-preview-status")).toBeNull();
    expect(screen.queryByTestId("material-preview-custom-mesh")).toBeNull();
  });

  it("stores the chosen primitive on the document", () => {
    render(<MaterialPreviewPanel {...panelProps} />);
    fireEvent.click(screen.getByTestId("material-preview-mesh-cylinder"));
    expect(lastCommit().preview.mesh).toBe("cylinder");
  });

  it("opens the model picker when Custom is chosen with no mesh", () => {
    render(<MaterialPreviewPanel {...panelProps} />);
    fireEvent.click(screen.getByTestId("material-preview-mesh-custom"));
    expect(harness.applyAssetDocumentChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("material-preview-mesh-picker")).toBeTruthy();
  });

  it("stores a picked custom model without a separate Pick Mesh button", () => {
    render(<MaterialPreviewPanel {...panelProps} />);
    fireEvent.click(screen.getByTestId("material-preview-mesh-custom"));
    fireEvent.click(screen.getByTestId("search-item-model-1"));
    expect(lastCommit().preview).toEqual({
      mesh: "custom",
      customMeshGuid: "model-1",
    });
    expect(screen.queryByTestId("material-preview-custom-mesh")).toBeNull();
  });

  it("returns to Cube when the custom picker chooses None", () => {
    render(<MaterialPreviewPanel {...panelProps} />);
    fireEvent.click(screen.getByTestId("material-preview-mesh-custom"));
    fireEvent.click(screen.getByTestId("search-item-__none__"));
    expect(lastCommit().preview).toEqual({
      mesh: "cube",
      customMeshGuid: null,
    });
  });

  it("returns to Cube when an initial custom pick is dismissed", () => {
    const doc = createDefaultMaterialDocument("Rock");
    doc.preview = { mesh: "cylinder", customMeshGuid: null };
    harness.content = doc as unknown as Record<string, unknown>;
    render(<MaterialPreviewPanel {...panelProps} />);
    fireEvent.click(screen.getByTestId("material-preview-mesh-custom"));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(lastCommit().preview).toEqual({
      mesh: "cube",
      customMeshGuid: null,
    });
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
  it("shows material settings when no node is selected", () => {
    render(<MaterialDetailsPanel {...panelProps} />);
    expect(screen.getByTestId("material-settings")).toBeTruthy();
    expect(screen.getByTestId("property-domain")).toBeTruthy();
    expect(screen.queryByTestId("material-node-details")).toBeNull();
  });

  it("hides material settings and shows node details when a node is selected", () => {
    harness.selectedNodeId = "output";
    render(<MaterialDetailsPanel {...panelProps} />);
    expect(screen.queryByTestId("material-settings")).toBeNull();
    expect(screen.queryByTestId("property-domain")).toBeNull();
    expect(screen.getByTestId("material-node-details")).toBeTruthy();
    expect(screen.getByTestId("property-metallic")).toBeTruthy();
    expect(screen.queryByTestId("property-baseColor")).toBeNull();
  });

  it("switches the material domain", () => {
    render(<MaterialDetailsPanel {...panelProps} />);
    const select = screen.getByTestId("property-domain");
    expect(select).toBeTruthy();
  });

  it("offers Surface, Post Process, and Particle without Interface", async () => {
    render(<MaterialDetailsPanel {...panelProps} />);
    fireEvent.click(screen.getByTestId("property-domain"));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Surface" })).toBeTruthy();
    });
    expect(screen.getByRole("option", { name: "Post Process" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Particle" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Interface" })).toBeNull();
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

  it("shows a GLSL expression editor for the selected Custom GLSL node", () => {
    const doc = createDefaultMaterialDocument("Rock");
    doc.nodes.push({
      id: "glsl",
      type: "custom.glsl",
      position: { x: 0, y: 0 },
      properties: { body: "a + b" },
    });
    harness.content = doc as unknown as Record<string, unknown>;
    harness.selectedNodeId = "glsl";
    render(<MaterialDetailsPanel {...panelProps} />);
    expect(screen.getByTestId("material-node-glsl")).toBeTruthy();
    expect(screen.getByTestId("material-node-glsl-signature").textContent).toMatch(
      /a,\s*b/,
    );
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

  it("shows a texture picker for a Texture Sample with an inline default", () => {
    const doc = createDefaultMaterialDocument("Rock");
    doc.nodes.push({
      id: "sample",
      type: "texture.sample",
      position: { x: 0, y: 0 },
      properties: { textureGuid: "tex-1" },
    });
    harness.content = doc as unknown as Record<string, unknown>;
    harness.selectedNodeId = "sample";
    render(<MaterialDetailsPanel {...panelProps} />);
    expect(screen.getByTestId("material-node-texture").textContent).toContain(
      "Bark",
    );
  });

  it("writes an authored pin default from Details", () => {
    harness.selectedNodeId = "output";
    render(<MaterialDetailsPanel {...panelProps} />);
    const input = screen.getByTestId("property-metallic");
    fireEvent.change(input, { target: { value: "0.25" } });
    expect(
      lastCommit().nodes.find((node) => node.id === "output")?.properties,
    ).toEqual({ "default:metallic": [0.25] });
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
    expect(
      container.querySelector(
        '[data-id="output"] [data-handleid="worldPositionOffset"]',
      ),
    ).not.toBeNull();
  });

  it("shows read-only default widgets on unconnected material pins", async () => {
    const { container } = render(<MaterialGraphPanel {...panelProps} />);
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-id="output"] [data-pin-label="Metallic"]',
        ),
      ).not.toBeNull();
    });
    expect(
      container.querySelector(
        '[data-id="output"] [data-handleid="metallic"]',
      )?.parentElement?.querySelector('[data-pin-default="float"]')?.textContent,
    ).toBe("0");
    expect(
      container.querySelector(
        '[data-id="output"] [data-handleid="baseColor"]',
      )?.parentElement?.querySelector("[data-pin-default]"),
    ).toBeNull();
  });
});
