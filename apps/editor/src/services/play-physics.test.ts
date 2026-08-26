import { describe, expect, it } from "vitest";
import { normalizeScene } from "@babylonslate/core";
import {
  canonicalPlaySceneGuid,
  inProcessPlayRuntimeOptions,
  playLoadControl,
  playPhysicsFromOpenDocuments,
  playSceneFromOpenDocuments,
  playIsEnabled,
  resolvePlayScene,
  resolvePreviewStartupGuid,
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

  it("forwards infinite loop detection onto the load message", () => {
    const msg = playLoadControl({
      infiniteLoopDetection: false,
      loopCount: 50,
    });
    expect(msg.infiniteLoopDetection).toBe(false);
    expect(msg.loopCount).toBe(50);
  });

  it("forwards audioAssetGuids onto the load message", () => {
    const msg = playLoadControl({
      audioAssetGuids: ["audio-1"],
    });
    expect(msg.audioAssetGuids).toEqual(["audio-1"]);
  });

  it("forwards SceneLayer documents onto the load message", () => {
    const layer = { name: "HUD", actors: [] };
    const msg = playLoadControl({
      sceneLayers: [{ guid: "hud", layer: layer as never }],
    });
    expect(msg.sceneLayers).toEqual([{ guid: "hud", layer }]);
  });

  it("forwards animClipCatalog onto the load message", () => {
    const catalog = [
      {
        guid: "walk-1",
        type: "Animation",
        name: "Walk",
        clipName: "Walk",
        durationMs: 200,
      },
    ];
    const msg = playLoadControl({
      animClipCatalog: catalog,
    });
    expect(msg.animClipCatalog).toEqual(catalog);
  });

  it("defaults to a 3d world and standard gravity", () => {
    const msg = playLoadControl({});
    expect(msg.physicsWorld).toBe("3d");
    expect(msg.gravity).toEqual([0, -9.81, 0]);
    expect(msg.sceneAssetGuid).toBe("play-scene");
  });
});

describe("playPhysicsFromOpenDocuments", () => {
  it("uses an asset guid for runtime scene changes when the path is indexed", () => {
    const scene = {
      sceneAssetGuid: "scene:assets/main.scene.babasset",
      scene: normalizeScene({ name: "Main" }),
      path: "assets/main.scene.babasset",
    };
    expect(
      canonicalPlaySceneGuid(scene, (path) =>
        path === scene.path ? "scene-guid-main" : null,
      ),
    ).toBe("scene-guid-main");
    expect(canonicalPlaySceneGuid(scene, () => null)).toBe(
      "scene:assets/main.scene.babasset",
    );
  });

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
            ref: { kind: "scene", path: "assets/level.scene.babasset" },
            content,
          },
        ],
        "scene:assets/level.scene.babasset",
      ),
    ).toEqual({
      sceneAssetGuid: "scene:assets/level.scene.babasset",
      scene: normalizeScene(content),
      path: "assets/level.scene.babasset",
    });
  });

  it("returns null when no scene document is open", () => {
    expect(playSceneFromOpenDocuments([], null)).toBeNull();
  });

  it("playIsEnabled is true without a scene tab when Preview Build is on", () => {
    expect(
      playIsEnabled(
        [{ id: "graph:main", ref: { kind: "graph" }, content: {} }],
        "graph:main",
        { previewBuild: true },
      ),
    ).toBe(true);
  });

  it("playIsEnabled is true without a scene tab when Play from Scene is off and startup exists", () => {
    expect(
      playIsEnabled(
        [{ id: "graph:main", ref: { kind: "graph" }, content: {} }],
        "graph:main",
        { playFromScene: false, hasStartupScene: true },
      ),
    ).toBe(true);
  });

  it("playIsEnabled is true without a scene tab when Play from Scene is on and startup exists", () => {
    expect(
      playIsEnabled(
        [{ id: "graph:main", ref: { kind: "graph" }, content: {} }],
        "graph:main",
        { playFromScene: true, hasStartupScene: true },
      ),
    ).toBe(true);
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

  it("resolvePlayScene falls back to startup when Play from Scene is on and no scene tab is open", () => {
    const fallback = {
      sceneAssetGuid: "startup-guid",
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
        playFromScene: true,
        fallback,
      }),
    ).toEqual(fallback);
  });

  it("resolvePlayScene ignores the open tab when Play from Scene is off", () => {
    const open = {
      name: "Level",
      viewportMode: "2d" as const,
      actors: [{ id: "open", name: "Open" }],
    };
    const fallback = {
      sceneAssetGuid: "startup-guid",
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
        playFromScene: false,
        fallback,
      }),
    ).toEqual(fallback);
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

describe("resolvePreviewStartupGuid", () => {
  it("uses the open scene guid when Play from Scene is on", () => {
    expect(
      resolvePreviewStartupGuid({
        playFromScene: true,
        openSceneGuid: "open-guid",
        startupSceneGuid: "startup-guid",
      }),
    ).toBe("open-guid");
  });

  it("falls back to project startup when Play from Scene is on but no scene is open", () => {
    expect(
      resolvePreviewStartupGuid({
        playFromScene: true,
        openSceneGuid: null,
        startupSceneGuid: "startup-guid",
      }),
    ).toBe("startup-guid");
  });

  it("always uses project startup when Play from Scene is off", () => {
    expect(
      resolvePreviewStartupGuid({
        playFromScene: false,
        openSceneGuid: "open-guid",
        startupSceneGuid: "startup-guid",
      }),
    ).toBe("startup-guid");
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
