import { describe, expect, it } from "vitest";
import { createDefaultScene } from "./project";
import {
  actorChildren,
  actorSubtree,
  createActor,
  createMeshComponent,
  findActor,
  normalizeScene,
  normalizeTransform,
  wouldCreateComponentCycle,
  wouldCreateCycle,
  type SerializedScene,
} from "./scene";

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
});
