import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { FolderNode } from "@babylonslate/assets";
import { AlwaysPackageFoldersField } from "./always-package-folders-field";

const node = (path: string, children: FolderNode[] = []): FolderNode => ({
  name: path.split("/").pop()!,
  path,
  children,
  assets: [],
});

const { docs } = vi.hoisted(() => ({
  docs: {
    registryEpoch: 1,
    assetRegistry: null as unknown,
  },
}));

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => docs));

function installRegistry() {
  const trees: Record<string, FolderNode> = {
    project: node("assets", [node("assets/Weapons", [node("assets/Weapons/Rifles")]), node("assets/UI")]),
    "plugin:foo": node("plugins/Foo/assets", [node("plugins/Foo/assets/Props")]),
  };
  docs.assetRegistry = {
    listRoots: () => Object.keys(trees).map((id) => ({ id })),
    folderTree: (id: string) => trees[id],
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

afterEach(() => {
  cleanup();
  docs.assetRegistry = null;
});

describe("AlwaysPackageFoldersField", () => {
  it("lists each folder and badges only the ones that no longer exist", () => {
    installRegistry();
    render(<AlwaysPackageFoldersField folders={["assets/Weapons", "assets/Gone", "plugins/Foo/assets/Props"]} onChange={vi.fn()} />);
    expect(screen.getByTestId("settings-always-package-folders-0").textContent).toBe("assets/Weapons");
    expect(screen.queryByTestId("settings-always-package-folders-0-missing")).toBeNull();
    expect(screen.getByTestId("settings-always-package-folders-1").textContent).toBe("assets/GoneMissing Folder");
    expect(screen.getByTestId("settings-always-package-folders-1-missing").textContent).toBe("Missing Folder");
    expect(screen.queryByTestId("settings-always-package-folders-2-missing")).toBeNull();
  });

  it("removes one folder and keeps the rest", () => {
    installRegistry();
    const onChange = vi.fn();
    render(<AlwaysPackageFoldersField folders={["assets/Weapons", "assets/UI"]} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("settings-always-package-folders-0-remove"));
    expect(onChange).toHaveBeenCalledWith(["assets/UI"]);
  });

  it("adds the folder chosen in the picker, and does not offer one that is already listed", () => {
    installRegistry();
    const onChange = vi.fn();
    render(<AlwaysPackageFoldersField folders={["assets/Weapons"]} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("settings-always-package-folders-add"));
    const picker = screen.getByTestId("settings-always-package-folders-picker");
    const confirm = screen.getByTestId("settings-always-package-folders-picker-confirm");
    expect(confirm.hasAttribute("disabled")).toBe(true);
    // Every content root is offered, including plugin folders.
    expect(within(picker).getByTestId("tree-row-plugins/Foo/assets/Props")).toBeTruthy();
    tap("assets/Weapons");
    expect(confirm.hasAttribute("disabled")).toBe(true);
    tap("assets/Weapons/Rifles");
    expect(screen.getByTestId("settings-always-package-folders-picker-selection").textContent).toContain("assets/Weapons/Rifles");
    fireEvent.click(confirm);
    expect(onChange).toHaveBeenCalledWith(["assets/Weapons", "assets/Weapons/Rifles"]);
    expect(screen.queryByTestId("settings-always-package-folders-picker")).toBeNull();
  });

  it("changes nothing when the picker is cancelled", () => {
    installRegistry();
    const onChange = vi.fn();
    render(<AlwaysPackageFoldersField folders={[]} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("settings-always-package-folders-add"));
    tap("assets/UI");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("settings-always-package-folders-picker")).toBeNull();
  });

  it("marks every folder missing when no project is open", () => {
    render(<AlwaysPackageFoldersField folders={["assets/Weapons"]} onChange={vi.fn()} />);
    expect(screen.getByTestId("settings-always-package-folders-0-missing")).toBeTruthy();
  });
});
