import { describe, expect, it } from "vitest";
import { createDefaultScene } from "./project";
import {
  actorChildren,
  actorSubtree,
  actorsInFolder,
  createActor,
  createMeshComponent,
  findActor,
  folderSubtree,
  nextFolderId,
  normalizeScene,
  normalizeTransform,
  wouldCreateComponentCycle,
  wouldCreateCycle,
  wouldCreateFolderCycle,
  type SerializedScene,
} from "./scene";

function foldersScene(): SerializedScene {
  return {
    ...createDefaultScene(),
    folders: [
      { id: "root-folder", name: "Root Folder", parentFolderId: null },
      { id: "child-folder", name: "Child Folder", parentFolderId: "root-folder" },
      { id: "other-folder", name: "Other Folder", parentFolderId: null },
    ],
    actors: [
      { ...createActor("inside", "Inside"), folderId: "child-folder" },
      createActor("outside", "Outside"),
    ],
  };
}

function nestedScene(): SerializedScene {
  return {
    ...createDefaultScene(),
    actors: [
      createActor("root", "Root"),
      createActor("child", "Child", { parentId: "root" }),
      createActor("grandchild", "Grandchild", { parentId: "child" }),
      createActor("other", "Other"),
    ],
  };
}

describe("scene schema", () => {
  it("creates a default scene with one actor carrying a mesh component", () => {
    const scene = createDefaultScene();
    expect(scene.viewportMode).toBe("3d");
    expect(scene.settings.physicsWorld).toBe("3d");
    expect(scene.actors).toHaveLength(1);
    expect(scene.actors[0]?.components[0]?.classId).toBe("MeshComponent");
  });

  it("normalizes a partial payload into a valid scene", () => {
    const scene = normalizeScene({
      name: "Partial",
      viewportMode: "2d",
      actors: [{ id: "a" }],
    });
    expect(scene.viewportMode).toBe("2d");
    expect(scene.actors[0]).toMatchObject({
      id: "a",
      classId: "Actor",
      parentId: null,
      visible: true,
      locked: false,
    });
    expect(scene.settings.grid.tileSize).toBe(1);
    expect(scene.settings.grid.tileSubdivisions).toBe(4);
    expect(scene.settings.grid.showGrid).toBe(true);
    expect(scene.settings.cameraBounds2D).toEqual({ width: 16, height: 9 });
    expect(scene.settings.editorJoystickEnabled).toBe(false);
  });

  it("coerces malformed actors and components so Details can open old projects", () => {
    const scene = normalizeScene({
      actors: [
        {
          name: 12,
          visible: "no",
          locked: 1,
          components: "not-an-array",
        },
        {
          id: "keep",
          classId: "Pawn",
          visible: false,
          locked: true,
          components: [
            { properties: null },
            {
              id: "mesh",
              classId: "MeshComponent",
              properties: { meshKind: "box" },
              parentId: "missing",
            },
          ],
        },
      ],
    });
    expect(scene.actors[0]).toMatchObject({
      id: "actor-0",
      name: "Actor 1",
      classId: "Actor",
      visible: true,
      locked: false,
      components: [],
    });
    expect(scene.actors[1]).toMatchObject({
      id: "keep",
      classId: "Pawn",
      visible: false,
      locked: true,
    });
    expect(scene.actors[1]?.components[0]).toMatchObject({
      id: "component-0",
      classId: "MeshComponent",
      properties: {},
      parentId: null,
    });
    expect(scene.actors[1]?.components[1]).toMatchObject({
      id: "mesh",
      properties: { meshKind: "box" },
      parentId: "missing",
    });
  });

  it("gives duplicated actor ids a unique id so both actors stay addressable", () => {
    const scene = normalizeScene({
      actors: [
        { id: "dupe", name: "First" },
        { id: "dupe", name: "Second" },
        { id: "dupe", name: "Third" },
      ],
    });
    const ids = scene.actors.map((actor) => actor.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe("dupe");
    expect(scene.actors.map((actor) => actor.name)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
  });

  it("keeps parent links pointing at the first actor that owned a duplicated id", () => {
    const scene = normalizeScene({
      actors: [
        { id: "root", name: "Root" },
        { id: "root", name: "Impostor" },
        { id: "child", name: "Child", parentId: "root" },
      ],
    });
    expect(scene.actors[1]!.id).not.toBe("root");
    expect(scene.actors[2]!.parentId).toBe("root");
  });

  it("normalizes a scene without folders to an empty folder list", () => {
    const scene = normalizeScene({ actors: [{ id: "a" }] });
    expect(scene.folders).toEqual([]);
    expect(scene.actors[0]!.folderId).toBeNull();
  });

  it("keeps authored folders and drops malformed rows", () => {
    const scene = normalizeScene({
      folders: [
        { id: "f1", name: "Lighting" },
        { id: "f2", name: "Spots", parentFolderId: "f1" },
        { id: "", name: "Nameless" },
        "junk",
      ],
      actors: [{ id: "a", folderId: "f2" }],
    });
    expect(scene.folders).toEqual([
      { id: "f1", name: "Lighting", parentFolderId: null },
      { id: "f2", name: "Spots", parentFolderId: "f1" },
    ]);
    expect(scene.actors[0]!.folderId).toBe("f2");
  });

  it("clears folder references that no longer exist", () => {
    const scene = normalizeScene({
      folders: [{ id: "f1", name: "Lighting", parentFolderId: "gone" }],
      actors: [{ id: "a", folderId: "missing" }],
    });
    expect(scene.folders[0]!.parentFolderId).toBeNull();
    expect(scene.actors[0]!.folderId).toBeNull();
  });

  it("breaks a folder parent cycle rather than hiding the folders", () => {
    const scene = normalizeScene({
      folders: [
        { id: "f1", name: "One", parentFolderId: "f2" },
        { id: "f2", name: "Two", parentFolderId: "f1" },
      ],
    });
    const roots = scene.folders.filter((folder) => folder.parentFolderId === null);
    expect(roots.length).toBeGreaterThan(0);
  });

  it("gives duplicated folder ids a unique id", () => {
    const scene = normalizeScene({
      folders: [
        { id: "f1", name: "One" },
        { id: "f1", name: "Two" },
      ],
    });
    expect(new Set(scene.folders.map((folder) => folder.id)).size).toBe(2);
  });

  it("keeps the grid visible unless showGrid is explicitly false", () => {
    expect(normalizeScene({}).settings.grid.showGrid).toBe(true);
    expect(
      normalizeScene({ settings: { grid: { showGrid: false } } }).settings.grid
        .showGrid,
    ).toBe(false);
    expect(
      normalizeScene({ settings: { grid: { showGrid: "no" } } }).settings.grid
        .showGrid,
    ).toBe(true);
  });

  it("normalizes editorJoystickEnabled only when explicitly true", () => {
    expect(
      normalizeScene({ settings: { editorJoystickEnabled: true } }).settings
        .editorJoystickEnabled,
    ).toBe(true);
    expect(
      normalizeScene({ settings: { editorJoystickEnabled: "yes" } }).settings
        .editorJoystickEnabled,
    ).toBe(false);
  });

  it("fills additive lighting settings when keys are missing", () => {
    const settings = normalizeScene({}).settings;
    expect(settings.fogColor).toEqual([0.5, 0.5, 0.5]);
    expect(settings.fogStart).toBe(0);
    expect(settings.fogEnd).toBe(100);
    expect(settings.environmentTextureGuid).toBeNull();
    expect(settings.mainCameraActorId).toBeNull();
    expect(settings.mainCameraComponentId).toBeNull();
  });

  it("keeps authored fog, IBL, and Default Camera ids", () => {
    const settings = normalizeScene({
      settings: {
        fogColor: [0.1, 0.2, 0.3],
        fogStart: 4,
        fogEnd: 40,
        environmentTextureGuid: "env-1",
        mainCameraActorId: "cam-actor",
        mainCameraComponentId: "cam-comp",
      },
    }).settings;
    expect(settings.fogColor).toEqual([0.1, 0.2, 0.3]);
    expect(settings.fogStart).toBe(4);
    expect(settings.fogEnd).toBe(40);
    expect(settings.environmentTextureGuid).toBe("env-1");
    expect(settings.mainCameraActorId).toBe("cam-actor");
    expect(settings.mainCameraComponentId).toBe("cam-comp");
  });

  it("drops a Default Camera pick unless both actor and component ids are strings", () => {
    const settings = normalizeScene({
      settings: {
        mainCameraActorId: "cam-actor",
        mainCameraComponentId: 12,
      },
    }).settings;
    expect(settings.mainCameraActorId).toBeNull();
    expect(settings.mainCameraComponentId).toBeNull();
  });

  it("rejects non-positive 2D camera bounds and fractional subdivisions", () => {
    const scene = normalizeScene({
      settings: {
        grid: { tileSubdivisions: 3.7 },
        cameraBounds2D: { width: 0, height: 12 },
      },
    });
    expect(scene.settings.grid.tileSubdivisions).toBe(4);
    expect(scene.settings.cameraBounds2D).toEqual({ width: 16, height: 12 });
  });

  it("normalizes an empty payload to a 3d scene with no actors", () => {
    const scene = normalizeScene(undefined);
    expect(scene).toMatchObject({ viewportMode: "3d", actors: [] });
    expect(scene.settings.physicsWorld).toBe("3d");
  });

  it("defaults physicsWorld from viewportMode when omitted", () => {
    const scene = normalizeScene({ viewportMode: "2d", settings: {} });
    expect(scene.settings.physicsWorld).toBe("2d");
  });

  it("normalizes malformed transforms to identity", () => {
    expect(normalizeTransform({ position: "nope" })).toEqual({
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    });
  });

  it("finds actors and their children", () => {
    const scene = nestedScene();
    expect(findActor(scene, "child")?.name).toBe("Child");
    expect(actorChildren(scene, "root").map((actor) => actor.id)).toEqual([
      "child",
    ]);
    expect(actorChildren(scene, null).map((actor) => actor.id)).toEqual([
      "root",
      "other",
    ]);
  });

  it("collects a subtree regardless of actor ordering", () => {
    const scene = nestedScene();
    scene.actors.reverse();
    expect(actorSubtree(scene, "root").map((actor) => actor.id).sort()).toEqual(
      ["child", "grandchild", "root"],
    );
  });

  it("detects reparent cycles", () => {
    const scene = nestedScene();
    expect(wouldCreateCycle(scene, "root", "grandchild")).toBe(true);
    expect(wouldCreateCycle(scene, "root", "other")).toBe(false);
    expect(wouldCreateCycle(scene, "root", null)).toBe(false);
  });

  it("collects a folder subtree so deletes can promote its contents", () => {
    const scene = foldersScene();
    expect(folderSubtree(scene, "root-folder").map((folder) => folder.id)).toEqual([
      "root-folder",
      "child-folder",
    ]);
  });

  it("rejects folder moves that would create a cycle", () => {
    const scene = foldersScene();
    expect(wouldCreateFolderCycle(scene, "root-folder", "child-folder")).toBe(true);
    expect(wouldCreateFolderCycle(scene, "root-folder", null)).toBe(false);
    expect(wouldCreateFolderCycle(scene, "child-folder", null)).toBe(false);
  });

  it("lists actors by folder in scene order", () => {
    const scene = foldersScene();
    expect(actorsInFolder(scene, "child-folder").map((actor) => actor.id)).toEqual([
      "inside",
    ]);
    expect(actorsInFolder(scene, null).map((actor) => actor.id)).toEqual(["outside"]);
  });

  it("allocates a folder id that no folder is using", () => {
    const scene = foldersScene();
    expect(nextFolderId(scene)).toBe("folder-1");
    expect(
      nextFolderId({
        ...scene,
        folders: [
          ...scene.folders,
          { id: "folder-1", name: "Taken", parentFolderId: null },
        ],
      }),
    ).toBe("folder-2");
  });

  it("detects component reparent cycles", () => {
    const components = [
      createMeshComponent("root"),
      { ...createMeshComponent("child"), parentId: "root" },
      { ...createMeshComponent("leaf"), parentId: "child" },
    ];
    expect(wouldCreateComponentCycle(components, "root", "leaf")).toBe(true);
    expect(wouldCreateComponentCycle(components, "leaf", "root")).toBe(false);
    expect(wouldCreateComponentCycle(components, "child", null)).toBe(false);
  });

  it("creates mesh components with a mesh kind", () => {
    expect(createMeshComponent("c1", "sphere").properties.meshKind).toBe(
      "sphere",
    );
  });

  it("creates mesh components with an identity local transform", () => {
    expect(createMeshComponent("c1", "sphere").transform).toEqual({
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    });
  });

  it("normalizes missing component transforms to identity and keeps authored ones", () => {
    const scene = normalizeScene({
      actors: [
        {
          id: "a",
          components: [
            { id: "mesh", classId: "MeshComponent", properties: { meshKind: "box" } },
            {
              id: "offset",
              classId: "MeshComponent",
              properties: { meshKind: "sphere" },
              transform: { position: [1, 2, 3] },
            },
          ],
        },
      ],
    });
    expect(scene.actors[0]?.components[0]?.transform).toEqual({
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    });
    expect(scene.actors[0]?.components[1]?.transform).toEqual({
      position: [1, 2, 3],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    });
  });
});
