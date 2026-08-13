import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { InterfaceMethodsPanel } from "./interface-methods-panel";
import { InterfacePreviewPanel } from "./interface-preview-panel";
import { TypeAssetEditingProvider } from "../context/type-asset-editing-context";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const applyAssetDocumentChange = vi.hoisted(() => vi.fn(async () => true));
const harness = vi.hoisted(() => ({
  content: {
    kind: "scriptInterface",
    guid: "i1",
    name: "IHit",
    methods: [
      {
        name: "OnHit",
        pins: [{ name: "amount", typeId: "float", direction: "in" }],
      },
    ],
  } as Record<string, unknown>,
}));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({
    documentId: "script-interface:assets/IHit.babasset",
  }),
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openDocuments: [
      {
        id: "script-interface:assets/IHit.babasset",
        ref: {
          kind: "script-interface",
          path: "assets/IHit.babasset",
          label: "IHit Script Interface",
        },
        content: harness.content,
        layout: null,
        dirty: false,
      },
    ],
    applyAssetDocumentChange,
  }),
}));

afterEach(() => {
  cleanup();
  applyAssetDocumentChange.mockClear();
});

describe("ScriptInterface methods and preview", () => {
  it("selects a method and shows a read-only function preview", async () => {
    render(
      <TypeAssetEditingProvider>
        <InterfaceMethodsPanel {...({} as IDockviewPanelProps)} />
        <InterfacePreviewPanel {...({} as IDockviewPanelProps)} />
      </TypeAssetEditingProvider>,
    );
    fireEvent.click(screen.getByTestId("interface-method-0"));
    expect(screen.getByTestId("interface-preview-panel")).toBeTruthy();
    const editor = await screen.findByTestId("graph-editor");
    expect(editor.getAttribute("data-readonly")).toBe("true");
  });
});
