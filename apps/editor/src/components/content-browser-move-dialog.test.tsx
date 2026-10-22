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
      assetPaths={["assets/hero.babasset"]}
      folderPaths={[]}
      folderTrees={[tree]}
      destinationPath="assets"
      onDestinationChange={onDestinationChange}
      onConfirm={onConfirm}
      typeVisual={resolveTypeVisual({ assetType: "Texture" })}
      {...overrides}
    />,
  );
  return { ...utils, onOpenChange, onDestinationChange, onConfirm };
}

/** Tap a row; jsdom has no PointerEvent, so keep the fields the row gesture reads. */
function selectRow(path: string): void {
  const row = screen.getByTestId(`tree-row-${path}`);
  for (const type of ["pointerdown", "pointerup"]) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 8, clientY: 8 });
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
    fireEvent(row, event);
  }
}

describe("ContentBrowserMoveDialog", () => {
  afterEach(() => {
    cleanup();
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
      assetPaths: [],
      folderPaths: ["assets/textures"],
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

  it("titles a multi-item move and blocks destinations that are selected folders", () => {
    const { onDestinationChange } = renderDialog({
      kind: "folder",
      name: "3 items",
      itemCount: 3,
      currentFolderPath: "assets",
      folderPaths: ["assets/textures", "assets/audio"],
      assetPaths: ["assets/hero.babasset"],
      destinationPath: "assets/fx",
    });
    expect(screen.getByText("Move 3 items")).toBeTruthy();
    selectRow("assets/textures");
    expect(onDestinationChange).not.toHaveBeenCalled();
  });

  it("explains that Copy cannot put a folder inside itself", () => {
    renderDialog({
      kind: "folder",
      operation: "copy",
      assetPaths: [],
      folderPaths: ["assets/textures"],
      destinationPath: "assets/textures/ui",
    });
    expect(screen.getByTestId("content-browser-move-problem").textContent)
      .toBe("Choose a different folder. A folder cannot be copied inside itself.");
    expect(screen.getByTestId("content-browser-move-confirm").hasAttribute("disabled")).toBe(true);
  });

  it("offers writable plugin folders as Move destinations and shows how the move changes plugin content without blocking it", () => {
    const pluginTree: FolderNode = { name: "Tool Pack", path: "plugins/tools/assets", assets: [], children: [
      { name: "Props", path: "plugins/tools/assets/Props", assets: [], children: [] },
    ] };
    const engineTree: FolderNode = { name: "Starter (Read Only)", path: "plugins/starter/assets", assets: [], children: [] };
    const warning = "Tool Pack will use Rock from outside the plugin. A copy of the plugin exported or installed in another project will be missing it.";
    const { onDestinationChange, onConfirm } = renderDialog({
      folderTrees: [tree, pluginTree, engineTree],
      rootPaths: ["assets", "plugins/tools/assets", "plugins/starter/assets"],
      readOnlyRootPaths: ["plugins/starter/assets"],
      destinationPath: "plugins/tools/assets/Props",
      warnings: [warning],
    });
    selectRow("plugins/tools/assets");
    expect(onDestinationChange).toHaveBeenCalledWith("plugins/tools/assets");
    const labelMuted = (path: string) =>
      screen.getByTestId(`tree-row-${path}`).querySelector("span.truncate")?.classList.contains("text-muted-foreground");
    expect(labelMuted("plugins/starter/assets")).toBe(true);
    expect(labelMuted("plugins/tools/assets/Props")).toBe(false);
    expect(screen.getByTestId("content-browser-move-warnings").textContent).toContain(warning);
    fireEvent.click(screen.getByTestId("content-browser-move-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("blocks a Move into a folder that already has a file of the same name", () => {
    const { onDestinationChange } = renderDialog({
      destinationPath: "assets/fx",
      existingPaths: new Set(["assets/fx/hero.babasset", "assets/textures/hero.babasset"]),
    });
    expect(screen.getByTestId("content-browser-move-problem").textContent)
      .toBe('Choose a different folder. "hero.babasset" already exists in assets/fx.');
    expect(screen.getByTestId("content-browser-move-confirm").hasAttribute("disabled")).toBe(true);
    selectRow("assets/textures");
    expect(onDestinationChange).not.toHaveBeenCalled();
  });
});
