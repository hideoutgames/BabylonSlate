import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SearchDropdown } from "./search-dropdown";

const items = [
  { id: "a", label: "Alpha", description: "first" },
  { id: "b", label: "Beta", description: "second" },
];

describe("SearchDropdown", () => {
  afterEach(() => {
    cleanup();
  });

  it("opens an anchored menu, not a bottom sheet", () => {
    render(
      <SearchDropdown
        open
        onOpenChange={() => {}}
        title="Tile Palette"
        items={items}
        onSelect={() => {}}
        data-testid="palette"
      >
        <button type="button">Palette</button>
      </SearchDropdown>,
    );

    const root = screen.getByTestId("palette");
    expect(root.getAttribute("data-slot")).toBe("dropdown-menu-content");
    expect(root.closest("[data-side='bottom'][data-slot='sheet-content']")).toBeNull();
  });

  it("filters rows as the query changes and reports the selection", () => {
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <SearchDropdown
        open
        onOpenChange={onOpenChange}
        title="Tile Palette"
        items={items}
        onSelect={onSelect}
        data-testid="palette"
      >
        <button type="button">Palette</button>
      </SearchDropdown>,
    );

    fireEvent.change(screen.getByTestId("palette-query"), {
      target: { value: "beta" },
    });
    expect(screen.queryByTestId("search-item-a")).toBeNull();

    screen.getByTestId("search-item-b").click();
    expect(onSelect).toHaveBeenCalledWith("b");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders group headers for consecutive items that share a group", () => {
    render(
      <SearchDropdown
        open
        onOpenChange={() => {}}
        title="Keys"
        items={[
          { id: "a", label: "A", group: "Letters" },
          { id: "w", label: "W", group: "Letters" },
          { id: "1", label: "1", group: "Digits" },
        ]}
        onSelect={() => {}}
        data-testid="keys"
      >
        <button type="button">Keys</button>
      </SearchDropdown>,
    );
    const labels = screen
      .getAllByRole("group")
      .flatMap((group) =>
        [...group.querySelectorAll("[data-slot='dropdown-menu-label']")].map(
          (node) => node.textContent,
        ),
      );
    expect(labels).toContain("Letters");
    expect(labels).toContain("Digits");
    expect(screen.getByTestId("search-item-a")).toBeTruthy();
    expect(screen.getByTestId("search-item-1")).toBeTruthy();
  });

  it("hides empty groups when filtering", () => {
    render(
      <SearchDropdown
        open
        onOpenChange={() => {}}
        title="Keys"
        items={[
          { id: "a", label: "A", group: "Letters" },
          { id: "1", label: "1", group: "Digits" },
        ]}
        onSelect={() => {}}
        data-testid="keys"
      >
        <button type="button">Keys</button>
      </SearchDropdown>,
    );
    fireEvent.change(screen.getByTestId("keys-query"), {
      target: { value: "digit" },
    });
    const labels = [...document.querySelectorAll("[data-slot='dropdown-menu-label']")].map(
      (node) => node.textContent,
    );
    expect(labels).toContain("Digits");
    expect(labels).not.toContain("Letters");
    expect(screen.queryByTestId("search-item-a")).toBeNull();
    expect(screen.getByTestId("search-item-1")).toBeTruthy();
  });

  it("shows the empty label when nothing matches", () => {
    render(
      <SearchDropdown
        open
        onOpenChange={() => {}}
        title="Tile Palette"
        items={items}
        emptyLabel="No matches"
        onSelect={() => {}}
        data-testid="palette"
      >
        <button type="button">Palette</button>
      </SearchDropdown>,
    );
    fireEvent.change(screen.getByTestId("palette-query"), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No matches")).toBeTruthy();
  });
});
