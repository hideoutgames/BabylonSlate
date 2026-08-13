import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { InspectorPanel } from "./inspector-panel";
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

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({
    documentId: "graph:assets/Hero.class.babasset",
  }),
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openDocuments: [
      {
        id: "graph:assets/Hero.class.babasset",
        ref: {
          kind: "graph",
          path: "assets/Hero.class.babasset",
          label: "Hero Class",
        },
        content: {
          nodes: [],
          edges: [],
          members: [
            { id: "var-1", kind: "variable", name: "Health", typeId: "bool" },
            { id: "fn-1", kind: "function", name: "Jump", pins: [] },
            { id: "if-1", kind: "interface", name: "Damageable", assetGuid: "" },
          ],
        },
        layout: null,
        dirty: false,
      },
    ],
    applyGraphChange,
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

function renderMemberInspector(memberId: string, includeClassPanel = false) {
  return render(
    <GraphEditingProvider initialSelectedMemberId={memberId}>
      {includeClassPanel ? (
        <MyClassPanel {...({} as IDockviewPanelProps)} />
      ) : null}
      <InspectorPanel {...({} as IDockviewPanelProps)} />
    </GraphEditingProvider>,
  );
}

afterEach(() => {
  cleanup();
  applyGraphChange.mockClear();
});

describe("Inspector class member details", () => {
  it("shows PinTypePicker for a selected variable", () => {
    renderMemberInspector("var-1", true);
    expect(screen.getByTestId("class-var-type-var-1")).toBeTruthy();
    expect(screen.getByTestId("inspector-member-type")).toBeTruthy();
    expect(screen.getByTestId("inspector-member-variable")).toBeTruthy();
  });

  it("shows PinListEditor for a selected function", () => {
    renderMemberInspector("fn-1");
    expect(screen.getByTestId("inspector-member-pins")).toBeTruthy();
    expect(screen.getByTestId("class-fn-pin-add-input")).toBeTruthy();
  });

  it("shows ScriptInterface AssetPicker for a selected interface", () => {
    renderMemberInspector("if-1");
    expect(screen.getByTestId("inspector-member-interface-pick")).toBeTruthy();
  });
});
