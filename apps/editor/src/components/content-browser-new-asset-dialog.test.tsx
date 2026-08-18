import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ContentBrowserNewAssetDialog } from "./content-browser-new-asset-dialog";
import type { CreatableAssetType } from "../lib/content-browser-helpers";

function renderDialog(
  overrides: Partial<Parameters<typeof ContentBrowserNewAssetDialog>[0]> = {},
) {
  const onOpenChange = vi.fn();
  const onTypeChange = vi.fn();
  const onNameChange = vi.fn();
  const onParentClassChange = vi.fn();
  const onCreate = vi.fn();
  const utils = render(
    <ContentBrowserNewAssetDialog
      open
      onOpenChange={onOpenChange}
      type={"Scene" as CreatableAssetType}
      onTypeChange={onTypeChange}
      name=""
      onNameChange={onNameChange}
      parentClass="BObject"
      onParentClassChange={onParentClassChange}
      nameTaken={false}
      onCreate={onCreate}
      {...overrides}
    />,
  );
  return {
    ...utils,
    onOpenChange,
    onTypeChange,
    onNameChange,
    onParentClassChange,
    onCreate,
  };
}

describe("ContentBrowserNewAssetDialog", () => {
  afterEach(() => {
    cleanup();
  });

  it("selects one type card at a time", () => {
    const { onTypeChange } = renderDialog();
    const scene = screen.getByTestId("new-asset-type-Scene");
    const klass = screen.getByTestId("new-asset-type-Class");
    expect(scene.getAttribute("data-selected")).toBe("true");
    expect(klass.getAttribute("data-selected")).toBe("false");
    fireEvent.click(klass);
    expect(onTypeChange).toHaveBeenCalledWith("Class");
  });

  it("shows the parent class picker only for Class", () => {
    const { rerender, onOpenChange, onTypeChange, onNameChange, onParentClassChange, onCreate } =
      renderDialog();
    expect(screen.queryByTestId("new-asset-parent")).toBeNull();
    rerender(
      <ContentBrowserNewAssetDialog
        open
        onOpenChange={onOpenChange}
        type="Class"
        onTypeChange={onTypeChange}
        name=""
        onNameChange={onNameChange}
        parentClass="BObject"
        onParentClassChange={onParentClassChange}
        nameTaken={false}
        onCreate={onCreate}
      />,
    );
    expect(screen.getByTestId("new-asset-parent")).toBeTruthy();
    expect(screen.getByTestId("new-asset-parent-search")).toBeTruthy();
    expect(
      screen.getByTestId("new-asset-parent-BObject").getAttribute("data-selected"),
    ).toBe("true");
    fireEvent.click(screen.getByTestId("new-asset-parent-Actor"));
    expect(onParentClassChange).toHaveBeenCalledWith("Actor");
  });

  it("matches Project Settings CatalogDialog shell size", () => {
    renderDialog();
    const dialog = screen.getByTestId("content-browser-new-asset-dialog");
    expect(dialog.className).toContain("h-[min(90vh,52rem)]");
    expect(dialog.className).toContain("w-[min(96vw,64rem)]");
    expect(dialog.className).not.toContain("h-[min(85vh,40rem)]");
    expect(dialog.className).not.toContain("w-[min(96vw,56rem)]");
  });

  it("uses the Actor icon for Actor subclasses and nested user classes", () => {
    renderDialog({
      type: "Class",
      classAssets: [
        {
          path: "assets/Hero.class.babasset",
          header: { type: "Class", name: "Hero", parentClass: "Actor" },
        },
        {
          path: "assets/Warrior.class.babasset",
          header: { type: "Class", name: "Warrior", parentClass: "Hero" },
        },
      ],
    });
    expect(
      screen
        .getByTestId("new-asset-parent-Hero")
        .querySelector("[data-type-icon]")
        ?.getAttribute("data-type-icon"),
    ).toBe("Actor");
    expect(
      screen
        .getByTestId("new-asset-parent-Warrior")
        .querySelector("[data-type-icon]")
        ?.getAttribute("data-type-icon"),
    ).toBe("Actor");
    expect(
      screen
        .getByTestId("new-asset-parent-Actor")
        .querySelector("[data-type-icon]")
        ?.getAttribute("data-type-icon"),
    ).toBe("Actor");
  });

  it("lists project Classes in the Parent Class tree and filters by search", () => {
    renderDialog({
      type: "Class",
      classAssets: [
        {
          path: "assets/Hero.class.babasset",
          header: { type: "Class", name: "Hero", parentClass: "Actor" },
        },
      ],
    });
    expect(screen.getByTestId("new-asset-parent-Hero")).toBeTruthy();
    expect(screen.getByTestId("new-asset-parent-Hero").getAttribute("data-depth")).toBe(
      "2",
    );
    fireEvent.change(screen.getByTestId("new-asset-parent-search"), {
      target: { value: "Hero" },
    });
    expect(screen.getByTestId("new-asset-parent-Hero")).toBeTruthy();
    expect(screen.queryByTestId("new-asset-parent-GameInstance")).toBeNull();
  });

  it("disables Create when the name is empty or taken", () => {
    const { rerender, onOpenChange, onTypeChange, onNameChange, onParentClassChange, onCreate } =
      renderDialog();
    expect(
      screen.getByTestId("content-browser-new-asset-create").hasAttribute("disabled"),
    ).toBe(true);
    rerender(
      <ContentBrowserNewAssetDialog
        open
        onOpenChange={onOpenChange}
        type="Scene"
        onTypeChange={onTypeChange}
        name="main"
        onNameChange={onNameChange}
        parentClass="BObject"
        onParentClassChange={onParentClassChange}
        nameTaken
        onCreate={onCreate}
      />,
    );
    expect(screen.getByTestId("new-asset-name-taken")).toBeTruthy();
    expect(
      screen.getByTestId("content-browser-new-asset-create").hasAttribute("disabled"),
    ).toBe(true);
  });

  it("creates with the selected type after a name is typed", () => {
    const { onCreate, onNameChange } = renderDialog({ name: "Arena" });
    fireEvent.change(screen.getByTestId("new-asset-name"), {
      target: { value: "Arena2" },
    });
    expect(onNameChange).toHaveBeenCalledWith("Arena2");
    fireEvent.click(screen.getByTestId("content-browser-new-asset-create"));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("tells authors that sounds come from Import, not New Asset", () => {
    renderDialog();
    const hint = screen.getByTestId("new-asset-group-hint-audio");
    expect(hint.textContent).toMatch(/Import/);
    expect(hint.textContent).toMatch(/WAV/);
    expect(hint.textContent).toMatch(/MP3/);
    expect(hint.textContent).toMatch(/OGG/);
  });
});
