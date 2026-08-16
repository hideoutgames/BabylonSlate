import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { MyClassPanel } from "./my-class-panel";
import { GraphEditingProvider } from "../context/graph-editing-context";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const applyGraphChange = vi.hoisted(() => vi.fn(async () => true));
const applyAssetDocumentChange = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({
    documentId: "ui:assets/HUD.ui.babasset",
  }),
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openDocuments: [
      {
        id: "ui:assets/HUD.ui.babasset",
        ref: {
          kind: "ui",
          path: "assets/HUD.ui.babasset",
          label: "HUD",
        },
        content: {
          rootId: "canvas",
          widgets: { canvas: { id: "canvas", kind: "Canvas" } },
          logic: {
            nodes: [],
            edges: [],
            members: [
              { id: "fn-1", kind: "function", name: "Jump", pins: [] },
            ],
            functionGraphs: { "fn-1": { nodes: [], edges: [] } },
          },
        },
        layout: null,
        dirty: false,
      },
    ],
    applyGraphChange,
    applyAssetDocumentChange,
    assetRegistry: { list: () => [] },
  }),
}));

vi.mock("../context/validation-context", () => ({
  useValidation: () => ({ setFocusDiagnostic: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  applyGraphChange.mockClear();
  applyAssetDocumentChange.mockClear();
});

describe("MyClassPanel UserInterface logic", () => {
  it("lists functions from payload.logic in the Class tree", () => {
    render(
      <GraphEditingProvider>
        <MyClassPanel {...({} as IDockviewPanelProps)} />
      </GraphEditingProvider>,
    );
    expect(screen.getByTestId("tree-row-fn-1").textContent).toContain("Jump");
  });

  it("adds a function through applyAssetDocumentChange without dropping widgets", () => {
    render(
      <GraphEditingProvider>
        <MyClassPanel {...({} as IDockviewPanelProps)} />
      </GraphEditingProvider>,
    );
    fireEvent.click(screen.getByTestId("class-add-functions"));
    fireEvent.change(screen.getByTestId("name-prompt-input"), {
      target: { value: "Dash" },
    });
    fireEvent.click(screen.getByTestId("name-prompt-confirm"));
    expect(applyGraphChange).not.toHaveBeenCalled();
    expect(applyAssetDocumentChange).toHaveBeenCalledWith(
      "ui:assets/HUD.ui.babasset",
      expect.objectContaining({
        widgets: expect.objectContaining({
          canvas: expect.objectContaining({ id: "canvas" }),
        }),
        logic: expect.objectContaining({
          members: expect.arrayContaining([
            expect.objectContaining({ kind: "function", name: "Jump" }),
            expect.objectContaining({ kind: "function", name: "Dash" }),
          ]),
        }),
      }),
    );
  });
});
