import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ContentBrowserFolderTile } from "./content-browser-folder-tile";

describe("ContentBrowserFolderTile", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not bubble pointer events to an empty-grid listener", () => {
    const onGridPointerDown = vi.fn();
    const onOpen = vi.fn();
    const onSelect = vi.fn();
    const onLongPressMenu = vi.fn();
    render(
      <div onPointerDown={onGridPointerDown}>
        <ContentBrowserFolderTile
          path="assets/fx"
          name="fx"
          selected={false}
          onOpen={onOpen}
          onSelect={onSelect}
          onLongPressMenu={onLongPressMenu}
        />
      </div>,
    );
    fireEvent.pointerDown(screen.getByTestId("content-folder-assets/fx"), {
      pointerType: "touch",
    });
    expect(onGridPointerDown).not.toHaveBeenCalled();
  });
});
