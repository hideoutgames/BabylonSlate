import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

function dispatchPointer(target: Element, type: "pointerdown" | "pointerup"): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  target.dispatchEvent(event);
}

function selectRow(id: string): void {
  const row = screen.getByTestId(`tree-row-${id}`);
  act(() => {
    dispatchPointer(row, "pointerdown");
    dispatchPointer(row, "pointerup");
  });
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
    expect(screen.getByTestId("tree-row-member:0")).toBeTruthy();
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

  it.each(["enum", "structure"] as const)("renames a %s member from a double-tap on its name", async (kind) => {
    harness.kind = kind;
    harness.content = kind === "enum"
      ? { kind, guid: "e1", name: "Colors", members: [{ name: "None", value: 0 }] }
      : { kind, guid: "s1", name: "Stats", fields: [{ id: "health", name: "Health", typeId: "float" }] };
    render(
      <TypeAssetEditingProvider>
        <TypeMembersPanel {...({} as IDockviewPanelProps)} />
      </TypeAssetEditingProvider>,
    );
    // Names are plain row labels, so a tap selects the row instead of focusing an input.
    expect(screen.queryByRole("textbox", { name: /^Rename/ })).toBeNull();
    const original = kind === "enum" ? "None" : "Health";
    const label = screen.getByText(original);
    for (let tap = 0; tap < 2; tap++) {
      dispatchPointer(label, "pointerdown");
      dispatchPointer(label, "pointerup");
    }
    const input = await screen.findByRole("textbox", { name: `Rename ${original}` });
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const [, saved] = applyAssetDocumentChange.mock.calls.at(-1) as unknown as [string, Record<string, Array<{ name: string }>>];
    expect(saved[kind === "enum" ? "members" : "fields"]![0]!.name).toBe("Renamed");
  });

  it("keeps enum values whole numbers", () => {
    render(
      <TypeAssetEditingProvider>
        <TypeMembersPanel {...({} as IDockviewPanelProps)} />
      </TypeAssetEditingProvider>,
    );
    const value = screen.getByRole("textbox", { name: "None value" });
    fireEvent.change(value, { target: { value: "2.6" } });
    fireEvent.blur(value);
    const [, saved] = applyAssetDocumentChange.mock.calls.at(-1) as unknown as [string, { members: Array<{ value: number }> }];
    expect(saved.members[0]!.value).toBe(3);
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
    selectRow("member:0");
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
    selectRow("member:0");
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
    selectRow("member:0");
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
    selectRow("member:1");
    expect(screen.queryByTestId("structure-field-loading")).toBeNull();
    selectRow("member:0");
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
