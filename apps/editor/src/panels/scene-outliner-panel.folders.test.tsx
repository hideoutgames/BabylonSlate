import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { SerializedScene } from "@babylonslate/core";
import { createActor, createDefaultScene } from "@babylonslate/core";
import { SceneOutlinerPanel, actorRowId, folderRowId } from "./scene-outliner-panel";

/** jsdom has no PointerEvent; a MouseEvent with pointer fields drives TreeView. */
function dispatchPointerEvent(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  init: { clientX: number; clientY: number },
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  target.dispatchEvent(event);
}

const applySceneChange = vi.hoisted(() =>
  vi.fn<(id: string, scene: SerializedScene) => Promise<boolean>>(async () => true),
);
const selectActor = vi.hoisted(() => vi.fn());
const harness = vi.hoisted(() => ({
  scene: null as SerializedScene | null,
  selectedActorIds: [] as string[],
}));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({ documentId: "scene:assets/Main.scene.babasset" }),
}));

vi.mock("../context/scene-editing-context", () => ({
  useSceneEditing: () => ({
    selectedActorIds: harness.selectedActorIds,
    selectActor,
    setSelectedActorIds: vi.fn(),
    frameActor: vi.fn(),
  }),
  selectionAfterLockChange: (ids: string[]) => ids,
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openDocuments: [
      {
        id: "scene:assets/Main.scene.babasset",
        ref: { kind: "scene", path: "assets/Main.scene.babasset", label: "Main" },
        content: harness.scene,
        layout: null,
        dirty: false,
      },
    ],
    applySceneChange,
    assetRegistry: { list: () => [] },
    loadGraphDocument: vi.fn(),
  }),
}));

function renderOutliner(scene: SerializedScene) {
  harness.scene = scene;
  return render(<SceneOutlinerPanel {...({} as IDockviewPanelProps)} />);
}

function lastScene(): SerializedScene {
  const calls = applySceneChange.mock.calls;
  return calls[calls.length - 1]![1];
}

/** TreeView rows are absolutely positioned by index, so drops map by row order. */
function dragRow(fromRowId: string, toRowId: string | null, rowIndex: number) {
  const tree = screen.getByTestId("outliner-tree");
  const row = screen.getByTestId(`tree-row-${fromRowId}`);
  vi.spyOn(tree, "getBoundingClientRect").mockReturnValue({
    top: 0,
    left: 0,
    right: 200,
    bottom: 200,
    width: 200,
    height: 200,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  // Row centre, and always past the 8px drag threshold.
  const targetY = toRowId === null ? 10_000 : rowIndex * 28 + 14;

  dispatchPointerEvent(row, "pointerdown", { clientX: 0, clientY: 0 });
  dispatchPointerEvent(tree, "pointermove", { clientX: 0, clientY: targetY });
  dispatchPointerEvent(tree, "pointerup", { clientX: 0, clientY: targetY });
}

afterEach(() => {
  cleanup();
  applySceneChange.mockClear();
  selectActor.mockClear();
  harness.selectedActorIds = [];
  vi.restoreAllMocks();
});

describe("Scene Outliner folders", () => {
  it("creates a uniquely named folder from the toolbar", () => {
    renderOutliner({ ...createDefaultScene(), folders: [], actors: [] });
    fireEvent.click(screen.getByTestId("outliner-add-folder"));
    expect(lastScene().folders).toEqual([
      { id: "folder-1", name: "New Folder", parentFolderId: null },
    ]);
  });

  it("renames a folder through the row menu", () => {
    renderOutliner({
      ...createDefaultScene(),
      folders: [{ id: "f1", name: "One", parentFolderId: null }],
      actors: [],
    });
    fireEvent.click(screen.getByTestId(`outliner-menu-${folderRowId("f1")}`));
    fireEvent.click(screen.getByTestId("outliner-rename-folder-f1"));
    fireEvent.change(screen.getByTestId("name-prompt-input"), {
      target: { value: "Lighting" },
    });
    fireEvent.click(screen.getByTestId("name-prompt-confirm"));
    expect(lastScene().folders[0]!.name).toBe("Lighting");
  });

  it("promotes actors instead of deleting them when a folder is removed", () => {
    renderOutliner({
      ...createDefaultScene(),
      folders: [
        { id: "outer", name: "Outer", parentFolderId: null },
        { id: "inner", name: "Inner", parentFolderId: "outer" },
      ],
      actors: [{ ...createActor("lamp", "Lamp"), folderId: "inner" }],
    });
    fireEvent.click(screen.getByTestId(`outliner-menu-${folderRowId("inner")}`));
    fireEvent.click(screen.getByTestId("outliner-delete-folder-inner"));

    const next = lastScene();
    expect(next.folders.map((folder) => folder.id)).toEqual(["outer"]);
    expect(next.actors).toHaveLength(1);
    expect(next.actors[0]!.folderId).toBe("outer");
  });

  it("does not offer visibility or lock toggles on a folder row", () => {
    renderOutliner({
      ...createDefaultScene(),
      folders: [{ id: "f1", name: "One", parentFolderId: null }],
      actors: [],
    });
    expect(screen.queryByTestId("outliner-visibility-f1")).toBeNull();
    expect(screen.queryByTestId("outliner-lock-f1")).toBeNull();
  });

  it("clears the actor selection when a folder row is selected", () => {
    harness.selectedActorIds = ["lamp"];
    renderOutliner({
      ...createDefaultScene(),
      folders: [{ id: "f1", name: "One", parentFolderId: null }],
      actors: [createActor("lamp", "Lamp")],
    });
    fireEvent.click(screen.getByTestId(`tree-row-${folderRowId("f1")}`));
    dispatchPointerEvent(
      screen.getByTestId(`tree-row-${folderRowId("f1")}`),
      "pointerdown",
      { clientX: 0, clientY: 0 },
    );
    dispatchPointerEvent(screen.getByTestId("outliner-tree"), "pointerup", {
      clientX: 0,
      clientY: 0,
    });
    expect(selectActor).toHaveBeenCalledWith(null);
  });

  it("moves an actor into a folder without giving it a transform parent", () => {
    renderOutliner({
      ...createDefaultScene(),
      folders: [{ id: "f1", name: "One", parentFolderId: null }],
      actors: [createActor("lamp", "Lamp")],
    });
    // Rows: 0 = folder f1, 1 = actor lamp.
    dragRow(actorRowId("lamp"), folderRowId("f1"), 0);

    const moved = lastScene().actors[0]!;
    expect(moved.folderId).toBe("f1");
    expect(moved.parentId).toBeNull();
  });

  it("keeps actor-on-actor drops as transform parenting", () => {
    renderOutliner({
      ...createDefaultScene(),
      folders: [],
      actors: [createActor("hero", "Hero"), createActor("sword", "Sword")],
    });
    // Rows: 0 = hero, 1 = sword.
    dragRow(actorRowId("sword"), actorRowId("hero"), 0);

    const moved = lastScene().actors.find((actor) => actor.id === "sword")!;
    expect(moved.parentId).toBe("hero");
    expect(moved.folderId).toBeNull();
  });
});
