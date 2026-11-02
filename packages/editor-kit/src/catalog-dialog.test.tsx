import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { CatalogDialog } from "./catalog-dialog";

afterEach(() => {
  cleanup();
});

describe("CatalogDialog", () => {
  it("changes the active category through the compact category picker", () => {
    function Catalog() {
      const [active, setActive] = useState("general");
      return (
        <CatalogDialog
          open
          onOpenChange={() => {}}
          title="Settings"
          categories={[
            { id: "general", label: "General", count: 2 },
            { id: "input", label: "Input", count: 3 },
          ]}
          groups={[{ label: "Project", ids: ["general", "input"] }]}
          activeCategoryId={active}
          onCategoryChange={setActive}
          search=""
          onSearchChange={() => {}}
          data-testid="catalog"
        >
          <p>
            {active === "general" ? "General Preferences" : "Input Preferences"}
          </p>
        </CatalogDialog>
      );
    }
    const { getByRole, getByTestId, getByText } = render(<Catalog />);
    const picker = getByRole("combobox", { name: "Category" });
    expect(picker.textContent).toContain("General");
    fireEvent.click(picker);
    const inputCategory = getByRole("option", { name: /Input/ });
    fireEvent.pointerDown(inputCategory);
    fireEvent.click(inputCategory);
    expect(picker.textContent).toContain("Input");
    expect(getByText("Input Preferences")).toBeTruthy();
    expect(
      getByTestId("catalog-category-input").getAttribute("aria-current"),
    ).toBe("true");
    expect(
      getByTestId("catalog-category-general").getAttribute("aria-current"),
    ).toBeNull();
  });

  it("scrolls the body to the top when a category is picked", () => {
    function Catalog() {
      const [active, setActive] = useState("general");
      return (
        <CatalogDialog
          open
          onOpenChange={() => {}}
          title="Settings"
          categories={[
            { id: "general", label: "General" },
            { id: "input", label: "Input" },
          ]}
          activeCategoryId={active}
          onCategoryChange={setActive}
          search=""
          onSearchChange={() => {}}
          initialScrollTop={120}
          data-testid="catalog"
        >
          <p>{active}</p>
        </CatalogDialog>
      );
    }
    const { getByTestId } = render(<Catalog />);
    const body = getByTestId("catalog-body");
    expect(body.scrollTop).toBe(120);
    fireEvent.click(getByTestId("catalog-category-input"));
    expect(body.scrollTop).toBe(0);
  });

  it("closes a popup on an outside press, not on presses in it or its menus", () => {
    const onOpenChange = vi.fn();
    const { getByTestId } = render(
      <>
        <div data-testid="outside" />
        <div data-popup-picker="" data-testid="nested-menu" />
        <CatalogDialog
          open
          onOpenChange={onOpenChange}
          presentation="popup"
          anchor={{ x: 40, y: 40 }}
          title="Place Actors"
          categories={[{ id: "general", label: "General" }]}
          activeCategoryId="general"
          onCategoryChange={() => {}}
          search=""
          onSearchChange={() => {}}
          data-testid="catalog"
        >
          <p>Body</p>
        </CatalogDialog>
      </>,
    );
    fireEvent.pointerDown(getByTestId("catalog-body"));
    fireEvent.pointerDown(getByTestId("nested-menu"));
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.pointerDown(getByTestId("outside"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

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
    expect(getByTestId("catalog-body")).toBeTruthy();
    expect(document.activeElement).not.toBe(getByPlaceholderText("Search"));
  });

  it("clears search from the trailing button", () => {
    const onSearchChange = vi.fn();
    const { getByTestId } = render(
      <CatalogDialog
        open
        onOpenChange={() => {}}
        title="Settings"
        categories={[{ id: "general", label: "General" }]}
        activeCategoryId="general"
        onCategoryChange={() => {}}
        search="mesh"
        onSearchChange={onSearchChange}
        data-testid="catalog"
      >
        <div>Body</div>
      </CatalogDialog>,
    );
    getByTestId("catalog-search-clear").click();
    expect(onSearchChange).toHaveBeenCalledWith("");
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
    expect(
      getByTestId("catalog-category-general").getAttribute("aria-current"),
    ).toBe("true");
    expect(
      getByTestId("catalog-category-input").hasAttribute("aria-current"),
    ).toBe(false);
  });
});
