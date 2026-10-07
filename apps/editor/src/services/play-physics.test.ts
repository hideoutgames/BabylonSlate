import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeScene } from "@babylonslate/core";
import { createRuntimeFromLoad } from "@babylonslate/runtime";
import {
  canonicalPlaySceneGuid,
  playLoadControl,
  playPhysicsFromOpenDocuments,
  playSceneFromOpenDocuments,
  playIsEnabled,
  resolvePlayScene,
  resolvePreviewStartupGuid,
} from "./play-physics";

describe("playLoadControl", () => {
  it("initializes console readback with the editor session frame cap", () => {
    const runtime = createRuntimeFromLoad(playLoadControl({ frameCap: 30 }), () => {});
    try {
      expect(runtime.executeConsoleCommand("framecap").output).toBe("framecap 30");
    } finally {
      runtime.stop();
    }
  });

  it.each([
    { traceByteBudget: 1024, retainedTicks: [] },
    { traceByteBudget: 32 * 1024, retainedTicks: [1, 2, 3, 4, 5, 6, 7, 8] },
  ])("retains trace frames according to the Play load budget of $traceByteBudget bytes", ({ traceByteBudget, retainedTicks }) => {
    const runtime = createRuntimeFromLoad(playLoadControl({
      traceByteBudget,
      scene: normalizeScene({ name: "Trace", actors: [] }),
    }), () => {});
    try {
      const world = runtime.getWorld();
      const actor = world.createActor({
        classId: "Actor",
        guid: "trace-probe",
        variables: { payload: "x".repeat(1024) },
      });
      world.spawnActorNow(actor);
      runtime.start();
      runtime.executeConsoleCommand("snapshot start");
      for (let i = 0; i < 8; i++) runtime.tick();
      runtime.executeConsoleCommand("snapshot stop");
      expect(runtime.stopTrace()?.frames.map((frame) => frame.tickIndex)).toEqual(retainedTicks);
      expect(runtime.stopTrace()?.retention).toMatchObject(traceByteBudget === 1024
        ? { byteBudget: traceByteBudget, complete: false, droppedFrames: 1, stopReason: "oversized-frame" }
        : { byteBudget: traceByteBudget, complete: true, droppedFrames: 0, stopReason: "requested" });
    } finally {
      runtime.stop();
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each(["/", "/BabylonSlate/"])(
    "loads Havok from the editor deployment at %s in every Play host",
    (base) => {
      vi.stubEnv("BASE_URL", base);
      vi.stubGlobal("location", { origin: "https://hideoutgames.github.io" });
      const expected = `https://hideoutgames.github.io${base}havok/HavokPhysics.wasm`;
      expect(playLoadControl({}).havokWasmUrl).toBe(expected);
    },
  );

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
    expect(msg.deferSceneModelsReady).toBe(true);
  });

  const scene = { name: "Main", viewportMode: "3d" as const, actors: [] };
  const layer = { name: "HUD", actors: [] };
  const clip = {
    guid: "walk-1",
    type: "Animation",
    name: "Walk",
    clipName: "Walk",
    durationMs: 200,
  };
  it.each([
    {
      field: "the authored scene document",
      input: { sceneAssetGuid: "scene:assets/main.scene.babasset", scene: scene as never },
      expected: { sceneAssetGuid: "scene:assets/main.scene.babasset", scene },
    },
    {
      field: "gameInstanceClass and extra scenes for changescene",
      input: {
        gameInstanceClass: "MyGame",
        scenes: [{ guid: "Level2", scene: scene as never }],
        sceneNavmeshBytes: { Level2: new Uint8Array([2]) },
      },
      expected: {
        gameInstanceClass: "MyGame",
        scenes: [{ guid: "Level2", scene }],
        sceneNavmeshBytes: { Level2: new Uint8Array([2]) },
      },
    },
    {
      field: "infinite loop detection",
      input: { infiniteLoopDetection: false, loopCount: 50 },
      expected: { infiniteLoopDetection: false, loopCount: 50 },
    },
    {
      field: "audioAssetGuids",
      input: { audioAssetGuids: ["audio-1"] },
      expected: { audioAssetGuids: ["audio-1"] },
    },
    {
      field: "SceneLayer documents",
      input: { sceneLayers: [{ guid: "hud", layer: layer as never }] },
      expected: { sceneLayers: [{ guid: "hud", layer }] },
    },
    {
      field: "animClipCatalog",
      input: { animClipCatalog: [clip] },
      expected: { animClipCatalog: [clip] },
    },
  ])("forwards $field onto the load message", ({ input, expected }) => {
    expect(playLoadControl(input)).toMatchObject(expected);
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
