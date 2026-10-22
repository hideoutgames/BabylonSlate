import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SearchDropdown } from "./search-dropdown";

const items = [
  { id: "a", label: "Alpha", description: "first" },
  { id: "b", label: "Beta", description: "second" },
];

describe("SearchDropdown", () => {
  afterEach(() => {
    cleanup();
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

  it("lets Escape close the menu even when the search field is focused", () => {
    const onOpenChange = vi.fn();
    render(
      <SearchDropdown
        open
        onOpenChange={onOpenChange}
        title="Keys"
        items={items}
        onSelect={() => {}}
        data-testid="palette"
      >
        <button type="button">Palette</button>
      </SearchDropdown>,
    );
    fireEvent.keyDown(screen.getByTestId("palette-query"), { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("moves from the search field into the results with the arrow keys", async () => {
    const onSelect = vi.fn();
    render(
      <SearchDropdown
        open
        onOpenChange={() => {}}
        title="Keys"
        items={items}
        onSelect={onSelect}
        data-testid="palette"
      >
        <button type="button">Palette</button>
      </SearchDropdown>,
    );
    const query = screen.getByTestId("palette-query");
    query.focus();
    fireEvent.keyDown(query, { key: "ArrowDown" });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId("search-item-a"));
    });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId("search-item-b"));
    });
    fireEvent.click(document.activeElement!);
    expect(onSelect).toHaveBeenCalledWith("b");
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

  it("fades the results edge while more rows are below, and stops once scrolled to the end", () => {
    render(
      <SearchDropdown open title="Types" items={items} onSelect={() => {}} data-testid="palette">
        <button type="button">Types</button>
      </SearchDropdown>,
    );
    const results = screen.getByTestId("palette-results");
    const fade = screen.getByTestId("palette-more-below");
    expect(fade.hasAttribute("data-visible")).toBe(false);
    Object.defineProperties(results, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 300 },
    });
    fireEvent.scroll(results);
    expect(fade.hasAttribute("data-visible")).toBe(true);
    results.scrollTop = 200;
    fireEvent.scroll(results);
    expect(fade.hasAttribute("data-visible")).toBe(false);
  });
});
