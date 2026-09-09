import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Button } from "@babylonslate/ui/components/button";
import { ContentBrowserSelectionActions } from "./content-browser-selection-actions";

describe("ContentBrowserSelectionActions", () => {
  afterEach(() => {
    cleanup();
  });

  it("matches the shared outline styling for counted Delete and invokes only its delete action", () => {
    const onDeselectAll = vi.fn();
    const onRequestDelete = vi.fn();
    render(
      <Button variant="outline" size="sm">
        Outline Reference
      </Button>,
    );
    render(
      <ContentBrowserSelectionActions
        selectionCount={2}
        busy={false}
        onDeselectAll={onDeselectAll}
        onRequestDelete={onRequestDelete}
      />,
    );

    const deselect = screen.getByTestId("content-browser-deselect-all");
    const del = screen.getByTestId("content-browser-delete-selected");
    expect(deselect.textContent).toContain("Deselect All");
    expect(del.textContent).toMatch(/Delete \(2\)/);
    expect(del.className).toBe(
      screen.getByRole("button", { name: "Outline Reference" }).className,
    );

    fireEvent.click(del);
    expect(onRequestDelete).toHaveBeenCalledTimes(1);
    expect(onDeselectAll).not.toHaveBeenCalled();
  });

  it("renders nothing when the selection is empty", () => {
    render(
      <ContentBrowserSelectionActions
        selectionCount={0}
        busy={false}
        onDeselectAll={vi.fn()}
        onRequestDelete={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("content-browser-delete-selected")).toBeNull();
    expect(screen.queryByTestId("content-browser-deselect-all")).toBeNull();
  });
});
