import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import {
  createActor,
  createDefaultScene,
  type SerializedActor,
  type SerializedScene,
} from "@haptic/core";
import {
  actorRowId,
  folderRowId,
  outlinerRowTarget,
} from "../lib/outliner-drop";
import { flattenOutliner, sameOutlinerStructure } from "../lib/outliner-structure";

function sceneWith(partial: Partial<SerializedScene>): SerializedScene {
  return { ...createDefaultScene(), actors: [], folders: [], ...partial };
}

afterEach(() => {
  cleanup();
});

describe("flattenOutliner type icons", () => {
  it("distinguishes existing duplicate actor names in the tree and search", () => {
    const scene = sceneWith({ actors: [createActor("cam-a", "Camera"), createActor("cam-b", "Camera")] });
    for (const search of ["", "camera"]) {
      expect(flattenOutliner(scene, { collapsed: new Set(), search }).map((node) => node.label))
        .toEqual(["Camera (cam-a)", "Camera (cam-b)"]);
    }
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

  it("lists rows at the root when their parent is missing or loops back to them", () => {
    const nodes = flattenOutliner(sceneWith({
      folders: [
        { id: "lost", name: "Lost", parentFolderId: "gone-folder" },
        { id: "ring-a", name: "Ring A", parentFolderId: "ring-b" },
        { id: "ring-b", name: "Ring B", parentFolderId: "ring-a" },
      ],
      actors: [
        { ...createActor("orphan", "Orphan", { parentId: "gone-actor" }), folderId: "gone-folder" },
        { ...createActor("loop-a", "Loop A", { parentId: "loop-b" }), folderId: null },
        { ...createActor("loop-b", "Loop B", { parentId: "loop-a" }), folderId: null },
        { ...createActor("tail", "Tail", { parentId: "loop-a" }), folderId: null },
      ],
    }), { collapsed: new Set(), search: "" });
    expect(nodes.map((node) => [node.id, node.depth])).toEqual([
      [folderRowId("lost"), 0],
      [folderRowId("ring-a"), 0],
      [folderRowId("ring-b"), 0],
      [actorRowId("orphan"), 0],
      [actorRowId("loop-a"), 0],
      [actorRowId("tail"), 1],
      [actorRowId("loop-b"), 0],
    ]);
  });
});

describe("sameOutlinerStructure", () => {
  const hero: SerializedActor = {
    ...createActor("hero", "Hero", { components: [{ id: "mesh", classId: "MeshComponent", properties: {} }] }),
    folderId: "props",
  };
  const scene = sceneWith({
    folders: [{ id: "props", name: "Props", parentFolderId: null }],
    actors: [hero],
  });
  const edited = (actor: Partial<SerializedActor>, folders = scene.folders) =>
    sceneWith({ folders, actors: [{ ...hero, ...actor }] });

  it.each([
    ["a transform edit", edited({ transform: { ...hero.transform, position: [4, 0, 0] } }), true],
    ["a component property edit", edited({ components: hero.components.map((component) => ({ ...component, properties: { size: 2 } })) }), true],
    ["a rename", edited({ name: "Villain" }), false],
    ["a visibility change", edited({ visible: false }), false],
    ["a lock change", edited({ locked: true }), false],
    ["a reparent", edited({ parentId: "other" }), false],
    ["a folder move", edited({ folderId: null }), false],
    ["a class change", edited({ classId: "Character" }), false],
    ["an added component", edited({ components: [...hero.components, { id: "light", classId: "PointLightComponent", properties: {} }] }), false],
    ["a folder rename", edited({}, [{ id: "props", name: "Set Dressing", parentFolderId: null }]), false],
  ])("treats %s as keeping the rows: %s", (_label, next, same) => {
    expect(sameOutlinerStructure(scene, next)).toBe(same);
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
