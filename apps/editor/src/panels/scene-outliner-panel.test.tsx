import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  type SerializedScene,
} from "@babylonslate/core";
import {
  actorRowId,
  flattenOutliner,
  folderRowId,
  outlinerRowTarget,
} from "./scene-outliner-panel";

function sceneWith(partial: Partial<SerializedScene>): SerializedScene {
  return { ...createDefaultScene(), actors: [], folders: [], ...partial };
}

afterEach(() => {
  cleanup();
});

describe("flattenOutliner type icons", () => {
  it("uses the mesh glyph for an engine Actor with a MeshComponent", () => {
    const scene = sceneWith({
      actors: [
        createActor("actor-1", "Box", {
          components: [createMeshComponent("mesh-1", "box")],
        }),
      ],
    });
    const nodes = flattenOutliner(scene, { collapsed: new Set(), search: "" });
    const { getByTestId } = render(<>{nodes[0]?.icon}</>);
    const glyph = getByTestId("outliner-type-icon-actor-1");
    expect(glyph.getAttribute("data-type-family")).toBe("class");
    expect(glyph.getAttribute("data-type-icon")).toBe("MeshComponent");
  });

  it("uses the Actor glyph for a user class even when it has a mesh", () => {
    const scene = sceneWith({
      actors: [
        createActor("hero-1", "Hero", {
          classId: "MyHero",
          components: [createMeshComponent("mesh-1", "box")],
        }),
      ],
    });
    const parentOf = (id: string) =>
      ({ MyHero: "Actor", Actor: "BObject", BObject: null })[id] ?? null;
    const nodes = flattenOutliner(scene, {
      collapsed: new Set(),
      search: "",
      parentOf,
    });
    const { getByTestId } = render(<>{nodes[0]?.icon}</>);
    expect(getByTestId("outliner-type-icon-hero-1").getAttribute("data-type-icon")).toBe(
      "Actor",
    );
  });
});

describe("flattenOutliner folders", () => {
  const scene = sceneWith({
    folders: [
      { id: "lighting", name: "Lighting", parentFolderId: null },
      { id: "spots", name: "Spots", parentFolderId: "lighting" },
    ],
    actors: [
      { ...createActor("lamp", "Lamp"), folderId: "spots" },
      { ...createActor("hero", "Hero"), folderId: null },
      { ...createActor("sword", "Sword", { parentId: "hero" }), folderId: null },
    ],
  });

  it("nests folders above root actors and keeps transform children under their parent", () => {
    const nodes = flattenOutliner(scene, { collapsed: new Set(), search: "" });
    expect(nodes.map((node) => [node.id, node.depth])).toEqual([
      [folderRowId("lighting"), 0],
      [folderRowId("spots"), 1],
      [actorRowId("lamp"), 2],
      [actorRowId("hero"), 0],
      [actorRowId("sword"), 1],
    ]);
  });

  it("marks folders that hold something as expandable", () => {
    const nodes = flattenOutliner(scene, { collapsed: new Set(), search: "" });
    const lighting = nodes.find((node) => node.id === folderRowId("lighting"));
    expect(lighting?.hasChildren).toBe(true);

    const empty = flattenOutliner(
      sceneWith({ folders: [{ id: "empty", name: "Empty", parentFolderId: null }] }),
      { collapsed: new Set(), search: "" },
    );
    expect(empty[0]?.hasChildren).toBe(false);
  });

  it("hides folder contents when the folder is collapsed", () => {
    const nodes = flattenOutliner(scene, {
      collapsed: new Set([folderRowId("lighting")]),
      search: "",
    });
    expect(nodes.map((node) => node.id)).toEqual([
      folderRowId("lighting"),
      actorRowId("hero"),
      actorRowId("sword"),
    ]);
  });

  it("matches folder names as well as actor names in search", () => {
    const nodes = flattenOutliner(scene, { collapsed: new Set(), search: "light" });
    expect(nodes.map((node) => node.id)).toEqual([folderRowId("lighting")]);

    const byActor = flattenOutliner(scene, { collapsed: new Set(), search: "lamp" });
    expect(byActor.map((node) => node.id)).toEqual([actorRowId("lamp")]);
  });

  it("shows the folder path for an actor found through search", () => {
    const nodes = flattenOutliner(scene, { collapsed: new Set(), search: "lamp" });
    expect(nodes[0]?.label).toBe("Lighting / Spots / Lamp");
  });
});

describe("outlinerRowTarget", () => {
  it("splits folder and actor rows so selection cannot be confused", () => {
    expect(outlinerRowTarget(folderRowId("lighting"))).toEqual({
      kind: "folder",
      id: "lighting",
    });
    expect(outlinerRowTarget(actorRowId("hero"))).toEqual({
      kind: "actor",
      id: "hero",
    });
    expect(outlinerRowTarget(null)).toBeNull();
  });
});
