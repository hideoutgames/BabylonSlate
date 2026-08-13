import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { filterSearchItems, SearchDialog } from "./search-dialog";
import { AssetPicker } from "./asset-picker";

const items = [
  { id: "a", label: "Alpha", description: "first" },
  { id: "b", label: "Beta", description: "second" },
];

describe("filterSearchItems", () => {
  it("returns everything for an empty query", () => {
    expect(filterSearchItems(items, "  ")).toHaveLength(2);
  });

  it("matches label, description and group case-insensitively", () => {
    expect(filterSearchItems(items, "SECOND").map((item) => item.id)).toEqual([
      "b",
    ]);
    expect(filterSearchItems(items, "alp").map((item) => item.id)).toEqual(["a"]);
  });
});

describe("SearchDialog", () => {
  afterEach(() => {
    cleanup();
  });

  it("opens as a centered dialog, not a bottom sheet", () => {
    render(
      <SearchDialog
        open
        onOpenChange={() => {}}
        title="Add Component"
        items={items}
        onSelect={() => {}}
        data-testid="picker"
      />,
    );

    const root = screen.getByTestId("picker");
    expect(root.getAttribute("data-slot")).toBe("dialog-content");
    expect(root.getAttribute("data-side")).toBeNull();
  });

  it("filters rows as the query changes and reports the selection", () => {
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <SearchDialog
        open
        onOpenChange={onOpenChange}
        title="Add Component"
        items={items}
        onSelect={onSelect}
        data-testid="picker"
      />,
    );

    fireEvent.change(screen.getByTestId("picker-query"), {
      target: { value: "beta" },
    });
    expect(screen.queryByTestId("search-item-a")).toBeNull();

    screen.getByTestId("search-item-b").click();
    expect(onSelect).toHaveBeenCalledWith("b");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders a leading node on each row", () => {
    render(
      <SearchDialog
        open
        onOpenChange={() => {}}
        title="Pick"
        items={[{ ...items[0]!, leading: <span data-testid="lead">*</span> }]}
        onSelect={() => {}}
        data-testid="picker"
      />,
    );
    expect(screen.getByTestId("lead")).toBeTruthy();
  });

  it("shows the empty label when nothing matches", () => {
    render(
      <SearchDialog
        open
        onOpenChange={() => {}}
        title="Add Component"
        items={items}
        emptyLabel="No matches"
        onSelect={() => {}}
        data-testid="picker"
      />,
    );
    fireEvent.change(screen.getByTestId("picker-query"), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No matches")).toBeTruthy();
  });
});

describe("AssetPicker", () => {
  afterEach(() => {
    cleanup();
  });

  const assets = [
    { guid: "g1", name: "Rock", type: "Mesh", path: "assets/rock" },
    { guid: "g2", name: "Grass", type: "Texture", path: "assets/grass" },
  ];

  it("restricts the list to allowed types and can clear the reference", () => {
    const onPick = vi.fn();
    render(
      <AssetPicker
        open
        onOpenChange={() => {}}
        assets={assets}
        allowedTypes={["Texture"]}
        onPick={onPick}
      />,
    );

    expect(screen.queryByTestId("search-item-g1")).toBeNull();
    expect(screen.getByTestId("search-item-g2")).toBeTruthy();

    screen.getByTestId("search-item-__none__").click();
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it("passes the picked guid through", () => {
    const onPick = vi.fn();
    render(
      <AssetPicker
        open
        onOpenChange={() => {}}
        assets={assets}
        allowNone={false}
        onPick={onPick}
      />,
    );
    screen.getByTestId("search-item-g1").click();
    expect(onPick).toHaveBeenCalledWith("g1");
  });
});
