import { describe, expect, it } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { CatalogDialog } from "./catalog-dialog";

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
  });
});
