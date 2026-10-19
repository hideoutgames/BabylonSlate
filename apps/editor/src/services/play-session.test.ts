import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine, RawTexture, Scene, StandardMaterial } from "@babylonjs/core";
import { installEngineDefaultMaterial } from "@babylonslate/render";
import { SessionDiagnosticAggregator } from "@babylonslate/runtime";
import type { DebugInspectSnapshot } from "@babylonslate/object-model";
import {
  snapshotFloatCount,
  writeSnapshotHeader,
} from "@babylonslate/bridge";
import { createDefaultScene } from "@babylonslate/core";
import {
  applyPlayFpsSample,
  applyWorkerPlayStats,
  applyPlaySnapshotTick,
  diagnosticFromCommand,
  applyPlaySessionStep,
  applyPlayGraphDebugObserve,
  applyPlaySessionPausedCommand,
  applyPlayHudConsoleCommand,
  shouldForwardPlayEngineCommand,
  deliverInspectSnapshot,
  inspectSnapshotFromCommand,
  isFatalPlayDiagnostic,
  playInputStampTick,
  playSessionBootControls,
  previewFixtureThrowHint,
  printEntryFromCommand,
  resolvePlayFrameCap,
  applyPlayActiveScene,
  texturesRetainedAfterPlay,
} from "./play-session";

describe("texturesRetainedAfterPlay", () => {
  it("counts session textures still loaded, not engine placeholders or cache size", () => {
    const kept = {}, released = {}, placeholder = {}, leaked = {};
    const before = new Set([kept, released]);
    // Same size as before: one texture released, one session texture retained.
    const engine = { getLoadedTexturesCache: () => [kept, leaked], scenes: [], _emptyTexture3D: placeholder };
    expect(texturesRetainedAfterPlay(engine as never, before, new Set())).toEqual([leaked]);
    // Babylon's lazily created placeholder grows the cache without a leak.
    engine.getLoadedTexturesCache = () => [kept, released, placeholder];
    expect(texturesRetainedAfterPlay(engine as never, before, new Set())).toEqual([]);
  });

  const engines: NullEngine[] = [];
  afterEach(() => {
    while (engines.length > 0) engines.pop()?.dispose();
  });

  /** A NullEngine whose cache lists raw textures, as the WebGL and WebGPU Engines' do. */
  function sharedEngine(): NullEngine {
    const engine = new NullEngine();
    engines.push(engine);
    const createRawTexture = engine.createRawTexture.bind(engine);
    engine.createRawTexture = (...args: Parameters<typeof createRawTexture>) => {
      const texture = createRawTexture(...args);
      engine.getLoadedTexturesCache().push(texture);
      return texture;
    };
    return engine;
  }

  const rawTexture = (owner: Scene | NullEngine, name: string) => {
    const texture = RawTexture.CreateRGBATexture(new Uint8Array(16), 2, 2, owner);
    texture.name = name;
    return texture;
  };

  /** What an editor preview Scene creates on the shared Engine the first time it draws a PBR Material: the default checker and the BRDF table. */
  function mountEditorPreview(engine: NullEngine) {
    const scene = new Scene(engine);
    const checker = installEngineDefaultMaterial(scene).albedoTexture!.getInternalTexture()!;
    const brdfTexture = rawTexture(scene, "data:EnvironmentBRDFTexture2");
    scene.environmentBRDFTexture = brdfTexture;
    return { scene, checker, brdf: brdfTexture.getInternalTexture()! };
  }

  it("leaves out the textures of an editor Scene opened during the session, which it still references", () => {
    const engine = sharedEngine();
    const before = new Set(engine.getLoadedTexturesCache());
    const play = new Scene(engine);
    const preview = mountEditorPreview(engine);
    play.dispose();
    expect(engine.getLoadedTexturesCache()).toEqual(expect.arrayContaining([preview.checker, preview.brdf]));
    expect(texturesRetainedAfterPlay(engine, before, new Set([play]))).toEqual([]);
  });

  it("leaves out a texture the live Scene references only through a Material, though it was built on the Engine", () => {
    const engine = sharedEngine();
    const before = new Set(engine.getLoadedTexturesCache());
    const editor = new Scene(engine);
    const sampled = rawTexture(engine, "engine-built");
    new StandardMaterial("sampler", editor).diffuseTexture = sampled;
    expect(editor.textures).not.toContain(sampled);
    expect(engine.getLoadedTexturesCache()).toContain(sampled.getInternalTexture());
    expect(texturesRetainedAfterPlay(engine, before, new Set())).toEqual([]);
  });

  it("reports a texture no live Scene references, while leaving out the ones the editor Scene holds", () => {
    const engine = sharedEngine();
    const before = new Set(engine.getLoadedTexturesCache());
    mountEditorPreview(engine);
    const orphan = rawTexture(engine, "play-orphan").getInternalTexture();
    expect(texturesRetainedAfterPlay(engine, before, new Set())).toEqual([orphan]);
  });

  it("reports the textures of the disposed Play Scene that outlived it", () => {
    const engine = sharedEngine();
    const before = new Set(engine.getLoadedTexturesCache());
    const play = new Scene(engine);
    const gameTexture = rawTexture(play, "game-material").getInternalTexture();
    mountEditorPreview(engine);
    play.dispose();
    expect(engine.scenes).not.toContain(play);
    expect(texturesRetainedAfterPlay(engine, before, new Set([play]))).toEqual([gameTexture]);
  });

  it("does not let a Play Scene that is still alive excuse what it holds", () => {
    const engine = sharedEngine();
    const before = new Set(engine.getLoadedTexturesCache());
    const play = new Scene(engine);
    const gameTexture = rawTexture(play, "game-material").getInternalTexture();
    mountEditorPreview(engine);
    expect(engine.scenes).toContain(play);
    expect(texturesRetainedAfterPlay(engine, before, new Set([play]))).toEqual([gameTexture]);
  });
});

