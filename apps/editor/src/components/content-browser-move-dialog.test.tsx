import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FolderNode } from "@babylonslate/assets";
import { resolveTypeVisual } from "@babylonslate/editor-kit";
import { ContentBrowserMoveDialog } from "./content-browser-move-dialog";

const tree: FolderNode = {
  name: "assets",
  path: "assets",
  assets: [],
  children: [
    {
      name: "textures",
      path: "assets/textures",
      assets: [],
      children: [
        {
          name: "ui",
          path: "assets/textures/ui",
          assets: [],
          children: [],
        },
      ],
    },
    {
      name: "fx",
      path: "assets/fx",
      assets: [],
      children: [],
    },
  ],
};

function renderDialog(
  overrides: Partial<Parameters<typeof ContentBrowserMoveDialog>[0]> = {},
) {
  const onOpenChange = vi.fn();
  const onDestinationChange = vi.fn();
  const onConfirm = vi.fn();
  const utils = render(
    <ContentBrowserMoveDialog
      open
      onOpenChange={onOpenChange}
      kind="asset"
      name="hero"
      currentFolderPath="assets"
      sourcePath="assets"
      folderTree={tree}
      destinationPath="assets"
      onDestinationChange={onDestinationChange}
      onConfirm={onConfirm}
      typeVisual={resolveTypeVisual({ assetType: "Texture" })}
      {...overrides}
    />,
  );
  return { ...utils, onOpenChange, onDestinationChange, onConfirm };
}

function selectRow(path: string): void {
  const row = screen.getByTestId(`tree-row-${path}`);
  fireEvent.pointerDown(row, { clientX: 8, clientY: 8 });
  fireEvent.pointerUp(row, { clientX: 8, clientY: 8 });
}

describe("ContentBrowserMoveDialog", () => {
  afterEach(() => {
    cleanup();
  });

  it("titles the picker for an asset and shows the item name", () => {
    renderDialog();
    expect(screen.getByTestId("content-browser-move-dialog")).toBeTruthy();
    expect(screen.getByText("Move Asset")).toBeTruthy();
    expect(screen.getByTestId("content-browser-move-item").textContent).toContain(
      "hero",
    );
    expect(
      screen.getByTestId("content-browser-move-confirm").hasAttribute("disabled"),
    ).toBe(true);
  });

  it("titles the picker for a folder", () => {
    renderDialog({
      kind: "folder",
      name: "textures",
      currentFolderPath: "assets",
      sourcePath: "assets/textures",
      destinationPath: "assets",
    });
    expect(screen.getByText("Move Folder")).toBeTruthy();
    expect(screen.getByTestId("content-browser-move-item").textContent).toContain(
      "textures",
    );
  });

  it("enables confirm after a legal destination is selected", () => {
    const { onDestinationChange } = renderDialog({
      destinationPath: "assets/fx",
    });
    expect(onDestinationChange).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("content-browser-move-confirm").hasAttribute("disabled"),
    ).toBe(false);
    fireEvent.click(screen.getByTestId("content-browser-move-confirm"));
  });

  it("calls onConfirm for a legal destination", () => {
    const { onConfirm } = renderDialog({ destinationPath: "assets/fx" });
    fireEvent.click(screen.getByTestId("content-browser-move-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("does not select a folder's current parent or itself as a destination", () => {
    const { onDestinationChange } = renderDialog({
      kind: "folder",
      name: "textures",
      currentFolderPath: "assets",
      sourcePath: "assets/textures",
      destinationPath: "assets/fx",
    });
    selectRow("assets");
    selectRow("assets/textures");
    selectRow("assets/textures/ui");
    expect(onDestinationChange).not.toHaveBeenCalled();
    expect(
      screen
        .getByTestId("tree-row-assets/textures")
        .querySelector(".text-muted-foreground"),
    ).toBeTruthy();
  });

  it("filters the folder tree by search and keeps ancestors of matches", () => {
    renderDialog();
    fireEvent.change(screen.getByTestId("content-browser-move-search"), {
      target: { value: "ui" },
    });
    expect(screen.getByTestId("tree-row-assets/textures/ui")).toBeTruthy();
    expect(screen.getByTestId("tree-row-assets/textures")).toBeTruthy();
    expect(screen.queryByTestId("tree-row-assets/fx")).toBeNull();
  });
});
