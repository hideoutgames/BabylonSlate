import { useMemo } from "react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { SerializedScene } from "@babylonslate/core";
import { createActor, createDefaultScene } from "@babylonslate/core";
import { SceneOutlinerPanel } from "./scene-outliner-panel";
import { SceneEditingProvider } from "../context/scene-editing-context";
import { EditorSessionStateProvider } from "../context/editor-session-state-context";
import { KeybindProvider } from "../context/keybind-context";

if (
  typeof window !== "undefined" &&
  typeof window.PointerEvent === "undefined"
) {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const applySceneChange = vi.hoisted(() =>
  vi.fn<(id: string, scene: SerializedScene) => Promise<boolean>>(
    async () => true,
  ),
);
const openDocument = vi.hoisted(() => vi.fn());
const frameActor = vi.hoisted(() => vi.fn());
const harness = vi.hoisted(() => ({
  documentPath: "assets/Main.scene.babasset",
  phone: false,
  assetListReads: 0,
  keybindReads: 0,
  registryEpoch: 0,
  scene: null as SerializedScene | null,
  assets: [] as Array<{
    path: string;
    header: { type: string; name: string; guid?: string };
  }>,
}));

const assetRegistry = vi.hoisted(() => ({
  list: () => {
    harness.assetListReads++;
    return harness.assets;
  },
}));

vi.mock("../shell/use-platform-layout", () => ({
  usePhoneLayout: () => harness.phone,
}));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({
    documentId: `scene:${harness.documentPath}`,
  }),
}));

// Counts chord lookups: building a row menu reads one per shortcut it shows.
vi.mock("../context/keybind-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../context/keybind-context")>();
  return {
    ...actual,
    useKeybindings: () => {
      const bindings = actual.useKeybindings();
      return useMemo(
        () =>
          ({
            get: (commandId: Parameters<typeof bindings.get>[0]) => {
              harness.keybindReads++;
              return bindings.get(commandId);
            },
          }) as typeof bindings,
        [bindings],
      );
    },
  };
});

vi.mock("../context/scene-editing-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../context/scene-editing-context")>();
  return {
    ...actual,
    useSceneEditing: () => ({ ...actual.useSceneEditing(), frameActor }),
  };
});

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: [
    {
      id: `scene:${harness.documentPath}`,
      ref: {
        kind: "scene",
        path: harness.documentPath,
        label: "Main",
      },
      content: harness.scene,
      layout: null,
      dirty: false,
    },
  ],
  applySceneChange,
  assetRegistry,
  registryEpoch: harness.registryEpoch,
  loadGraphDocument: vi.fn(),
  openDocument,
})));

afterEach(() => {
  cleanup();
  applySceneChange.mockClear();
  openDocument.mockClear();
  frameActor.mockClear();
  harness.assets = [];
  harness.documentPath = "assets/Main.scene.babasset";
  harness.phone = false;
  harness.assetListReads = 0;
  harness.keybindReads = 0;
  harness.registryEpoch = 0;
});

