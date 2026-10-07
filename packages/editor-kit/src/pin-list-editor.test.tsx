import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PinListEditor, type PinListRow } from "./pin-list-editor";
import { AssetOpenProvider } from "./asset-picker-control";

if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  Object.defineProperty(window, "PointerEvent", {
    value: PointerEventPolyfill,
  });
}

const rows: PinListRow[] = [
  { id: "a", name: "amount", type: "float", direction: "in" },
  { id: "b", name: "result", type: "bool", direction: "out" },
];

describe("PinListEditor", () => {
  afterEach(() => {
    cleanup();
  });

  it("moves and removes rows", () => {
    const onChange = vi.fn();
    render(<PinListEditor rows={rows} onChange={onChange} />);
    screen.getByTestId("pin-a-move-down").click();
    expect(onChange.mock.calls[0]![0].map((row: PinListRow) => row.id)).toEqual(
      ["b", "a"],
    );
    onChange.mockClear();
    screen.getByRole("button", { name: "Remove amount" }).click();
    expect(onChange).toHaveBeenCalledWith([rows[1]]);
    expect(screen.queryAllByText("Remove")).toEqual([]);
  });

  it.each([
    ["object", "Hero"],
    ["struct", "engine:TagContainer"],
  ] as const)("edits a %s pin's container without losing its type constraint", (type, typeClassId) => {
    const onChange = vi.fn();
    const row = { id: "items", name: "Items", type, typeClassId };
    const view = render(<PinListEditor rows={[row]} selectedId="items" showContainer showOptional={false} showDefault={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Array" }));
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ type, typeClassId, container: "array" })]);
    view.rerender(<PinListEditor rows={[{ ...row, container: "array" }]} selectedId="items" showContainer showOptional={false} showDefault={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ type, typeClassId, container: "map", keyTypeId: "string" })]);
  });

  it("keeps typeClassId on object pins and exposes a Class Type picker", async () => {
    const onChange = vi.fn();
    render(
      <PinListEditor
        rows={[
          {
            id: "a",
            name: "target",
            type: "object",
            direction: "in",
            typeClassId: "Hero",
          },
        ]}
        selectedId="a"
        classEntries={[{ id: "Hero", name: "Hero" }, { id: "Actor", name: "Actor" }]}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("pin-a-class-type")).toBeTruthy();
    expect(screen.getByTestId("pin-a-class-type").textContent).toContain("Hero");
    expect(screen.getByTestId("pin-a-class-type").textContent).toContain("Class");
    expect(
      screen
        .getByTestId("pin-a-class-type")
        .querySelector("[data-type-family]")
        ?.getAttribute("data-type-family"),
    ).toBe("class");
    screen.getByTestId("pin-a-class-type").click();
    await waitFor(() => {
      expect(screen.getByTestId("search-item-Actor")).toBeTruthy();
    });
    screen.getByTestId("search-item-Actor").click();
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: "a", typeClassId: "Actor" }),
    ]);
  });

  it("shows a Structure AssetPicker when typeAssets is passed even if empty", () => {
    render(
      <PinListEditor
        rows={[
          {
            id: "a",
            name: "stats",
            type: "struct",
            direction: "in",
          },
        ]}
        selectedId="a"
        typeAssets={[]}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId("pin-a-type-asset")).toBeTruthy();
  });

  it("selects nested Data Definitions without offering Structure assets in field editors", async () => {
    const onChange = vi.fn();
    render(<PinListEditor rows={[{ id: "field", name: "Stats", type: "struct" }]}
      selectedId="field" itemLabel="Field" structAssetType="DataDefinition"
      typeAssets={[{ guid: "stats", name: "Stats", type: "DataDefinition" }, { guid: "structure", name: "LegacyShape", type: "Structure" }]}
      onChange={onChange} />);
    fireEvent.click(screen.getByTestId("pin-field-type-asset"));
    await waitFor(() => expect(screen.getByTestId("search-item-stats")).toBeTruthy());
    expect(screen.queryByTestId("search-item-structure")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-stats"));
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ id: "field", type: "struct", typeClassId: "stats" })]);
  });

  it("selects function pin Definitions alongside Structures when row selection is uncontrolled", async () => {
    const onChange = vi.fn();
    render(<PinListEditor rows={[{ id: "input", name: "Item", type: "struct", direction: "in" }]}
      typeAssets={[{ guid: "item", name: "Item", type: "DataDefinition" }, { guid: "shape", name: "Shape", type: "Structure" }]}
      onChange={onChange} />);
    expect(screen.queryByTestId("pin-input-type-asset")).toBeNull();
    fireEvent.focus(screen.getByTestId("pin-input-name"));
    fireEvent.click(screen.getByTestId("pin-input-type-asset"));
    expect(await screen.findByTestId("search-item-item")).toBeTruthy();
    expect(screen.getByTestId("search-item-shape")).toBeTruthy();
    fireEvent.click(screen.getByTestId("search-item-item"));
    expect(onChange).toHaveBeenCalledWith([{ id: "input", name: "Item", type: "struct", direction: "in", typeClassId: "item" }]);
  });

  it("keeps typeClassId when switching to struct or enum and shows an asset picker", async () => {
    const onChange = vi.fn();
    render(
      <PinListEditor
        rows={[
          {
            id: "a",
            name: "stats",
            type: "struct",
            direction: "in",
            typeClassId: "struct-stats",
          },
        ]}
        selectedId="a"
        typeAssets={[
          { guid: "struct-stats", name: "Stats", type: "Structure" },
          { guid: "enum-team", name: "Team", type: "Enum" },
        ]}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("pin-a-type-asset")).toBeTruthy();
    expect(screen.getByTestId("pin-a-type-asset").textContent).toContain("Stats");
    screen.getByTestId("pin-a-type-asset").click();
    await waitFor(() => {
      expect(screen.getByTestId("search-item-struct-stats")).toBeTruthy();
    });
  });

  it("shows Open Asset beside a Structure type picker", () => {
    const openAsset = vi.fn();
    render(
      <AssetOpenProvider
        value={{
          canOpen: (guid) => guid === "struct-stats",
          openAsset,
        }}
      >
        <PinListEditor
          rows={[
            {
              id: "a",
              name: "stats",
              type: "struct",
              direction: "in",
              typeClassId: "struct-stats",
            },
          ]}
          selectedId="a"
          typeAssets={[
            { guid: "struct-stats", name: "Stats", type: "Structure" },
          ]}
          onChange={() => {}}
        />
      </AssetOpenProvider>,
    );
    screen.getByTestId("pin-a-type-asset-open").click();
    expect(openAsset).toHaveBeenCalledWith("struct-stats");
  });

  it("does not clear typeClassId when switching the pin type to enum", async () => {
    const onChange = vi.fn();
    render(
      <PinListEditor
        rows={[
          {
            id: "a",
            name: "team",
            type: "object",
            direction: "in",
            typeClassId: "Hero",
          },
        ]}
        selectedId="a"
        classEntries={[{ id: "Hero", name: "Hero" }]}
        typeAssets={[{ guid: "enum-team", name: "Team", type: "Enum" }]}
        onChange={onChange}
      />,
    );
    screen.getByTestId("pin-a-type").click();
    await waitFor(() => {
      expect(screen.getByTestId("search-item-enum")).toBeTruthy();
    });
    screen.getByTestId("search-item-enum").click();
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "a",
        type: "enum",
        typeClassId: "Hero",
      }),
    ]);
  });

  it("shows Class Type for actor pins", async () => {
    const onChange = vi.fn();
    render(
      <PinListEditor
        rows={[
          {
            id: "a",
            name: "pawn",
            type: "actor",
            direction: "in",
            typeClassId: "Actor",
          },
        ]}
        selectedId="a"
        classEntries={[
          { id: "Actor", name: "Actor" },
          { id: "Hero", name: "Hero" },
        ]}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("pin-a-class-type")).toBeTruthy();
    expect(screen.getByTestId("pin-a-class-type").textContent).toContain("Actor");
    screen.getByTestId("pin-a-class-type").click();
    await waitFor(() => {
      expect(screen.getByTestId("search-item-Hero")).toBeTruthy();
    });
    screen.getByTestId("search-item-Hero").click();
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: "a", typeClassId: "Hero" }),
    ]);
  });

  it.each(["Texture", "RenderTarget", "RenderTargetTexture"])("selects %s as an asset pin constraint", async (assetType) => {
    const onChange = vi.fn();
    render(
      <PinListEditor
        rows={[
          {
            id: "a",
            name: "cue",
            type: "asset",
            direction: "in",
            typeClassId: "Audio",
          },
        ]}
        selectedId="a"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("pin-a-asset-type").textContent).toContain("Audio");
    screen.getByTestId("pin-a-asset-type").click();
    await waitFor(() => {
      expect(screen.getByTestId(`search-item-${assetType}`)).toBeTruthy();
    });
    screen.getByTestId(`search-item-${assetType}`).click();
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: "a", typeClassId: assetType }),
    ]);
  });

  it("keeps compact host-managed field details separate while adding above the list", () => {
    const onChange = vi.fn();
    const onSelect = vi.fn();
    render(<PinListEditor rows={[{ id: "stats", name: "Stats", type: "struct" }]}
      selectedId="stats" itemLabel="Field" addPosition="top" showDetails={false}
      showContainer typeAssets={[]} onSelect={onSelect} onChange={onChange} />);
    expect(screen.queryByTestId("pin-stats-type-asset")).toBeNull();
    expect(screen.queryByRole("button", { name: "Array" })).toBeNull();
    fireEvent.focus(screen.getByRole("textbox", { name: "Field 1 name" }));
    expect(onSelect).toHaveBeenCalledWith("stats");
    const add = screen.getByLabelText("Add Field");
    expect(add.compareDocumentPosition(screen.getByTestId("pin-row-stats")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(add, { target: { value: "Count" } });
    fireEvent.click(screen.getByTestId("pin-add"));
    expect(onChange).toHaveBeenCalledWith([
      { id: "stats", name: "Stats", type: "struct" },
      expect.objectContaining({ name: "Count", type: "float" }),
    ]);
  });

  it("adds an input or output pin", () => {
    const onChange = vi.fn();
    render(
      <PinListEditor rows={[]} onChange={onChange} showDirection />,
    );
    fireEvent.change(screen.getByPlaceholderText("name"), {
      target: { value: "hit" },
    });
    screen.getByRole("button", { name: "Add Output" }).click();
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        name: "hit",
        type: "float",
        direction: "out",
      }),
    ]);
  });

  it("shows optional and default on the selected row", () => {
    const onChange = vi.fn();
    render(
      <PinListEditor
        rows={rows.slice(0, 1)}
        selectedId="a"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("pin-a-optional"));
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: "a", optional: true }),
    ]);
    expect(screen.getByTestId("pin-a-default")).toBeTruthy();
  });

  it("hides optional and default when those extras are disabled", () => {
    render(
      <PinListEditor
        rows={rows.slice(0, 1)}
        selectedId="a"
        onChange={() => {}}
        showOptional={false}
        showDefault={false}
      />,
    );
    expect(screen.queryByTestId("pin-a-optional")).toBeNull();
    expect(screen.queryByTestId("pin-a-default")).toBeNull();
  });

  it("keeps Class Type when optional and default extras are disabled", () => {
    render(
      <PinListEditor
        rows={[
          {
            id: "a",
            name: "target",
            type: "object",
            direction: "in",
            typeClassId: "Hero",
          },
        ]}
        selectedId="a"
        classEntries={[{ id: "Hero", name: "Hero" }]}
        onChange={() => {}}
        showOptional={false}
        showDefault={false}
      />,
    );
    expect(screen.queryByTestId("pin-a-optional")).toBeNull();
    expect(screen.queryByTestId("pin-a-default")).toBeNull();
    expect(screen.getByTestId("pin-a-class-type")).toBeTruthy();
  });

  it("adds an input pin with direction", () => {
    const onChange = vi.fn();
    render(
      <PinListEditor rows={rows} onChange={onChange} showDirection />,
    );
    fireEvent.change(screen.getByPlaceholderText("name"), {
      target: { value: "score" },
    });
    fireEvent.click(screen.getByTestId("pin-add-input"));
    expect(onChange).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ name: "score", direction: "in" }),
      ]),
    );
  });

  it("hides add and move controls when readOnly", () => {
    render(<PinListEditor rows={rows} onChange={() => {}} readOnly />);
    expect(screen.queryByTestId("pin-add")).toBeNull();
    expect(screen.queryByTestId("pin-a-move-up")).toBeNull();
    expect(screen.getByTestId("pin-a-name")).toHaveProperty("disabled", true);
  });
});
