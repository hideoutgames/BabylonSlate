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

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
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
  assetRegistry: { list: () => [{ path: "assets/Item.datadefinition.babasset", header: {
    type: "DataDefinition", guid: "item", name: "Item", payload: { kind: "dataDefinition", fields: [
      { id: "price", name: "Price", typeId: "int", defaultValue: 12 },
    ] },
  } }] },
})));

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

  it.each(["enum", "structure"] as const)("keeps the %s name input mounted while its name is typed", (kind) => {
    harness.kind = kind;
    harness.content = kind === "enum"
      ? { kind, guid: "e1", name: "Colors", members: [{ name: "None", value: 0 }] }
      : { kind, guid: "s1", name: "Stats", fields: [{ id: "health", name: "Health", typeId: "float" }] };
    const panel = () => (
      <TypeAssetEditingProvider>
        <TypeMembersPanel {...({} as IDockviewPanelProps)} />
      </TypeAssetEditingProvider>
    );
    const { rerender } = render(panel());
    const label = kind === "enum" ? "Member 1 name" : "Field 1 name";
    const input = screen.getByLabelText(label);
    input.focus();
    fireEvent.change(input, { target: { value: "Renamed" } });
    // The document applies each keystroke, so the row re-renders with the new name.
    const [, saved] = applyAssetDocumentChange.mock.calls.at(-1) as unknown as [string, Record<string, unknown>];
    harness.content = saved;
    rerender(panel());
    expect(screen.getByLabelText(label)).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  it.each(["enum", "structure"] as const)("keeps a moved %s row selected in Details", (kind) => {
    harness.kind = kind;
    harness.content = kind === "enum"
      ? { kind, guid: "e1", name: "Colors", members: [{ name: "Red", value: 0 }, { name: "Blue", value: 1 }] }
      : { kind, guid: "s1", name: "Stats", fields: [
        { id: "red", name: "Red", typeId: "float" },
        { id: "blue", name: "Blue", typeId: "float" },
      ] };
    const panels = () => (
      <TypeAssetEditingProvider>
        <TypeMembersPanel {...({} as IDockviewPanelProps)} />
        <TypeDetailsPanel {...({} as IDockviewPanelProps)} />
      </TypeAssetEditingProvider>
    );
    const { rerender } = render(panels());
    fireEvent.click(screen.getByTestId(`${kind}-row-0`));
    fireEvent.click(screen.getByRole("button", { name: "Move Red down" }));
    const [, saved] = applyAssetDocumentChange.mock.calls.at(-1) as unknown as [string, Record<string, unknown>];
    harness.content = saved;
    rerender(panels());
    expect((screen.getByTestId("property-name") as HTMLInputElement).value).toBe("Red");
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

  it("uses a Data Definition for a nested Structure field", async () => {
    harness.kind = "structure";
    harness.content = { kind: "structure", guid: "s1", name: "Container", fields: [{ id: "item-field", name: "Item", typeId: "struct" }] };
    render(<TypeAssetEditingProvider>
      <TypeMembersPanel {...({} as IDockviewPanelProps)} />
      <TypeDetailsPanel {...({} as IDockviewPanelProps)} />
    </TypeAssetEditingProvider>);
    fireEvent.click(screen.getByTestId("structure-row-0"));
    fireEvent.click(screen.getByTestId("structure-field-type-asset"));
    fireEvent.click(await screen.findByTestId("search-item-item"));
    expect(applyAssetDocumentChange).toHaveBeenCalledWith("enum:assets/Colors.babasset", expect.objectContaining({ fields: [{
      id: "item-field", name: "Item", typeId: "struct", typeClassId: "item", defaultValue: { Price: 12 },
    }] }));
  });

  it("edits the Loading of an asset field and offers none for other field types", () => {
    harness.kind = "structure";
    harness.content = { kind: "structure", guid: "s1", name: "Kit", fields: [
      { id: "mesh", name: "Mesh", typeId: "asset", typeClassId: "Model", defaultValue: "", loading: "hard" },
      { id: "health", name: "Health", typeId: "float" },
    ] };
    render(<TypeAssetEditingProvider>
      <TypeMembersPanel {...({} as IDockviewPanelProps)} />
      <TypeDetailsPanel {...({} as IDockviewPanelProps)} />
    </TypeAssetEditingProvider>);
    fireEvent.click(screen.getByTestId("structure-row-1"));
    expect(screen.queryByTestId("structure-field-loading")).toBeNull();
    fireEvent.click(screen.getByTestId("structure-row-0"));
    const loading = screen.getByTestId("structure-field-loading");
    expect(loading.textContent).toContain("Hard (Load With Owner)");
    fireEvent.click(loading);
    const soft = screen.getByRole("option", { name: "Soft (Load On Demand)" });
    fireEvent.pointerDown(soft);
    fireEvent.click(soft);
    const saved = applyAssetDocumentChange.mock.calls.at(-1) as unknown as [string, { fields: object[] }];
    expect(saved[1].fields).toEqual([
      { id: "mesh", name: "Mesh", typeId: "asset", typeClassId: "Model", defaultValue: "" },
      { id: "health", name: "Health", typeId: "float" },
    ]);
  });
});
