import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { TypeMembersPanel } from "./type-members-panel";
import { TypeDetailsPanel } from "./type-details-panel";
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
  kind: "enum" as "enum" | "structure",
  content: {
    kind: "enum",
    guid: "e1",
    name: "Colors",
    members: [{ name: "None", value: 0 }],
    fields: [{ name: "Health", typeId: "float" }],
  } as Record<string, unknown>,
}));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({ documentId: "enum:assets/Colors.babasset" }),
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openDocuments: [
      {
        id: "enum:assets/Colors.babasset",
        ref: {
          kind: harness.kind,
          path: "assets/Colors.babasset",
          label: "Colors Enum",
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
  harness.kind = "enum";
  harness.content = {
    kind: "enum",
    guid: "e1",
    name: "Colors",
    members: [{ name: "None", value: 0 }],
    fields: [{ name: "Health", typeId: "float" }],
  };
});

describe("type asset member table", () => {
  it("adds an enum member in the table", () => {
    render(
      <TypeAssetEditingProvider>
        <TypeMembersPanel {...({} as IDockviewPanelProps)} />
      </TypeAssetEditingProvider>,
    );
    expect(screen.getByTestId("enum-row-0")).toBeTruthy();
    fireEvent.click(screen.getByTestId("enum-add-member"));
    expect(applyAssetDocumentChange).toHaveBeenCalledWith(
      "enum:assets/Colors.babasset",
      expect.objectContaining({
        members: expect.arrayContaining([
          expect.objectContaining({ name: "NewMember" }),
        ]),
      }),
    );
  });

  it("shows a PinTypePicker for the selected structure field", () => {
    harness.kind = "structure";
    harness.content = {
      kind: "structure",
      guid: "s1",
      name: "Stats",
      fields: [{ name: "Health", typeId: "float" }],
    };
    render(
      <TypeAssetEditingProvider>
        <TypeMembersPanel {...({} as IDockviewPanelProps)} />
        <TypeDetailsPanel {...({} as IDockviewPanelProps)} />
      </TypeAssetEditingProvider>,
    );
    fireEvent.click(screen.getByTestId("structure-row-0"));
    expect(screen.getByTestId("structure-field-type")).toBeTruthy();
    expect(
      screen.getByTestId("structure-field-type").compareDocumentPosition(
        screen.getByTestId("property-default"),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
    expect(
      screen.getByTestId("property-name").compareDocumentPosition(
        screen.getByTestId("structure-field-type"),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
  });
});