describe("printEntryFromCommand", () => {
  const print = { type: "print", key: "", duration: 2, color: { x: 1, y: 0, z: 0, w: 1 }, frameId: 1 } as const;

  it("turns a worker print into a HUD entry, keeping an empty message as an empty line", () => {
    expect(printEntryFromCommand({ ...print, message: "" })).toEqual({
      message: "",
      key: "",
      duration: 2,
      color: "rgba(255, 0, 0, 1)",
    });
    expect(printEntryFromCommand({ ...print, message: "hp", key: "status", duration: 0 })).toMatchObject({
      message: "hp",
      key: "status",
      duration: 0,
    });
  });

  it("ignores other commands and non-string messages", () => {
    expect(printEntryFromCommand({ type: "log", severity: "log", category: "Script", message: "hi", frameId: 1 })).toBeNull();
    expect(printEntryFromCommand({ ...print, message: undefined as never })).toBeNull();
    expect(printEntryFromCommand({ ...print, message: 3 as never })).toBeNull();
  });
});

describe("diagnosticFromCommand", () => {
  it("maps a worker diagnostic command into a RuntimeDiagnostic", () => {
    const diagnostic = diagnosticFromCommand({
      type: "diagnostic",
      code: "runtime.uncaught",
      message: "boom",
      assetGuid: "asset-1",
      graphId: "graph-1",
      nodeId: "node-1",
      btNodeId: "wait",
      bodyLine: 4,
      stack: "Error: boom",
      frameId: 7,
      severity: "error",
    });
    expect(diagnostic).toEqual({
      code: "runtime.uncaught",
      message: "boom",
      severity: "error",
      assetGuid: "asset-1",
      graphId: "graph-1",
      nodeId: "node-1",
      btNodeId: "wait",
      bodyLine: 4,
      stack: "Error: boom",
      frameId: 7,
    });
  });

  it("returns null for non-diagnostic commands", () => {
    expect(
      diagnosticFromCommand({
        type: "stats",
        frameId: 1,
        tickIndex: 1,
        scriptMs: 0,
        physicsMs: 0,
      }),
    ).toBeNull();
    expect(
      diagnosticFromCommand({
        type: "log",
        severity: "error",
        category: "Script",
        message: "not a diagnostic",
        frameId: 1,
      }),
    ).toBeNull();
  });

  it("feeds a SessionDiagnosticAggregator the way the Worker Play path does", () => {
    const aggregator = new SessionDiagnosticAggregator();
    for (let i = 0; i < 3; i++) {
      const diagnostic = diagnosticFromCommand({
        type: "diagnostic",
        code: "runtime.uncaught",
        message: `boom ${i}`,
        assetGuid: "asset-1",
        nodeId: "node-1",
        frameId: i,
        severity: "error",
      });
      if (diagnostic) aggregator.push(diagnostic);
    }
    const entries = aggregator.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.count).toBe(3);
    expect(entries[0]!.nodeId).toBe("node-1");
  });

  it("treats runtime.infinite_loop as session-fatal and other codes as not", () => {
    expect(isFatalPlayDiagnostic("runtime.infinite_loop")).toBe(true);
    expect(isFatalPlayDiagnostic("runtime.uncaught")).toBe(false);
    expect(isFatalPlayDiagnostic("preview")).toBe(false);
    expect(isFatalPlayDiagnostic(undefined)).toBe(false);
  });
});

