import { describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  type SerializedScene,
} from "@babylonslate/core";
import { actorRowId, folderRowId } from "../panels/scene-outliner-panel";
import {
  applyOutlinerDropMoves,
  outlinerTreeDropMoves,
} from "./outliner-drop";

function scene(partial: Partial<SerializedScene>): SerializedScene {
  return { ...createDefaultScene(), folders: [], actors: [], ...partial };
}

describe("outlinerTreeDropMoves", () => {
  it("moves only the dragged row when it is not in the selection", () => {
    const world = scene({
      folders: [{ id: "dest", name: "Dest", parentFolderId: null }],
      actors: [createActor("a", "A"), createActor("b", "B")],
    });
    expect(
      outlinerTreeDropMoves({
        dragRowId: actorRowId("b"),
        targetRowId: folderRowId("dest"),
        selectedRowIds: [actorRowId("a")],
        scene: world,
      }),
    ).toEqual([
      { kind: "actor", id: "b", parentId: null, folderId: "dest" },
    ]);
  });

  it("omits a selected child when its transform parent is also selected", () => {
    const world = scene({
      folders: [{ id: "dest", name: "Dest", parentFolderId: null }],
      actors: [
        createActor("parent", "Parent"),
        createActor("child", "Child", { parentId: "parent" }),
      ],
    });
    expect(
      outlinerTreeDropMoves({
        dragRowId: actorRowId("parent"),
        targetRowId: folderRowId("dest"),
        selectedRowIds: [actorRowId("parent"), actorRowId("child")],
        scene: world,
      }),
    ).toEqual([
      { kind: "actor", id: "parent", parentId: null, folderId: "dest" },
    ]);
  });

  it("omits a nested folder when an ancestor folder is also selected", () => {
    const world = scene({
      folders: [
        { id: "outer", name: "Outer", parentFolderId: null },
        { id: "inner", name: "Inner", parentFolderId: "outer" },
        { id: "dest", name: "Dest", parentFolderId: null },
      ],
    });
    expect(
      outlinerTreeDropMoves({
        dragRowId: folderRowId("outer"),
        targetRowId: folderRowId("dest"),
        selectedRowIds: [folderRowId("outer"), folderRowId("inner")],
        scene: world,
      }),
    ).toEqual([{ kind: "folder", id: "outer", parentFolderId: "dest" }]);
  });

  it("omits an actor that lives in a selected folder subtree", () => {
    const world = scene({
      folders: [
        { id: "pack", name: "Pack", parentFolderId: null },
        { id: "dest", name: "Dest", parentFolderId: null },
      ],
      actors: [createActor("lamp", "Lamp", { folderId: "pack" })],
    });
    expect(
      outlinerTreeDropMoves({
        dragRowId: folderRowId("pack"),
        targetRowId: folderRowId("dest"),
        selectedRowIds: [folderRowId("pack"), actorRowId("lamp")],
        scene: world,
      }),
    ).toEqual([{ kind: "folder", id: "pack", parentFolderId: "dest" }]);
  });

  it("moves sibling actors onto a folder, an actor, or empty space", () => {
    const world = scene({
      folders: [{ id: "dest", name: "Dest", parentFolderId: null }],
      actors: [
        createActor("a", "A"),
        createActor("b", "B"),
        createActor("hero", "Hero"),
      ],
    });
    const selected = [actorRowId("a"), actorRowId("b")];
    expect(
      outlinerTreeDropMoves({
        dragRowId: actorRowId("a"),
        targetRowId: folderRowId("dest"),
        selectedRowIds: selected,
        scene: world,
      }),
    ).toEqual([
      { kind: "actor", id: "a", parentId: null, folderId: "dest" },
      { kind: "actor", id: "b", parentId: null, folderId: "dest" },
    ]);
    expect(
      outlinerTreeDropMoves({
        dragRowId: actorRowId("a"),
        targetRowId: actorRowId("hero"),
        selectedRowIds: selected,
        scene: world,
      }),
    ).toEqual([
      { kind: "actor", id: "a", parentId: "hero", folderId: null },
      { kind: "actor", id: "b", parentId: "hero", folderId: null },
    ]);
    expect(
      outlinerTreeDropMoves({
        dragRowId: actorRowId("a"),
        targetRowId: null,
        selectedRowIds: selected,
        scene: world,
      }),
    ).toEqual([
      { kind: "actor", id: "a", parentId: null, folderId: null },
      { kind: "actor", id: "b", parentId: null, folderId: null },
    ]);
  });

  it("returns no moves when dropping onto a selected descendant", () => {
    const world = scene({
      actors: [
        createActor("parent", "Parent"),
        createActor("child", "Child", { parentId: "parent" }),
      ],
    });
    expect(
      outlinerTreeDropMoves({
        dragRowId: actorRowId("parent"),
        targetRowId: actorRowId("child"),
        selectedRowIds: [actorRowId("parent"), actorRowId("child")],
        scene: world,
      }),
    ).toEqual([]);
  });

  it("returns no moves when mixed folders and actors drop onto an actor", () => {
    const world = scene({
      folders: [{ id: "pack", name: "Pack", parentFolderId: null }],
      actors: [createActor("lamp", "Lamp"), createActor("hero", "Hero")],
    });
    expect(
      outlinerTreeDropMoves({
        dragRowId: folderRowId("pack"),
        targetRowId: actorRowId("hero"),
        selectedRowIds: [folderRowId("pack"), actorRowId("lamp")],
        scene: world,
      }),
    ).toEqual([]);
  });

  it("does not invent extra actors when applying collapsed folder and actor moves", () => {
    const world = scene({
      folders: [
        { id: "outer", name: "Outer", parentFolderId: null },
        { id: "inner", name: "Inner", parentFolderId: "outer" },
        { id: "dest", name: "Dest", parentFolderId: null },
      ],
      actors: [
        createActor("parent", "Parent"),
        createActor("child", "Child", { parentId: "parent" }),
        createActor("lamp", "Lamp", { folderId: "outer" }),
      ],
    });
    const moves = outlinerTreeDropMoves({
      dragRowId: folderRowId("outer"),
      targetRowId: folderRowId("dest"),
      selectedRowIds: [
        folderRowId("outer"),
        folderRowId("inner"),
        actorRowId("parent"),
        actorRowId("child"),
        actorRowId("lamp"),
      ],
      scene: world,
    });
    const next = applyOutlinerDropMoves(world, moves);
    expect(next.actors.map((actor) => actor.id)).toEqual([
      "parent",
      "child",
      "lamp",
    ]);
    expect(next.folders).toHaveLength(3);
    expect(next.folders.find((folder) => folder.id === "outer")?.parentFolderId).toBe(
      "dest",
    );
    expect(next.folders.find((folder) => folder.id === "inner")?.parentFolderId).toBe(
      "outer",
    );
    expect(next.actors.find((actor) => actor.id === "parent")?.folderId).toBe("dest");
    expect(next.actors.find((actor) => actor.id === "child")?.parentId).toBe("parent");
    expect(next.actors.find((actor) => actor.id === "lamp")?.folderId).toBe("outer");
  });
});
