import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { CatalogDialog } from "./catalog-dialog";

afterEach(() => {
  cleanup();
});

describe("CatalogDialog", () => {
  it("renders categories and search", () => {
    const onSearchChange = vi.fn();
    const onCategoryChange = vi.fn();
    const { getByTestId, getByPlaceholderText } = render(
      <CatalogDialog
        open
        onOpenChange={() => {}}
        title="Settings"
        categories={[
          { id: "general", label: "General" },
          { id: "input", label: "Input" },
        ]}
        activeCategoryId="general"
        onCategoryChange={onCategoryChange}
        search=""
        onSearchChange={onSearchChange}
        data-testid="catalog"
      >
        <div>Body</div>
      </CatalogDialog>,
    );

    expect(getByTestId("catalog")).toBeTruthy();
    expect(getByTestId("catalog-category-general")).toBeTruthy();
    fireEvent.change(getByPlaceholderText("Search"), {
      target: { value: "input" },
    });
    expect(onSearchChange).toHaveBeenCalledWith("input");
    fireEvent.click(getByTestId("catalog-category-input"));
    expect(onCategoryChange).toHaveBeenCalledWith("input");
    expect(getByPlaceholderText("Search").getAttribute("data-autofocus-search")).toBeNull();
  });

  it("autofocuses search only when requested", () => {
    const { getByPlaceholderText } = render(
      <CatalogDialog
        open
        onOpenChange={() => {}}
        title="Add node"
        categories={[{ id: "all", label: "All" }]}
        activeCategoryId="all"
        onCategoryChange={() => {}}
        search=""
        onSearchChange={() => {}}
        autoFocusSearch
      >
        <div>Body</div>
      </CatalogDialog>,
    );

    expect(getByPlaceholderText("Search").getAttribute("data-autofocus-search")).toBe(
      "true",
    );
  });

  it("renders grouped category headings", () => {
    const { getByText, getByTestId } = render(
      <CatalogDialog
        open
        onOpenChange={() => {}}
        title="Settings"
        categories={[
          { id: "general", label: "General" },
          { id: "input", label: "Input" },
          { id: "close", label: "Close" },
        ]}
        groups={[
          { label: "Project", ids: ["general", "input"] },
          { label: "Session", ids: ["close"] },
        ]}
        activeCategoryId="general"
        onCategoryChange={() => {}}
        search=""
        onSearchChange={() => {}}
        data-testid="catalog"
      >
        <div>Body</div>
      </CatalogDialog>,
    );

    expect(getByText("Project")).toBeTruthy();
    expect(getByText("Session")).toBeTruthy();
    expect(getByTestId("catalog-category-general")).toBeTruthy();
    expect(getByTestId("catalog-category-close")).toBeTruthy();
    expect(getByTestId("catalog-category-general").className).toContain(
      "border-l-foreground",
    );
    expect(getByTestId("catalog-category-input").className).toContain(
      "border-l-transparent",
    );
  });
});
