import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { CatalogMenu, type CatalogMenuItem } from "./catalog-menu";

afterEach(() => {
  cleanup();
});

const items: CatalogMenuItem[] = [
  { id: "mentions", title: "Late Entry", category: "Alpha", description: "Runs after the beta step." },
  { id: "named", title: "Beta Step", category: "Zulu" },
];

/** Title matches first, then description matches. */
const titleFirst = (all: readonly CatalogMenuItem[], query: string) => {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...all];
  const byTitle = all.filter((item) => item.title.toLowerCase().includes(needle));
  const byDescription = all.filter(
    (item) => !byTitle.includes(item) && (item.description ?? "").toLowerCase().includes(needle),
  );
  return [...byTitle, ...byDescription];
};

function renderMenu(rankedSearch: boolean, onSelect = vi.fn()) {
  const view = render(
    <CatalogMenu
      open
      onOpenChange={() => {}}
      title="Pick"
      items={items}
      onSelect={onSelect}
      filterItems={titleFirst}
      rankedSearch={rankedSearch}
      searchLabel="Search"
      searchPlaceholder="Search"
      treeLabel="Entries"
      data-testid="menu"
    />,
  );
  const search = view.getByPlaceholderText("Search");
  const categories = () =>
    [...document.querySelectorAll('[data-testid^="menu-category-"]')].map((el) =>
      el.getAttribute("data-testid"),
    );
  return { ...view, search, categories, onSelect };
}

describe("CatalogMenu ranked search", () => {
  it("lists categories by best match and highlights the row Enter adds", () => {
    const { search, categories, getByTestId, onSelect } = renderMenu(true);
    expect(categories()).toEqual(["menu-category-Alpha", "menu-category-Zulu"]);
    expect(document.querySelector('[data-active="true"]')).toBeNull();

    fireEvent.change(search, { target: { value: "beta" } });
    expect(categories()).toEqual(["menu-category-Zulu", "menu-category-Alpha"]);
    const target = getByTestId("menu-item-named");
    expect(target.getAttribute("data-active")).toBe("true");
    expect(search.getAttribute("aria-activedescendant")).toBe(target.id);

    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(items[1]);
  });

  it("returns to the A-Z tree when the query is cleared", () => {
    const { search, categories } = renderMenu(true);
    fireEvent.change(search, { target: { value: "beta" } });
    fireEvent.change(search, { target: { value: "" } });
    expect(categories()).toEqual(["menu-category-Alpha", "menu-category-Zulu"]);
    expect(document.querySelector('[data-active="true"]')).toBeNull();
  });

  it("keeps A-Z categories and an unhighlighted first row unless it opts in", () => {
    const { search, categories, onSelect } = renderMenu(false);
    fireEvent.change(search, { target: { value: "beta" } });
    expect(categories()).toEqual(["menu-category-Alpha", "menu-category-Zulu"]);
    expect(document.querySelector('[data-active="true"]')).toBeNull();
    expect(search.getAttribute("aria-activedescendant")).toBeNull();

    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(items[0]);
  });
});