describe("inspectSnapshotFromCommand", () => {
  it("returns the inspect payload from inspectSnapshot commands", () => {
    expect(
      inspectSnapshotFromCommand({
        type: "stats",
        frameId: 1,
        tickIndex: 1,
        scriptMs: 0,
        physicsMs: 0,
      }),
    ).toBeNull();
    expect(
      inspectSnapshotFromCommand({
        type: "inspectSnapshot",
        snapshot: {
          tickIndex: 8,
          nodes: [
            {
              id: "hero",
              kind: "actor",
              label: "Hero",
              classId: "Actor",
              parentId: null,
              variables: { health: 4 },
            },
          ],
        },
      }),
    ).toEqual({
      tickIndex: 8,
      nodes: [
        {
          id: "hero",
          kind: "actor",
          label: "Hero",
          classId: "Actor",
          parentId: null,
          variables: { health: 4 },
        },
      ],
    });
  });

  it("delivers inspectSnapshot commands to queued waiters in order", () => {
    const received: DebugInspectSnapshot[] = [];
    const waiters: Array<(snapshot: DebugInspectSnapshot) => void> = [
      (snapshot) => received.push(snapshot),
    ];
    expect(
      deliverInspectSnapshot(waiters, {
        type: "stats",
        frameId: 1,
        tickIndex: 1,
        scriptMs: 0,
        physicsMs: 0,
      }),
    ).toBe(false);
    expect(waiters).toHaveLength(1);
    expect(
      deliverInspectSnapshot(waiters, {
        type: "inspectSnapshot",
        snapshot: { tickIndex: 9, nodes: [] },
      }),
    ).toBe(true);
    expect(received).toEqual([{ tickIndex: 9, nodes: [] }]);
    expect(waiters).toHaveLength(0);
  });
});

describe("playInputStampTick", () => {
  it("uses the in-process World tick when present", () => {
    expect(playInputStampTick(3, 99)).toBe(3);
  });

  it("uses the last worker snapshot tick instead of a wall-clock index", () => {
    expect(playInputStampTick(undefined, 0)).toBe(0);
    expect(playInputStampTick(undefined, 12)).toBe(12);
  });
});

describe("applyPlaySnapshotTick", () => {
  it("stamps worker input from snapshot tickIndex when stats are sparse", () => {
    const unpublished = new Float32Array(snapshotFloatCount(1));
    expect(applyPlaySnapshotTick(4, unpublished)).toBe(4);
    const published = new Float32Array(snapshotFloatCount(1));
    writeSnapshotHeader(published, {
      frameId: 9,
      tickIndex: 12,
      actorCount: 0,
      scriptMs: 1,
      physicsMs: 2,
    });
    expect(applyPlaySnapshotTick(4, published)).toBe(12);
  });
});

describe("resolvePlayFrameCap", () => {
  it("defaults omitted or invalid caps to 60 so Play is not Infinity", () => {
    expect(resolvePlayFrameCap()).toBe(60);
    expect(resolvePlayFrameCap(0)).toBe(60);
    expect(resolvePlayFrameCap(-1)).toBe(60);
  });

  it("keeps a positive session cap", () => {
    expect(resolvePlayFrameCap(30)).toBe(30);
  });
});

