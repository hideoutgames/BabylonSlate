import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ContentBrowserNewAssetDialog, ContentBrowserNewAssetMenu } from "./content-browser-new-asset-dialog";
import type { CreatableAssetType } from "../lib/content-browser-helpers";

const layout = vi.hoisted(() => ({ phone: false }));
vi.mock("../shell/use-platform-layout", () => ({
  usePhoneLayout: () => layout.phone,
  usePhoneTouchSizing: () => layout.phone,
}));

function renderDialog(
  overrides: Partial<Parameters<typeof ContentBrowserNewAssetDialog>[0]> = {},
) {
  const onOpenChange = vi.fn();
  const onNameChange = vi.fn();
  const onParentClassChange = vi.fn();
  const onCreate = vi.fn();
  const utils = render(
    <ContentBrowserNewAssetDialog
      open
      onOpenChange={onOpenChange}
      type={"Scene" as CreatableAssetType}
      name=""
      onNameChange={onNameChange}
      parentClass="BObject"
      onParentClassChange={onParentClassChange}
      onCreate={onCreate}
      {...overrides}
    />,
  );
  return {
    ...utils,
    onOpenChange,
    onNameChange,
    onParentClassChange,
    onCreate,
  };
}

/** jsdom has no PointerEvent; keep the fields the tree's row gestures read. */
function tap(path: string) {
  const row = screen.getByTestId(`tree-row-${path}`);
  for (const type of ["pointerdown", "pointerup"]) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 8, clientY: 8 });
    Object.defineProperties(event, {
      pointerId: { value: 1 },
      pointerType: { value: "mouse" },
      isPrimary: { value: true },
    });
    fireEvent(row, event);
  }
}

