import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { InspectorPanel } from "./inspector-panel";
import { GraphEditingProvider } from "../context/graph-editing-context";
import { PrefabEditingProvider } from "../context/prefab-editing-context";

if (
  typeof window !== "undefined" &&
  typeof window.PointerEvent === "undefined"
) {
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
          },
        },
        layout: null,
        dirty: false,
      },
    ],
    applyGraphChange,
    applyAssetDocumentChange,
    projectDocument: { settings: { input: { actions: [], axes: [] } } },
    assetRegistry: { list: () => [] },
  }),
}));

vi.mock("../context/validation-context", () => ({
  useValidation: () => ({
    focusDiagnostic: null,
    setFocusDiagnostic: vi.fn(),
  }),
}));

vi.mock("../context/play-context", () => ({
  usePlay: () => ({ focusedNodeId: null }),
}));

function renderUiMemberInspector() {
  return render(
    <PrefabEditingProvider>
      <GraphEditingProvider initialSelectedMemberId="fn-1">
        <InspectorPanel {...({} as IDockviewPanelProps)} />
      </GraphEditingProvider>
    </PrefabEditingProvider>,
  );
}

afterEach(() => {
  cleanup();
  applyGraphChange.mockClear();
  applyAssetDocumentChange.mockClear();
});

describe("Inspector UserInterface logic members", () => {
  it("renders function details from payload.logic", () => {
    renderUiMemberInspector();
    expect(screen.getByTestId("inspector-member-function")).toBeTruthy();
    expect(screen.getByTestId("inspector-member-inputs")).toBeTruthy();
    expect(screen.getByTestId("inspector-member-outputs")).toBeTruthy();
  });

  it("renames a function through applyAssetDocumentChange without dropping widgets", () => {
    renderUiMemberInspector();
    fireEvent.change(screen.getByTestId("property-name"), {
      target: { value: "Dash" },
    });
    expect(applyGraphChange).not.toHaveBeenCalled();
    expect(applyAssetDocumentChange).toHaveBeenCalledWith(
      "ui:assets/HUD.ui.babasset",
      expect.objectContaining({
        widgets: expect.objectContaining({
          canvas: expect.objectContaining({ id: "canvas" }),
        }),
        logic: expect.objectContaining({
          members: expect.arrayContaining([
            expect.objectContaining({
              id: "fn-1",
              kind: "function",
              name: "Dash",
            }),
          ]),
        }),
      }),
    );
  });
});