describe("Play HUD stats merge", () => {
  it("keeps rendered FPS when worker timing updates arrive afterward", () => {
    const rendered = applyPlayFpsSample(undefined, 30);
    const next = applyWorkerPlayStats(rendered, {
      fps: 60,
      scriptMs: 4,
      physicsMs: 2,
      frameId: 99,
    });
    expect(next).toMatchObject({ fps: 30, scriptMs: 4, physicsMs: 2, frameId: 99 });
  });

  it("keeps worker script, physics and publish ms when the rAF pump only has fps", () => {
    const fromWorker = applyWorkerPlayStats(undefined, {
      fps: 0,
      scriptMs: 4.2,
      physicsMs: 1.8,
      publishMs: 0.6,
      frameId: 12,
      liveActors: 300,
      snapshotCapacity: 512,
    });
    expect(fromWorker).toEqual({
      fps: 0,
      scriptMs: 4.2,
      physicsMs: 1.8,
      publishMs: 0.6,
      frameId: 12,
      liveActors: 300,
      snapshotCapacity: 512,
    });
    const afterFps = applyPlayFpsSample(fromWorker, 60);
    expect(afterFps.fps).toBe(60);
    expect(afterFps.scriptMs).toBe(4.2);
    expect(afterFps.physicsMs).toBe(1.8);
    expect(afterFps.publishMs).toBe(0.6);
    expect(afterFps.frameId).toBe(12);
    expect(afterFps.liveActors).toBe(300);
    expect(afterFps.snapshotCapacity).toBe(512);
  });
});

describe("applyPlayHudConsoleCommand", () => {
  it("opens Stats HUD and highlights a row", () => {
    const onShowFps = vi.fn();
    const onStat = vi.fn();
    expect(
      applyPlayHudConsoleCommand(
        { type: "setShowFps", enabled: true },
        { onShowFps, onStat },
      ),
    ).toBe(true);
    expect(onShowFps).toHaveBeenCalledWith(true);
    expect(
      applyPlayHudConsoleCommand(
        { type: "setStat", name: "unit", enabled: true },
        { onShowFps, onStat },
      ),
    ).toBe(true);
    expect(onShowFps).toHaveBeenCalledWith(true);
    expect(onStat).toHaveBeenCalledWith("unit", true);
  });

  it("reports free cam so Preview can show a fly stick", () => {
    const onFreeCam = vi.fn();
    expect(
      applyPlayHudConsoleCommand(
        { type: "setFreeCam", enabled: true },
        { onFreeCam },
      ),
    ).toBe(true);
    expect(onFreeCam).toHaveBeenCalledWith(true);
    expect(
      applyPlayHudConsoleCommand(
        { type: "setFreeCam", enabled: false },
        { onFreeCam },
      ),
    ).toBe(true);
    expect(onFreeCam).toHaveBeenCalledWith(false);
  });
});

describe("shouldForwardPlayEngineCommand", () => {
  it("forwards setFreeCam onto the Play engine handle", () => {
    expect(shouldForwardPlayEngineCommand("setFreeCam")).toBe(true);
    expect(shouldForwardPlayEngineCommand("debugColliders")).toBe(true);
    expect(shouldForwardPlayEngineCommand("setScalability")).toBe(true);
    expect(shouldForwardPlayEngineCommand("setShowAudioDebug")).toBe(true);
    expect(shouldForwardPlayEngineCommand("debugDraw")).toBe(true);
    expect(shouldForwardPlayEngineCommand("setCursorVisible")).toBe(true);
    expect(shouldForwardPlayEngineCommand("stats")).toBe(false);
  });

  it("forwards SceneLayer compositor commands and despawn onto the Play engine", () => {
    expect(shouldForwardPlayEngineCommand("sceneLayerCreate")).toBe(true);
    expect(shouldForwardPlayEngineCommand("sceneLayerRemove")).toBe(true);
    expect(shouldForwardPlayEngineCommand("sceneLayerClear")).toBe(true);
    expect(shouldForwardPlayEngineCommand("sceneLayerPostProcess")).toBe(true);
    expect(shouldForwardPlayEngineCommand("despawn")).toBe(true);
  });
});