describe("ContentBrowserNewAssetDialog", () => {
  it("lets a Water asset choose Painted rendering before creation", () => {
    const onWaterStyleChange = vi.fn();
    const { onCreate } = renderDialog({ type: "Water", name: "Lagoon", waterStyle: "realistic", onWaterStyleChange });
    expect(screen.queryByRole("button", { name: "Toon" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Painted" }));
    expect(onWaterStyleChange).toHaveBeenCalledWith("stylized");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenCalledOnce();
  });
  afterEach(() => {
    cleanup();
    layout.phone = false;
  });

  it("shows the destination as a Location that opens a folder picker to choose another", () => {
    const onDestinationFolderChange = vi.fn();
    const folderTrees = [{
      name: "assets",
      path: "assets",
      assets: [],
      children: [
        { name: "Levels", path: "assets/Levels", assets: [], children: [] },
        { name: "Props", path: "assets/Props", assets: [], children: [] },
      ],
    }];
    renderDialog({
      destinationFolder: "assets/Levels",
      onDestinationFolderChange,
      folderTrees,
      isFolderDisabled: (path) => path === "assets/Props",
    });
    expect(screen.getByTestId("new-asset-location-path").textContent).toBe("assets/Levels");
    expect(screen.queryByText("File")).toBeNull();
    expect(screen.queryByText("Then")).toBeNull();

    fireEvent.click(screen.getByTestId("new-asset-location"));
    // Opens on the current location, so Choose is ready at once.
    expect(screen.getByTestId("new-asset-location-picker-selection").textContent).toBe("Folder: assets/Levels");
    tap("assets/Props");
    expect(screen.getByTestId("new-asset-location-picker-selection").textContent).toBe("Folder: assets/Levels");
    tap("assets");
    fireEvent.click(screen.getByTestId("new-asset-location-picker-confirm"));
    expect(onDestinationFolderChange).toHaveBeenCalledWith("assets");
    expect(screen.queryByTestId("new-asset-location-picker")).toBeNull();
  });

  it("opens straight to the details of the chosen type on phones", () => {
    layout.phone = true;
    const { onCreate } = renderDialog({ type: "Class", name: "Hero" });
    expect(screen.queryByRole("radiogroup", { name: "Asset Type" })).toBeNull();
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Hero");
    expect(screen.getByRole("tree", { name: "Parent Class" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it("shows the parent class picker only for Class", () => {
    const {
      rerender,
      onOpenChange,
      onNameChange,
      onParentClassChange,
      onCreate,
    } = renderDialog();
    expect(screen.queryByTestId("new-asset-parent")).toBeNull();
    rerender(
      <ContentBrowserNewAssetDialog
        open
        onOpenChange={onOpenChange}
        type="Class"
        name=""
        onNameChange={onNameChange}
        parentClass="BObject"
        onParentClassChange={onParentClassChange}
        onCreate={onCreate}
      />,
    );
    expect(screen.getByTestId("new-asset-parent")).toBeTruthy();
    expect(screen.getByTestId("new-asset-parent-search")).toBeTruthy();
    expect(
      screen
        .getByTestId("tree-row-BObject")
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(screen.getByRole("tree", { name: "Parent Class" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("tree", { name: "Parent Class" }), { key: "Enter" });
    expect(onParentClassChange).toHaveBeenCalledWith("Actor");
  });

  it.each([
    { name: "Hero", takenNameError: null, busy: false, calls: 1 },
    { name: "", takenNameError: null, busy: false, calls: 0 },
    { name: "Hero", takenNameError: "An asset with this name already exists in the folder.", busy: false, calls: 0 },
    { name: "Hero", takenNameError: null, busy: true, calls: 0 },
  ])("validates keyboard creation: %j", ({ calls, ...props }) => {
    const { onCreate } = renderDialog(props);
    fireEvent.keyDown(screen.getByTestId("new-asset-name"), { key: "Enter" });
    expect(onCreate).toHaveBeenCalledTimes(calls);
  });

  it("starts in the Name field on desktop but skips the text field on touch", async () => {
    renderDialog();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("new-asset-name")));
    cleanup();

    const matchMedia = vi.fn((query: string) => ({ matches: query.includes("coarse") }) as MediaQueryList);
    vi.stubGlobal("matchMedia", matchMedia);
    try {
      renderDialog();
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("new-asset-details")));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lists project Classes in the Parent Class tree and filters by search", () => {
    renderDialog({
      type: "Class",
      classAssets: [
        {
          path: "assets/Hero.class.hasset",
          header: { type: "Class", name: "Hero", parentClass: "Actor" },
        },
      ],
    });
    expect(screen.getByTestId("tree-row-Hero")).toBeTruthy();
    expect(
      screen.getByTestId("tree-row-Hero").getAttribute("data-depth"),
    ).toBe("2");
    fireEvent.change(screen.getByTestId("new-asset-parent-search"), {
      target: { value: "Hero" },
    });
    expect(screen.getByTestId("tree-row-Hero")).toBeTruthy();
    expect(screen.queryByTestId("tree-row-GameInstance")).toBeNull();
  });

  it("disables Create when the name is empty or taken", () => {
    const {
      rerender,
      onOpenChange,
      onNameChange,
      onParentClassChange,
      onCreate,
    } = renderDialog();
    expect(
      screen
        .getByTestId("content-browser-new-asset-create")
        .hasAttribute("disabled"),
    ).toBe(true);
    rerender(
      <ContentBrowserNewAssetDialog
        open
        onOpenChange={onOpenChange}
        type="Scene"
        name="main"
        onNameChange={onNameChange}
        parentClass="BObject"
        onParentClassChange={onParentClassChange}
        takenNameError="An asset with this name already exists in the folder."
        onCreate={onCreate}
      />,
    );
    expect(screen.getByTestId("new-asset-name-taken").textContent).toBe("An asset with this name already exists in the folder.");
    expect(
      screen
        .getByTestId("content-browser-new-asset-create")
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it.each([".", "..", "Hero."])("rejects %s as Rename does", (name) => {
    const { onCreate } = renderDialog({ name });
    expect(screen.getByTestId("new-asset-name-invalid").textContent).toMatch(/\.|period/);
    const create = screen.getByTestId("content-browser-new-asset-create");
    expect(create.hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(screen.getByTestId("new-asset-name"), { key: "Enter" });
    expect(onCreate).not.toHaveBeenCalled();
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
});

describe("ContentBrowserNewAssetMenu", () => {
  afterEach(() => cleanup());

  it("lists types under their categories and finds one by its id or its label", () => {
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ContentBrowserNewAssetMenu open onOpenChange={onOpenChange} anchor={{ x: 40, y: 60 }} onSelect={onSelect}>
        <button type="button">New Asset</button>
      </ContentBrowserNewAssetMenu>,
    );
    const menu = screen.getByTestId("new-asset-type-menu");
    const labels = [...menu.querySelectorAll("[data-slot='dropdown-menu-label']")].map((node) => node.textContent);
    expect(labels).toEqual(expect.arrayContaining(["New Asset", "World", "Scripting", "Rendering", "AI"]));

    const query = screen.getByTestId("new-asset-type-menu-query");
    fireEvent.change(query, { target: { value: "InputAction" } });
    expect(screen.getByTestId("search-item-InputAction").textContent).toContain("Input Action");
    expect(screen.queryByTestId("search-item-InputAxis")).toBeNull();

    fireEvent.change(query, { target: { value: "basic particle" } });
    fireEvent.click(screen.getByTestId("search-item-ParticleEmitter"));
    expect(onSelect).toHaveBeenCalledWith("ParticleEmitter");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
