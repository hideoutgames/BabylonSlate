import { describe, expect, it } from "vitest";
import { normalizeScene } from "@babylonslate/core";
import {
  inProcessPlayRuntimeOptions,
  playLoadControl,
  playPhysicsFromOpenDocuments,
  playSceneFromOpenDocuments,
  playIsEnabled,
  resolvePlayScene,
} from "./play-physics";

describe("playLoadControl", () => {
  it("forwards scene physics world, gravity, and the vendored Havok wasm URL", () => {
    const msg = playLoadControl({
      physicsWorld: "2d",
      gravity: [0, -20, 0],
    });
    expect(msg.type).toBe("load");
    expect(msg.sceneAssetGuid).toBe("play-scene");
    expect(msg.physicsWorld).toBe("2d");
    expect(msg.gravity).toEqual([0, -20, 0]);
    expect(msg.havokWasmUrl).toMatch(/\/havok\/HavokPhysics\.wasm$/);
  });

  it("forwards the authored scene document on the load message", () => {
    const scene = {
      name: "Main",
      viewportMode: "3d" as const,
      actors: [{ id: "actor-1", name: "Cube" }],
    };
    const msg = playLoadControl({
      sceneAssetGuid: "scene:assets/main.scene.babasset",
      scene: scene as never,
    });
    expect(msg.sceneAssetGuid).toBe("scene:assets/main.scene.babasset");
    expect(msg.scene).toEqual(scene);
  });

  it("forwards gameInstanceClass and extra scenes for changescene", () => {
    const extra = {
      name: "Level2",
      viewportMode: "3d" as const,
      actors: [],
    };
    const msg = playLoadControl({
      gameInstanceClass: "MyGame",
      scenes: [{ guid: "Level2", scene: extra as never }],
    });
    expect(msg.gameInstanceClass).toBe("MyGame");
    expect(msg.scenes).toEqual([{ guid: "Level2", scene: extra }]);
  });

  it("defaults to a 3d world and standard gravity", () => {
    const msg = playLoadControl({});
    expect(msg.physicsWorld).toBe("3d");
    expect(msg.gravity).toEqual([0, -9.81, 0]);
    expect(msg.sceneAssetGuid).toBe("play-scene");
  });
});

describe("playPhysicsFromOpenDocuments", () => {
  it("reads physicsWorld and gravity from the active scene document", () => {
    expect(
      playPhysicsFromOpenDocuments(
        [
          {
            id: "scene:level",
            ref: { kind: "scene" },
            content: {
              settings: { physicsWorld: "2d", gravity: [0, -12, 0] },
            },
          },
        ],
        "scene:level",
      ),
    ).toEqual({
      physicsWorld: "2d",
      gravity: [0, -12, 0],
    });
  });

  it("falls back to the first open scene when the active tab is not a scene", () => {
    expect(
      playPhysicsFromOpenDocuments(
        [
          {
            id: "graph:main",
            ref: { kind: "graph" },
            content: {},
          },
          {
            id: "scene:level",
            ref: { kind: "scene" },
            content: {
              settings: { physicsWorld: "3d", gravity: [0, -9.81, 0] },
            },
          },
        ],
        "graph:main",
      ),
    ).toEqual({
      physicsWorld: "3d",
      gravity: [0, -9.81, 0],
    });
  });

  it("falls back to 3d defaults when no scene is open", () => {
    expect(playPhysicsFromOpenDocuments([], null)).toEqual({
      physicsWorld: "3d",
      gravity: [0, -9.81, 0],
    });
  });
});

describe("playSceneFromOpenDocuments", () => {
  it("returns the active scene document payload for Play load", () => {
    const content = {
      name: "Level",
      viewportMode: "2d" as const,
      settings: { physicsWorld: "2d" },
      actors: [{ id: "hero", name: "Hero" }],
    };
    expect(
      playSceneFromOpenDocuments(
        [
          {
            id: "scene:assets/level.scene.babasset",
            ref: { kind: "scene" },
            content,
          },
        ],
        "scene:assets/level.scene.babasset",
      ),
    ).toEqual({
      sceneAssetGuid: "scene:assets/level.scene.babasset",
      scene: normalizeScene(content),
    });
  });

  it("returns null when no scene document is open", () => {
    expect(playSceneFromOpenDocuments([], null)).toBeNull();
  });

  it("playIsEnabled is false when no scene tab is open", () => {
    expect(
      playIsEnabled(
        [{ id: "graph:main", ref: { kind: "graph" }, content: {} }],
        "graph:main",
      ),
    ).toBe(false);
  });

  it("playIsEnabled is true when a scene tab is open even if it is not active", () => {
    expect(
      playIsEnabled(
        [
          { id: "content-browser", ref: { kind: "content-browser" }, content: null },
          {
            id: "scene:level",
            ref: { kind: "scene" },
            content: { name: "Level", actors: [] },
          },
        ],
        "content-browser",
      ),
    ).toBe(true);
  });

  it("resolvePlayScene does not fall back to a startup scene when no scene tab is open", () => {
    const fallback = {
      sceneAssetGuid: "scene:assets/main.scene.babasset",
      scene: normalizeScene({
        name: "Main",
        viewportMode: "3d" as const,
        actors: [{ id: "hero", name: "Hero" }],
      }),
    };
    expect(
      resolvePlayScene({
        documents: [
          { id: "graph:main", ref: { kind: "graph" }, content: {} },
        ],
        activeDocumentId: "graph:main",
        fallback,
      }),
    ).toBeNull();
  });

  it("does not export a path-based startup-scene Play loader", async () => {
    const mod = await import("./play-physics");
    expect("collectPlayStartupScene" in mod).toBe(false);
  });

  it("resolvePlayScene prefers an open scene tab over the startup fallback", () => {
    const open = {
      name: "Level",
      viewportMode: "2d" as const,
      actors: [{ id: "open", name: "Open" }],
    };
    const fallback = {
      sceneAssetGuid: "scene:assets/main.scene.babasset",
      scene: normalizeScene({
        name: "Main",
        actors: [{ id: "hero", name: "Hero" }],
      }),
    };
    expect(
      resolvePlayScene({
        documents: [
          {
            id: "scene:assets/level.scene.babasset",
            ref: { kind: "scene" },
            content: open,
          },
        ],
        activeDocumentId: "scene:assets/level.scene.babasset",
        fallback,
      }),
    ).toEqual({
      sceneAssetGuid: "scene:assets/level.scene.babasset",
      scene: normalizeScene(open),
    });
  });
});

describe("inProcessPlayRuntimeOptions", () => {
  it("includes the vendored Havok wasm URL so in-process Play does not stay on AABB", () => {
    const options = inProcessPlayRuntimeOptions({
      physicsWorld: "3d",
      gravity: [0, -9.81, 0],
    });
    expect(options.physicsWorld).toBe("3d");
    expect(options.gravity).toEqual([0, -9.81, 0]);
    expect(options.havokWasmUrl).toMatch(/\/havok\/HavokPhysics\.wasm$/);
  });
});