describe("SceneOutlinerPanel menus", () => {
  it("pastes a copied actor into an empty scene after switching documents", async () => {
    harness.scene = { ...createDefaultScene(), actors: [createActor("actor-1", "Copied Cube")] };
    const panel = () => <KeybindProvider><EditorSessionStateProvider><SceneEditingProvider>
      <SceneOutlinerPanel {...({} as IDockviewPanelProps)} />
    </SceneEditingProvider></EditorSessionStateProvider></KeybindProvider>;
    const view = render(panel());
    fireEvent.click(screen.getByTestId("outliner-menu-actor-1"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(applySceneChange).not.toHaveBeenCalled();
    harness.documentPath = "assets/Empty.scene.babasset";
    harness.scene = { ...createDefaultScene(), actors: [] };
    view.rerender(panel());
    const tree = screen.getByRole("tree");
    tree.focus();
    fireEvent.keyDown(tree, { key: "v", code: "KeyV", ctrlKey: true });
    await waitFor(() => expect(applySceneChange).toHaveBeenCalledOnce());
    const [documentId, pasted] = applySceneChange.mock.calls[0]!;
    expect(documentId).toBe("scene:assets/Empty.scene.babasset");
    expect(pasted.actors).toEqual([expect.objectContaining({ name: "Copied Cube Copy" })]);
  });

  it("bounds actor and asset reads when selection rebuilds many row menus", async () => {
    let actorIdReads = 0;
    const scene = createDefaultScene();
    scene.actors = Array.from({ length: 100 }, (_, index) => ({
      ...createActor(`actor-${index}`, `Actor ${index}`),
      get id() {
        actorIdReads++;
        return `actor-${index}`;
      },
    }));
    harness.scene = scene;
    render(
      <SceneEditingProvider>
        <SceneOutlinerPanel {...({} as IDockviewPanelProps)} />
      </SceneEditingProvider>,
    );
    actorIdReads = 0;
    harness.assetListReads = 0;

    fireEvent.click(screen.getByTestId("outliner-menu-actor-0"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Select" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(screen.getByTestId("outliner-menu-actor-0"));

    expect(screen.getByRole("menuitem", { name: "Deselect" })).toBeTruthy();
    expect(actorIdReads).toBeLessThanOrEqual(10 * scene.actors.length);
    expect(harness.assetListReads).toBeLessThanOrEqual(4);
  });
  it("builds menu items only for the row menu that opens, not for every row on selection", async () => {
    const scene = createDefaultScene();
    scene.actors = Array.from({ length: 100 }, (_, index) =>
      createActor(`actor-${index}`, `Actor ${index}`),
    );
    harness.scene = scene;
    render(
      <SceneEditingProvider>
        <SceneOutlinerPanel {...({} as IDockviewPanelProps)} />
      </SceneEditingProvider>,
    );
    harness.keybindReads = 0;

    fireEvent.click(screen.getByTestId("outliner-menu-actor-3"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Select" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    expect(
      screen.getByTestId("tree-row-actor:actor-3").getAttribute("aria-selected"),
    ).toBe("true");
    // One menu shows a handful of chords; a menu per row would read hundreds.
    expect(harness.keybindReads).toBeLessThanOrEqual(40);
  });
  it.each([
    ["Duplicate", "outliner-duplicate-actor-1", ["Cube", "Cube Copy"]],
    ["Delete", "outliner-delete-actor-1", []],
  ])("applies %s from an open row menu to the Scene as it is after an edit that landed while the menu was open", (_name, itemTestId, actorNames) => {
    const scene = createDefaultScene();
    scene.actors = [createActor("actor-1", "Cube")];
    harness.scene = scene;
    const panel = () => (
      <SceneEditingProvider>
        <SceneOutlinerPanel {...({} as IDockviewPanelProps)} />
      </SceneEditingProvider>
    );
    const view = render(panel());
    fireEvent.click(screen.getByTestId("outliner-menu-actor-1"));
    expect(screen.getByTestId(itemTestId)).toBeTruthy();

    // An edit made elsewhere (a gizmo drag, an Undo) lands while the menu is open.
    harness.scene = { ...scene, name: "Edited While Open" };
    view.rerender(panel());
    fireEvent.click(screen.getByTestId(itemTestId));

    const written = applySceneChange.mock.calls.at(-1)?.[1] as SerializedScene;
    expect(written.name).toBe("Edited While Open");
    expect(written.actors.map((actor) => actor.name)).toEqual(actorNames);
  });
  it("lists assets added to the registry while Place Actors was closed when it reopens", async () => {
    const scene = createDefaultScene();
    scene.actors = [createActor("actor-1", "Cube")];
    harness.scene = scene;
    harness.assets = [
      { path: "assets/Hero.sprite.babasset", header: { type: "Sprite", name: "Hero", guid: "hero-sprite" } },
    ];
    const panel = () => (
      <SceneEditingProvider>
        <SceneOutlinerPanel {...({} as IDockviewPanelProps)} />
      </SceneEditingProvider>
    );
    const view = render(panel());

    fireEvent.click(screen.getByTestId("outliner-add-actor"));
    fireEvent.click(screen.getByTestId("place-actors-catalog-category-Project"));
    expect(screen.getByTestId("place-actors-item-asset-hero-sprite")).toBeTruthy();
    expect(screen.queryByTestId("place-actors-item-asset-villain-sprite")).toBeNull();
    // Placing closes the dialog.
    fireEvent.click(screen.getByTestId("place-actors-item-asset-hero-sprite"));
    await waitFor(() => expect(screen.queryByTestId("place-actors-catalog")).toBeNull());

    harness.assets = [
      ...harness.assets,
      { path: "assets/Villain.sprite.babasset", header: { type: "Sprite", name: "Villain", guid: "villain-sprite" } },
    ];
    harness.registryEpoch += 1;
    view.rerender(panel());
    fireEvent.click(screen.getByTestId("outliner-add-actor"));
    fireEvent.click(screen.getByTestId("place-actors-catalog-category-Project"));
    expect(screen.getByTestId("place-actors-item-asset-hero-sprite")).toBeTruthy();
    expect(screen.getByTestId("place-actors-item-asset-villain-sprite")).toBeTruthy();
  });
  it("moves focus into the outliner while the Place Actors dialog is still closing", async () => {
    const scene = createDefaultScene();
    scene.actors = [createActor("actor-1", "Cube")];
    harness.scene = scene;
    // A pending animation keeps the closing dialog mounted, as its real exit does.
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: () => [{ finished: new Promise(() => undefined) }],
    });
    onTestFinished(() => {
      Reflect.deleteProperty(Element.prototype, "getAnimations");
    });
    render(
      <SceneEditingProvider>
        <SceneOutlinerPanel {...({} as IDockviewPanelProps)} />
      </SceneEditingProvider>,
    );

    fireEvent.click(screen.getByTestId("outliner-add-actor"));
    fireEvent.click(await screen.findByTestId("place-actors-item-shape-box"));

    await waitFor(() => expect(document.querySelector('[data-slot="dialog-content"][data-closed]')).not.toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("tree"));
  });
  it("toggles an actor from the menu without replacing other selected actors", async () => {
    const scene = createDefaultScene();
    scene.actors = [
      createActor("actor-1", "Cube"),
      createActor("actor-2", "Sphere"),
    ];
    harness.scene = scene;
    render(
      <SceneEditingProvider>
        <SceneOutlinerPanel {...({} as IDockviewPanelProps)} />
      </SceneEditingProvider>,
    );
    fireEvent.click(screen.getByTestId("outliner-menu-actor-1"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Select" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(screen.getByTestId("outliner-menu-actor-2"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Select" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(
      screen
        .getAllByRole("treeitem")
        .map((row) => row.getAttribute("aria-selected")),
    ).toEqual(["true", "true"]);
    fireEvent.click(screen.getByTestId("outliner-menu-actor-1"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Deselect" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(
      screen
        .getAllByRole("treeitem")
        .map((row) => row.getAttribute("aria-selected")),
    ).toEqual(["false", "true"]);
    fireEvent.click(screen.getByTestId("outliner-menu-actor-2"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Deselect" }));
    expect(
      screen
        .getAllByRole("treeitem")
        .map((row) => row.getAttribute("aria-selected")),
    ).toEqual(["false", "false"]);
    expect(applySceneChange).not.toHaveBeenCalled();
  });
  it("frames the actor from its row menu and exposes visibility state", () => {
    harness.scene = createDefaultScene();
    harness.scene.actors = [createActor("actor-1", "Cube", { visible: false })];
    render(<SceneEditingProvider><SceneOutlinerPanel {...({} as IDockviewPanelProps)} /></SceneEditingProvider>);
    expect(
      screen
        .getByTestId("outliner-visibility-actor-1")
        .getAttribute("aria-pressed"),
    ).toBe("false");
    fireEvent.click(screen.getByTestId("outliner-menu-actor-1"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Frame Selection" }));
    expect(frameActor).toHaveBeenCalledWith("actor-1");
  });

  it("opens Duplicate/Delete from the row menu button", async () => {
    const scene = createDefaultScene();
    scene.actors = [createActor("actor-1", "Cube")];
    harness.scene = scene;
    render(
      <SceneEditingProvider>
        <SceneOutlinerPanel {...({} as IDockviewPanelProps)} />
      </SceneEditingProvider>,
    );
    fireEvent.click(screen.getByTestId("outliner-menu-actor-1"));
    fireEvent.click(screen.getByTestId("outliner-duplicate-actor-1"));
    const duplicated = applySceneChange.mock.calls[0]?.[1] as SerializedScene;
    expect(duplicated.actors.map((actor) => actor.name)).toEqual(["Cube", "Cube Copy"]);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(screen.getByTestId("outliner-menu-actor-1"));
    fireEvent.click(screen.getByTestId("outliner-delete-actor-1"));
    const next = applySceneChange.mock.calls.at(-1)?.[1] as SerializedScene;
    expect(next.actors.find((actor) => actor.id === "actor-1")).toBeUndefined();
  });

  it.each([
    {
      clicked: "parent",
      choice: "Cancel",
      remaining: null,
      selected: ["parent", "child", "other"],
    },
    {
      clicked: "parent",
      choice: "Delete This Object",
      remaining: ["other", "unselected", "untouched"],
      selected: ["other"],
    },
    {
      clicked: "parent",
      choice: "Delete Selected (3)",
      remaining: ["unselected", "untouched"],
      selected: [],
    },
    {
      clicked: "unselected",
      choice: "Delete This Object",
      remaining: ["parent", "child", "other", "untouched"],
      selected: ["parent", "child", "other"],
    },
    {
      clicked: "unselected",
      choice: "Delete Selected (3)",
      remaining: ["unselected", "untouched"],
      selected: [],
    },
  ])("offers $choice from $clicked's menu without losing the selection", async ({
    clicked, choice, remaining, selected,
  }) => {
    const scene = createDefaultScene();
    scene.actors = [
      createActor("parent", "Parent"),
      createActor("child", "Child", { parentId: "parent" }),
      createActor("other", "Other"),
      createActor("unselected", "Unselected"),
      createActor("untouched", "Untouched"),
    ];
    harness.scene = scene;
    render(
      <SceneEditingProvider>
        <SceneOutlinerPanel {...({} as IDockviewPanelProps)} />
      </SceneEditingProvider>,
    );
    for (const id of ["parent", "child", "other"]) {
      fireEvent.click(screen.getByTestId(`outliner-menu-${id}`));
      fireEvent.click(screen.getByRole("menuitem", { name: "Select" }));
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    }

    const menu = screen.getByTestId(`outliner-menu-${clicked}`);
    fireEvent.pointerDown(menu, { pointerType: "mouse", button: 0 });
    fireEvent.pointerUp(menu, { pointerType: "mouse", button: 0 });
    fireEvent.click(menu);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(applySceneChange).not.toHaveBeenCalled();
    expect(screen.getAllByRole("treeitem", { hidden: true }).map((row) =>
      row.getAttribute("aria-selected"),
    )).toEqual(["true", "true", "true", "false", "false"]);

    fireEvent.click(screen.getByRole("button", { name: choice }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    if (remaining) {
      // Parent and child selections still produce one undoable scene edit.
      expect(applySceneChange).toHaveBeenCalledTimes(1);
      expect(applySceneChange.mock.calls[0]?.[1].actors.map((actor) => actor.id))
        .toEqual(remaining);
    } else {
      expect(applySceneChange).not.toHaveBeenCalled();
    }
    expect(screen.getAllByRole("treeitem").map((row) =>
      row.getAttribute("aria-selected"),
    )).toEqual(scene.actors.map((actor) => String(selected.includes(actor.id))));
  });

  it("omits Open Actor for engine Actor classes", () => {
    const scene = createDefaultScene();
    scene.actors = [createActor("actor-1", "Cube")];
    harness.scene = scene;
    render(
      <SceneEditingProvider>
        <SceneOutlinerPanel {...({} as IDockviewPanelProps)} />
      </SceneEditingProvider>,
    );
    fireEvent.click(screen.getByTestId("outliner-menu-actor-1"));
    expect(screen.queryByTestId("outliner-open-actor-actor-1")).toBeNull();
  });

  it("opens the current project Class after registry and actor changes", async () => {
    const scene = createDefaultScene();
    scene.actors = [createActor("actor-1", "Hero", { classId: "Hero" })];
    harness.scene = scene;
    harness.assets = [
      {
        path: "assets/Hero.class.babasset",
        header: { type: "Class", name: "Hero", guid: "hero-guid" },
      },
    ];
    const { rerender } = render(
      <SceneEditingProvider>
        <SceneOutlinerPanel {...({} as IDockviewPanelProps)} />
      </SceneEditingProvider>,
    );
    fireEvent.click(screen.getByTestId("outliner-menu-actor-1"));
    fireEvent.click(screen.getByTestId("outliner-open-actor-actor-1"));
    expect(openDocument).toHaveBeenCalledWith({
      kind: "graph",
      path: "assets/Hero.class.babasset",
      label: "Hero",
    });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    // Registry identity stays stable when entries are replaced or moved.
    harness.assets[0] = {
      path: "assets/Characters/Hero.class.babasset",
      header: { type: "Class", name: "Hero", guid: "hero-guid" },
    };
    harness.registryEpoch += 1;
    rerender(
      <SceneEditingProvider>
        <SceneOutlinerPanel {...({} as IDockviewPanelProps)} />
      </SceneEditingProvider>,
    );
    fireEvent.click(screen.getByTestId("outliner-menu-actor-1"));
    fireEvent.click(screen.getByTestId("outliner-open-actor-actor-1"));
    expect(openDocument).toHaveBeenLastCalledWith({
      kind: "graph",
      path: "assets/Characters/Hero.class.babasset",
      label: "Hero",
    });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    harness.scene = {
      ...scene,
      actors: [createActor("actor-1", "Hero", { classId: "Actor" })],
    };
    rerender(
      <SceneEditingProvider>
        <SceneOutlinerPanel {...({} as IDockviewPanelProps)} />
      </SceneEditingProvider>,
    );
    fireEvent.click(screen.getByTestId("outliner-menu-actor-1"));
    expect(screen.queryByTestId("outliner-open-actor-actor-1")).toBeNull();
  });
});
