import { afterEach, describe, expect, it } from "vitest";
import type { ControlMessage } from "@babylonslate/bridge";
import {
  loadedBackendModules,
  resetHavokModuleCache,
  resetLoadedBackendModules,
} from "@babylonslate/physics";
import {
  createRuntimeFromLoad,
  runtimeOptionsFromLoadControl,
  unmatchedScriptSpawns,
} from "./play-load";

describe("runtimeOptionsFromLoadControl", () => {
  it("maps a load control message onto runtime physics options", () => {
    const msg = {
      type: "load",
      sceneAssetGuid: "play-scene",
      seed: 7,
      physicsWorld: "2d",
      gravity: [0, -20, 0],
      havokWasmUrl: "/havok/HavokPhysics.wasm",
    } satisfies ControlMessage;
    expect(runtimeOptionsFromLoadControl(msg)).toEqual({
      seed: 7,
      physicsWorld: "2d",
      gravity: [0, -20, 0],
      havokWasmUrl: "/havok/HavokPhysics.wasm",
      playScene: undefined,
      playSceneGuid: "play-scene",
      seedDemoActors: true,
      gameInstanceClass: undefined,
      sceneLibrary: undefined,
      sceneGuidByKey: undefined,
      includeDebugCommands: undefined,
      infiniteLoopDetection: undefined,
      loopCount: undefined,
    });
  });

  it("forwards infinite loop detection settings onto the runtime", () => {
    expect(
      runtimeOptionsFromLoadControl({
        type: "load",
        sceneAssetGuid: "play-scene",
        includeDebugCommands: true,
        infiniteLoopDetection: false,
        loopCount: 42,
      }),
    ).toMatchObject({
      includeDebugCommands: true,
      infiniteLoopDetection: false,
      loopCount: 42,
    });
  });

  it("forwards audioAssetGuids onto the runtime", () => {
    expect(
      runtimeOptionsFromLoadControl({
        type: "load",
        sceneAssetGuid: "play-scene",
        audioAssetGuids: ["audio-1", "audio-2"],
      }),
    ).toMatchObject({
      audioAssetGuids: ["audio-1", "audio-2"],
    });
  });

  it("forwards animClipCatalog onto the runtime", () => {
    expect(
      runtimeOptionsFromLoadControl({
        type: "load",
        sceneAssetGuid: "play-scene",
        animClipCatalog: [
          {
            guid: "walk-1",
            type: "Animation",
            name: "Walk",
            clipName: "Walk",
            durationMs: 200,
          },
        ],
      }),
    ).toMatchObject({
      animClipCatalog: [
        {
          guid: "walk-1",
          type: "Animation",
          name: "Walk",
          clipName: "Walk",
          durationMs: 200,
        },
      ],
    });
  });

  it("forwards gameInstanceClass and a scene library for changescene", () => {
    const scene = { name: "Level2", actors: [] };
    expect(
      runtimeOptionsFromLoadControl({
        type: "load",
        sceneAssetGuid: "play-scene",
        gameInstanceClass: "MyGame",
        scenes: [{ guid: "Level2", scene: scene as never }],
      }),
    ).toMatchObject({
      gameInstanceClass: "MyGame",
      sceneLibrary: { Level2: scene },
      sceneGuidByKey: { Level2: "Level2" },
    });
  });

  it("maps a scene display name back to the asset guid", () => {
    const scene = { name: "Level 2", actors: [] };
    expect(
      runtimeOptionsFromLoadControl({
        type: "load",
        sceneAssetGuid: "play-scene",
        scenes: [{ guid: "scene-2", scene: scene as never }],
      }),
    ).toMatchObject({
      sceneLibrary: { "scene-2": scene, "Level 2": scene },
      sceneGuidByKey: { "scene-2": "scene-2", "Level 2": "scene-2" },
    });
  });

  it("defaults to a 3d world when the load message omits physics fields", () => {
    expect(
      runtimeOptionsFromLoadControl({
        type: "load",
        sceneAssetGuid: "play-scene",
      }),
    ).toEqual({
      seed: 1,
      physicsWorld: "3d",
      gravity: [0, -9.81, 0],
      havokWasmUrl: undefined,
      playScene: undefined,
      playSceneGuid: "play-scene",
      seedDemoActors: true,
      gameInstanceClass: undefined,
      sceneLibrary: undefined,
      sceneGuidByKey: undefined,
      includeDebugCommands: undefined,
      infiniteLoopDetection: undefined,
      loopCount: undefined,
    });
  });
});

describe("createRuntimeFromLoad", () => {
  afterEach(() => {
    resetLoadedBackendModules();
  });

  it("loadPhysics for a 3d load becomes HavokPhysicsBackend", async () => {
    resetLoadedBackendModules();
    const runtime = createRuntimeFromLoad(
      {
        type: "load",
        sceneAssetGuid: "play-scene",
        physicsWorld: "3d",
      },
      () => {},
    );
    await runtime.loadPhysics();
    expect(runtime.getPhysicsSync()!.getBackend().constructor.name).toBe(
      "HavokPhysicsBackend",
    );
    expect(loadedBackendModules.havok).toBe(true);
    expect(loadedBackendModules.rapier).toBe(false);
    runtime.stop();
  });

  it("loadPhysics for a 2d load becomes Rapier2DPhysicsBackend and skips Havok", async () => {
    resetLoadedBackendModules();
    const runtime = createRuntimeFromLoad(
      {
        type: "load",
        sceneAssetGuid: "play-scene",
        physicsWorld: "2d",
      },
      () => {},
    );
    await runtime.loadPhysics();
    expect(runtime.getPhysicsSync()!.getBackend().constructor.name).toBe(
      "Rapier2DPhysicsBackend",
    );
    expect(loadedBackendModules.rapier).toBe(true);
    expect(loadedBackendModules.havok).toBe(false);
    runtime.stop();
  });

  it("loadPhysics forwards havokWasmUrl to the Havok wasm loader", async () => {
    resetHavokModuleCache();
    resetLoadedBackendModules();
    const requested: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    try {
      const runtime = createRuntimeFromLoad(
        {
          type: "load",
          sceneAssetGuid: "play-scene",
          physicsWorld: "3d",
          havokWasmUrl: "https://editor.test/havok/HavokPhysics.wasm",
        },
        () => {},
      );
      await runtime.loadPhysics();
      expect(
        requested.some((url) => url.includes("/havok/HavokPhysics.wasm")),
      ).toBe(true);
      expect(runtime.getPhysicsSync()!.getBackend().constructor.name).toBe(
        "HavokPhysicsBackend",
      );
      runtime.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("unmatchedScriptSpawns", () => {
  it("drops spawn entries whose class already exists in the scene", () => {
    expect(
      unmatchedScriptSpawns(
        [{ classId: "Mover" }, { classId: "Extra" }],
        new Set(["Mover"]),
      ),
    ).toEqual([{ classId: "Extra" }]);
  });

  it("drops GameInstance, FunctionLibrary, and editor classes so they do not auto-spawn as Actors", () => {
    expect(
      unmatchedScriptSpawns(
        [
          { classId: "Mover" },
          { classId: "GameInstance" },
          { classId: "FunctionLibrary" },
          { classId: "EditorUtilityObject" },
          { classId: "EditorFunctionLibrary" },
        ],
        new Set(),
      ),
    ).toEqual([{ classId: "Mover" }]);
  });
});