describe("applyPlaySessionPausedCommand", () => {
  it("forwards sessionPaused to overlay chrome", () => {
    const onSessionPaused = vi.fn();
    expect(
      applyPlaySessionPausedCommand(
        { type: "sessionPaused", paused: true },
        onSessionPaused,
      ),
    ).toBe(true);
    expect(onSessionPaused).toHaveBeenCalledWith(true);
    expect(
      applyPlaySessionPausedCommand(
        { type: "sessionPaused", paused: false },
        onSessionPaused,
      ),
    ).toBe(true);
    expect(onSessionPaused).toHaveBeenCalledWith(false);
  });

  it("ignores other commands", () => {
    const onSessionPaused = vi.fn();
    expect(
      applyPlaySessionPausedCommand(
        {
          type: "stats",
          frameId: 1,
          tickIndex: 1,
          scriptMs: 0,
          physicsMs: 0,
        },
        onSessionPaused,
      ),
    ).toBe(false);
    expect(onSessionPaused).not.toHaveBeenCalled();
  });
});

describe("applyPlaySessionStep", () => {
  it("steps the in-process runtime when the worker is absent", () => {
    const resume = vi.fn();
    const tick = vi.fn();
    const pause = vi.fn();
    applyPlaySessionStep({
      worker: null,
      runtime: { resume, tick, pause },
    });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(resume.mock.invocationCallOrder[0]).toBeLessThan(
      tick.mock.invocationCallOrder[0]!,
    );
    expect(tick.mock.invocationCallOrder[0]).toBeLessThan(
      pause.mock.invocationCallOrder[0]!,
    );
  });

  it("pauses the in-process runtime again when the stepped tick throws", () => {
    const pause = vi.fn();
    const tick = vi.fn(() => {
      throw new Error("script failed");
    });
    expect(() =>
      applyPlaySessionStep({ worker: null, runtime: { resume: vi.fn(), tick, pause } }),
    ).toThrow("script failed");
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it("posts step to the worker when present", () => {
    const postControl = vi.fn();
    const resume = vi.fn();
    const tick = vi.fn();
    const pause = vi.fn();
    applyPlaySessionStep({
      worker: { postControl },
      runtime: { resume, tick, pause },
    });
    expect(postControl).toHaveBeenCalledWith({ type: "step" });
    expect(resume).not.toHaveBeenCalled();
    expect(tick).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });
});

describe("applyPlayGraphDebugObserve", () => {
  const target = { kind: "class", classId: "Door" } as const;

  it("posts the request to the worker instead of touching the in-process runtime", () => {
    const postControl = vi.fn();
    const applyDebugObserve = vi.fn();
    applyPlayGraphDebugObserve({ worker: { postControl }, runtime: { applyDebugObserve } }, target, "d1");
    applyPlayGraphDebugObserve({ worker: { postControl }, runtime: { applyDebugObserve } }, null, null);
    expect(postControl.mock.calls).toEqual([
      [{ type: "debugObserve", target, instanceId: "d1" }],
      [{ type: "debugObserve", target: null, instanceId: null }],
    ]);
    expect(applyDebugObserve).not.toHaveBeenCalled();
  });

  it("applies the request directly to the in-process runtime when there is no worker", () => {
    const applyDebugObserve = vi.fn();
    applyPlayGraphDebugObserve({ worker: null, runtime: { applyDebugObserve } }, target, "d2");
    expect(applyDebugObserve).toHaveBeenCalledExactlyOnceWith(target, "d2");
  });
});

describe("playSessionBootControls", () => {
  it("sends loadScripts before play", () => {
    const controls = playSessionBootControls({
      load: {
        type: "load",
        sceneAssetGuid: "play-scene",
      },
      scripts: [
        {
          assetGuid: "hero",
          classId: "Hero",
          source: "export const onBeginPlay = () => {}",
          anchors: [],
          entryPoints: [],
        },
      ],
    });
    expect(controls.map((control) => control.type)).toEqual([
      "load",
      "loadScripts",
      "play",
    ]);
  });

  it("appends setPaused after play when Pause On Play is on", () => {
    const controls = playSessionBootControls({
      load: { type: "load", sceneAssetGuid: "play-scene" },
      pauseOnPlay: true,
    });
    expect(controls.map((control) => control.type)).toEqual([
      "load",
      "play",
      "setPaused",
    ]);
    expect(controls.at(-1)).toEqual({ type: "setPaused", paused: true });
  });

  it("sends loadSprites with Sprite Animation payloads before play", () => {
    const controls = playSessionBootControls({
      load: { type: "load", sceneAssetGuid: "play-scene" },
      sprites: {
        type: "loadSprites",
        sprites: [{ guid: "hero-sprite", document: { frames: [], clips: [] } }],
        spriteAnimations: [
          { guid: "walk-anim", document: { frames: [{ durationMs: 100 }] } },
        ],
      },
    });
    expect(controls.find((control) => control.type === "loadSprites")).toEqual({
      type: "loadSprites",
      sprites: [{ guid: "hero-sprite", document: { frames: [], clips: [] } }],
      spriteAnimations: [
        { guid: "walk-anim", document: { frames: [{ durationMs: 100 }] } },
      ],
    });
    expect(controls.map((control) => control.type).indexOf("play")).toBeGreaterThan(
      controls.map((control) => control.type).indexOf("loadSprites"),
    );
  });

  it("imports the startup navmesh from the load catalog instead of sending it again", () => {
    const startup = new Uint8Array([1, 2, 3, 4]);
    const controls = playSessionBootControls({
      load: { type: "load", sceneAssetGuid: "level-1", sceneNavmeshBytes: { "level-1": startup, "level-2": new Uint8Array([9]) } },
      navmeshBytes: startup,
    });
    // The control stays between load and play, so the mesh imports before the world realizes.
    expect(controls).toEqual([controls[0], { type: "loadNavMesh" }, { type: "play" }]);
  });

  it("sends one private buffer when the load catalog lacks the startup navmesh", () => {
    const storage = new Uint8Array([0, 5, 6, 7, 0]);
    // A view into a larger buffer, and a mesh that owns its whole buffer: neither may be sent as is.
    for (const startup of [storage.subarray(1, 4), new Uint8Array([5, 6, 7])]) {
      for (const catalog of [undefined, { "level-1": new Uint8Array([5, 6, 7]) }]) {
        const controls = playSessionBootControls({
          load: { type: "load", sceneAssetGuid: "level-1", ...(catalog ? { sceneNavmeshBytes: catalog } : {}) },
          navmeshBytes: startup,
        });
        const navmesh = controls.find((control) => control.type === "loadNavMesh");
        expect(navmesh).toEqual({ type: "loadNavMesh", bytes: expect.any(ArrayBuffer) });
        const bytes = (navmesh as { bytes: ArrayBuffer }).bytes;
        expect([...new Uint8Array(bytes)]).toEqual([5, 6, 7]);
        // The host transfers it, which must not detach the Play content the next session reuses.
        expect(bytes).not.toBe(startup.buffer);
      }
    }
  });

  it("sends loadModels before play", () => {
    const controls = playSessionBootControls({
      load: { type: "load", sceneAssetGuid: "play-scene" },
      models: {
        type: "loadModels",
        models: [{ guid: "hero-model", document: { simpleColliders: [] } }],
      },
    });
    expect(controls.find((control) => control.type === "loadModels")).toEqual({
      type: "loadModels",
      models: [{ guid: "hero-model", document: { simpleColliders: [] } }],
    });
    expect(controls.map((control) => control.type).indexOf("play")).toBeGreaterThan(
      controls.map((control) => control.type).indexOf("loadModels"),
    );
  });
});

describe("previewFixtureThrowHint", () => {
  it("points at the first task node when a behaviour tree is loaded", () => {
    expect(
      previewFixtureThrowHint([
        {
          guid: "tree-1",
          document: {
            name: "Patrol",
            rootId: "root",
            blackboardGuid: null,
            nodes: [
              {
                id: "root",
                kind: "selector",
                classId: "bt.composite.selector",
                children: ["task"],
                decorators: [],
                services: [],
                properties: {},
              },
              {
                id: "task",
                kind: "task",
                classId: "bt.task.succeed",
                children: [],
                decorators: [],
                services: [],
                properties: {},
              },
            ],
          },
        },
      ]),
    ).toEqual({ assetGuid: "tree-1", btNodeId: "task" });
  });

  it("is null when Play has no behaviour tree so the graph fixture stays", () => {
    expect(previewFixtureThrowHint()).toBeNull();
    expect(previewFixtureThrowHint([])).toBeNull();
  });
});

describe("applyPlayActiveScene", () => {
  const scene = { ...createDefaultScene(), name: "Level 1" };
  const other = { ...createDefaultScene(), name: "Level 2" };

  it("selects the destination reverb and clears it for a scene without a bake", () => {
    const bytes = new Uint8Array([2]);
    const applied: Array<Uint8Array | null> = [];
    const handle = { loadScene: () => {}, applySceneEnvironment: () => {}, resetAudioSession: () => {}, resetParticleSession: () => {},
      setAudioReverbField: (field: Uint8Array | null) => applied.push(field) };
    const options = { handle, scenes: [{ guid: "one", scene }, { guid: "two", scene: other }], boot: { guid: "one", scene }, audioReverbByScene: new Map([["two", bytes]]) };
    applyPlayActiveScene({ ...options, currentSceneGuid: "one", command: { type: "activeScene", sceneAssetGuid: "two" } });
    applyPlayActiveScene({ ...options, currentSceneGuid: "two", command: { type: "activeScene", sceneAssetGuid: "one" } });
    expect(applied).toEqual([bytes, null]);
  });

  it("skips reload and audio/particle reset when the boot scene is already active", () => {
    const loaded: string[] = [];
    const handle = {
      loadScene: (next: { name: string }) => {
        loaded.push(`load:${next.name}`);
      },
      applySceneEnvironment: (next: { name: string }) => {
        loaded.push(`env:${next.name}`);
      },
      resetAudioSession: () => {
        loaded.push("reset-audio");
      },
      resetParticleSession: () => {
        loaded.push("reset-particles");
      },
    };
    expect(
      applyPlayActiveScene({
        handle,
        command: { type: "activeScene", sceneAssetGuid: "scene-1" },
        scenes: [{ guid: "scene-1", scene }],
        boot: { guid: "scene-1", scene },
        currentSceneGuid: "scene-1",
      }),
    ).toBe("scene-1");
    expect(loaded).toEqual([]);
    applyPlayActiveScene({
      handle,
      command: { type: "activeScene", sceneAssetGuid: "scene-1" },
      scenes: [{ guid: "scene-1", scene }],
      boot: { guid: "scene-1", scene },
      currentSceneGuid: "scene-1",
      forceReload: true,
    });
    expect(loaded).toEqual(["load:Level 1", "env:Level 1", "reset-audio", "reset-particles"]);
  });

  it("reloads and resets when the runtime switches to another scene", () => {
    const loaded: string[] = [];
    const handle = {
      loadScene: (next: { name: string }) => {
        loaded.push(`load:${next.name}`);
      },
      applySceneEnvironment: (next: { name: string }) => {
        loaded.push(`env:${next.name}`);
      },
      resetAudioSession: () => {
        loaded.push("reset-audio");
      },
      resetParticleSession: () => {
        loaded.push("reset-particles");
      },
    };
    expect(
      applyPlayActiveScene({
        handle,
        command: { type: "activeScene", sceneAssetGuid: "scene-2" },
        scenes: [
          { guid: "scene-1", scene },
          { guid: "scene-2", scene: other },
        ],
        boot: { guid: "scene-1", scene },
        currentSceneGuid: "scene-1",
      }),
    ).toBe("scene-2");
    expect(loaded).toEqual([
      "load:Level 2",
      "env:Level 2",
      "reset-audio",
      "reset-particles",
    ]);
  });
});
