import { buildMaterialParameterCatalog } from "@babylonslate/shader-graph";
import { materialParameterTextureAssetGuids } from "@babylonslate/assets";
import { captureShadowDiagnostics, lightsDebugText } from "@babylonslate/render";
import type { AbstractEngine } from "@babylonjs/core";
import { snapshotFloatCount, type ControlMessage } from "@babylonslate/bridge";
import { encodeInputEvents } from "@babylonslate/input";
import { parseAnimGraphDocument } from "@babylonslate/anim-graph";
import {
  parseBehaviourTreeDocument,
  parseBlackboardDocument,
} from "@babylonslate/behaviour-tree";
import {
  createPlayBootCoordinator,
  createPlayPauseGate,
  createRuntimeFromLoad,
  captureConsoleLogs,
  type RuntimeDriver,
} from "@babylonslate/runtime";
import {
  audioStats,
  attachLifecyclePause,
  createEngine,
  createSceneLoadReadiness,
  navDebugBlockersFromActors,
  particleStats,
  type EngineHandle,
  type RenderShadingSettings,
  type SceneLoadProgress,
} from "@babylonslate/render";
import { playFramebufferSize, type ResolvedRenderingPipeline, type SerializedScene } from "@babylonslate/core";
import type { GameManifest } from "@babylonslate/exporter";
import { createPlayerWorkerHost, type PlayerWorkerHost } from "./worker-host";
import { createGameAudioSourceLoader, type LoadedGame } from "./artifact";
import {
  applyPlayerActiveScene,
  applyPlayerEngineCommand,
} from "./engine-commands";
import {
  publishPlayerSceneLoading,
  waitForPlayerLoadingPaint,
} from "./scene-loading-state";
import { mountPlayerPrintOverlay } from "./print-overlay";
import { packedBootControls, packedContentFromGame, type PackedGameContent } from "./hydrate";
import { attachInputCapture, playInputStampTick } from "./input";
import {
  applyPlayerFpsSample,
  applyPlayerSnapshotTick,
  applyWorkerPlayerStats,
  unlockAudioOnFirstGesture,
  type PlayerHudStats,
} from "./hud";
import {
  loopGuardLoadFields,
  shouldHaltPlayerOnDiagnostic,
} from "./debug-load";
import { packedFontCssStacks } from "./fonts";
import { createPlayerConsoleHost } from "./console-host";
import { createPlayerPauseState } from "./console-pause";
import type { DebugInspectSnapshot } from "@babylonslate/object-model";

function havokWasmUrl(): string {
  return new URL("./havok/HavokPhysics.wasm", document.baseURI).href;
}

function ktx2BasePath(): string {
  return new URL("./ktx2/", document.baseURI).href;
}

function dracoBasePath(): string {
  return new URL("./draco/", document.baseURI).href;
}

function meshoptBasePath(): string {
  return new URL("./meshopt/", document.baseURI).href;
}

export type PlayerDiagnostic = {
  message: string;
  severity: string;
  code?: string;
  assetGuid?: string;
  graphId?: string;
  nodeId?: string;
  btNodeId?: string;
  bodyLine?: number;
};

export type PlayerBootHandle = {
  ticks: () => number;
  rendering: () => ReturnType<EngineHandle["renderDiagnostics"]> | null;
  shadowDiagnostics: () => ReturnType<typeof captureShadowDiagnostics> | null;
  visuals: () => ReturnType<EngineHandle["playVisualStates"]>;
  meshMaterialNames: () => string[];
  bakedSession: () => ReturnType<
    EngineHandle["bakedSessionDiagnostics"]
  > | null;
  /** Active owned post-process/effect passes, or null once halted. */
  postProcessPassCount: () => number | null;
  /** Prepared FrameGraph task names, or null once halted. */
  renderTasks: () => string[] | null;
  /** Applies project render settings to the running scene (test hooks). */
  setRenderSettings: (settings: RenderShadingSettings) => void;
  executeConsoleCommand: (
    line: string,
  ) => Promise<{ success: boolean; output: string }>;
  inspectWorld: () => Promise<DebugInspectSnapshot>;
  stop: () => { diagnostics: PlayerDiagnostic[] };
};

export type PlayerBootOptions = {
  canvas: HTMLCanvasElement;
  game: LoadedGame;
  sharedEngine?: AbstractEngine;
  content?: PackedGameContent;
  /** Runs after every player resource has attempted cleanup, including startup rollback. */
  onStopped?: () => void;
  onStats?: (stats: {
    ticks: number;
    fps: number;
    scriptMs: number;
    physicsMs: number;
    draws: number;
    lightsDebugText?: string | null;
  }) => void;
  onDiagnostic?: (diagnostics: readonly PlayerDiagnostic[]) => void;
  onConsoleEvent?: (
    command: { type: string } & Record<string, unknown>,
  ) => void;
};

export function startPlayer(options: PlayerBootOptions): PlayerBootHandle {
  const cleanups = new Set<() => void>();
  const own = (dispose: () => void) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      cleanups.delete(release);
      dispose();
    };
    cleanups.add(release);
    return release;
  };
  const releaseAll = () => {
    const errors: unknown[] = [];
    for (const release of [...cleanups].reverse()) {
      try { release(); } catch (error) { errors.push(error); }
    }
    return errors;
  };
  // First acquired, last released: the backend owner must outlive every view.
  own(() => options.onStopped?.());
  try {
    return initializePlayer(options, own, releaseAll);
  } catch (error) {
    const errors = releaseAll();
    if (errors.length) throw new AggregateError([error, ...errors], "Player startup and cleanup failed.", { cause: error });
    throw error;
  }
}

function initializePlayer(
  options: PlayerBootOptions,
  own: (cleanup: () => void) => () => void,
  releaseAll: () => unknown[],
): PlayerBootHandle {
  const { canvas, game } = options;
  const manifest: GameManifest = game.manifest;
  const startup = manifest.startupSceneGuid;
  const scene: SerializedScene | undefined = game.scenes.get(startup);
  if (!scene) {
    throw new Error("Set Startup Scene in Project Settings.");
  }
  const content = options.content ?? packedContentFromGame(game);
  const diagnostics: PlayerDiagnostic[] = [];
  const fontCss = packedFontCssStacks(game.fontFamilies);

  let worker: PlayerWorkerHost | null = null;
  let runtime: RuntimeDriver | null = null;
  let input: ReturnType<typeof attachInputCapture> | null = null;
  const consoleHost = createPlayerConsoleHost({
    execute: () =>
      runtime ? (line) => runtime!.executeConsoleCommand(line) : undefined,
    inspect: () => (runtime ? () => runtime!.inspectWorld() : undefined),
    post: (command) => worker?.postControl(command),
  });

  own(() => consoleHost.dispose());
  const publishRenderPathStatus = (status: ResolvedRenderingPipeline) => {
    const control: ControlMessage = {
      type: "renderPathStatus",
      requested: status.requested.renderPath,
      effective: status.effective.renderPath,
      gpuBackend: status.effective.gpuBackend,
      limits: status.limits,
    };
    if (worker) worker.postControl(control);
    else runtime?.applyRenderPathStatus(control);
  };
  const handle: EngineHandle = createEngine(canvas, {
    sharedEngine: options.sharedEngine,
    playMode: true,
    frameCap: manifest.playFrameCap,
    renderSettings: manifest.render,
    spritePayloads: content.spritePayloads,
    spriteAnimations: content.spriteAnimationPayloads,
    tilemapPayloads: content.tilemapPayloads,
    tilesetPayloads: content.tilesetPayloads,
    pixelsPerUnit: content.pixelsPerUnit,
    sortingLayers: content.sortingLayers,
    pixelPerfect: content.pixelPerfect,
    touchMinTargetPx: manifest.touchMinTargetPx ?? 44,
    textureBytes: game.textureBytes,
    texturePixelSizes: content.texturePixelSizes,
    fontFacetypeBytes: game.fontFacetypeBytes,
    fontMsdfJson: game.fontMsdfJson,
    fontMsdfPng: game.fontMsdfPng,
    fontCssStack: fontCss.fontCssStack,
    fontCssStackByGuid: fontCss.fontCssStackByGuid,
    modelBytes: game.modelBytes,
    modelPayloads: game.modelPayloads,
    modelClipAnimationGuids: content.modelClipAnimationGuids,
    retargetAnimationLoads: content.retargetAnimationLoads,
    audioBytes: game.audioBytes,
    loadAudioSourceBytes: createGameAudioSourceLoader(game),
    audioLibrary: content.audioLibrary,
    particleLibrary: content.particleLibrary,
    audioReverbBytes: content.audioReverbBytes,
    audioProjectSettings: {
      occlusionEnabled: manifest.occlusionEnabled !== false,
      reverbWetScale: manifest.reverbWetScale ?? 1,
      reverbDecayScale: manifest.reverbDecayScale ?? 1,
      reverbDampingScale: manifest.reverbDampingScale ?? 1,
    },
    materialDocuments: content.materialDocuments,
    materialFunctions: content.materialFunctions,
    // Baked lighting/geometry pack as self-contained babasset containers.
    bakeAssetReader: async (guid) => {
      const bytes = game.payloads.get(guid);
      return bytes ? { bytes } : undefined;
    },
    postProcessStack: content.postProcessStack,
    environmentColor: scene.settings.environmentColor,
    viewportMode: scene.viewportMode,
    physicsWorld: manifest.physicsWorld,
    navmeshBytes: content.navmeshBytes,
    navBlockers: navDebugBlockersFromActors(scene.actors),
    ktx2BasePath: ktx2BasePath(),
    dracoBasePath: dracoBasePath(),
    meshoptBasePath: meshoptBasePath(),
    onPostProcessDiagnostic: (diagnostic) => {
      options.onConsoleEvent?.({
        type: "log",
        message: diagnostic.message,
        severity: "warning",
      });
      diagnostics.push({
        message: diagnostic.message,
        severity: "warning",
        assetGuid: diagnostic.materialGuid,
        nodeId: diagnostic.nodeId,
      });
      options.onDiagnostic?.(diagnostics);
    },
    onAudioDiagnostic: (diagnostic) => {
      options.onConsoleEvent?.({
        type: "log",
        message: diagnostic.message,
        severity: "warning",
      });
      diagnostics.push({
        message: diagnostic.message,
        severity: "warning",
        code: diagnostic.code,
        assetGuid: diagnostic.assetGuid,
      });
      options.onDiagnostic?.(diagnostics);
    },
    onParticleDiagnostic: (diagnostic) => {
      options.onConsoleEvent?.({
        type: "log",
        message: diagnostic.message,
        severity: "warning",
      });
      diagnostics.push({
        message: diagnostic.message,
        severity: "warning",
        code: diagnostic.code,
        assetGuid: diagnostic.assetGuid,
      });
      options.onDiagnostic?.(diagnostics);
    },
    onMaterialDiagnostic: (diagnostic) => {
      options.onConsoleEvent?.({
        type: "log",
        message: diagnostic.message,
        severity: diagnostic.severity ?? "error",
      });
      diagnostics.push({
        message: diagnostic.message,
        severity: diagnostic.severity ?? "error",
        code: diagnostic.code,
        nodeId: diagnostic.nodeId,
      });
      options.onDiagnostic?.(diagnostics);
    },
    onSceneLayerPointer: (event) => {
      const control = { type: "sceneLayerPointer" as const, ...event };
      if (worker) worker.postControl(control);
      else runtime?.applySceneLayerPointer(control);
    },
    onSceneLayerResize: (size) => {
      const control = { type: "sceneLayerResize" as const, ...size };
      if (worker) worker.postControl(control);
      else
        runtime?.applySceneLayerResize(
          size.frustumWidth,
          size.frustumHeight,
          size.canvasWidth,
          size.canvasHeight,
        );
    },
    onAudioVoiceEnded: (voiceId) => {
      const control = { type: "audioVoiceEnded" as const, voiceId };
      if (worker) worker.postControl(control);
      else runtime?.applyAudioVoiceEnded(control);
    },
    onRenderPathChanged: publishRenderPathStatus,
  });
  own(() => handle.dispose());
  handle.applySceneEnvironment(scene);
  const releaseConsoleCapture = captureConsoleLogs(
    console,
    (message, severity) => {
      if (runtime) runtime.reportLog(message, severity);
      else options.onConsoleEvent?.({ type: "log", message, severity });
    },
  );
  const onWindowError = (event: ErrorEvent) =>
    options.onConsoleEvent?.({
      type: "log",
      message: event.error?.stack ?? event.message,
      severity: "error",
    });
  const onRejection = (event: PromiseRejectionEvent) =>
    options.onConsoleEvent?.({
      type: "log",
      message:
        event.reason instanceof Error
          ? (event.reason.stack ?? event.reason.message)
          : String(event.reason),
      severity: "error",
    });
  window.addEventListener("error", onWindowError);
  window.addEventListener("unhandledrejection", onRejection);
  const releaseConsole = () => {
    releaseConsoleCapture();
    window.removeEventListener("error", onWindowError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
  own(releaseConsole);
  handle.scheduler.invalidate("play");
  const printHud = mountPlayerPrintOverlay(canvas.parentElement ?? canvas);
  own(() => printHud.dispose());
  if (typeof window !== "undefined") {
    (
      window as { __babylonslateAudioStats?: typeof audioStats }
    ).__babylonslateAudioStats = audioStats;
    (
      window as { __babylonslateParticleStats?: typeof particleStats }
    ).__babylonslateParticleStats = particleStats;
  }
  const framebuffer = playFramebufferSize(manifest.render);
  if (framebuffer) {
    handle.setSize(framebuffer.width, framebuffer.height);
  } else {
    handle.resize();
  }

  // Without a locked framebuffer the canvas is CSS-sized, so the backing store
  // has to follow the element or the first frames draw at the wrong size.
  const resizeObserver =
    framebuffer || typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
            handle.resize();
          }
        });
  own(() => resizeObserver?.disconnect());
  resizeObserver?.observe(canvas);

  const scenes = [...game.scenes.entries()].map(([guid, authored]) => ({
    guid,
    scene: authored,
  }));
  const sceneLayers = [...game.sceneLayers.entries()].map(([guid, layer]) => ({
    guid,
    layer,
  }));
  const loadControl = {
    frameCap: manifest.playFrameCap,
    renderSettings: manifest.render,
    project: manifest.project,
    type: "load" as const,
    sceneAssetGuid: startup,
    scene,
    physicsWorld: manifest.physicsWorld,
    inputAssets: manifest.inputAssets,
    inputMappings: manifest.inputMappings,
    gravity: scene.settings.gravity,
    havokWasmUrl: havokWasmUrl(),
    gameInstanceClass:
      (typeof manifest.gameInstanceClass === "string" &&
      manifest.gameInstanceClass.trim()
        ? manifest.gameInstanceClass.trim()
        : undefined) ??
      scene.settings.gameInstanceClass ??
      undefined,
    scenes,
    sceneLayers,
    ...loopGuardLoadFields(manifest),
    audioAssetGuids: [...content.audioLibrary.audio.keys()],
    materialParameterCatalog: buildMaterialParameterCatalog(content.materialDocuments, content.materialFunctions),
    materialTextureAssetGuids: materialParameterTextureAssetGuids(game.textureBytes),
    animClipCatalog: content.animClipCatalog,
    deferSceneModelsReady: true,
    deferSceneLoadingPaint: true,
  };

  let ticks = 0;
  let lastWorkerTickIndex = 0;
  let raf = 0;
  let halted = false;
  let lifecyclePaused = false;
  const pauseState = createPlayerPauseState();
  let detachLifecycle = () => {};
  let pauseGate: ReturnType<typeof createPlayPauseGate> | null = null;
  let resetBoot = () => {};
  let hudStats: PlayerHudStats | undefined;
  let snapBuf = new Float32Array(snapshotFloatCount(256));
  own(() => { halted = true; cancelAnimationFrame(raf); });
  own(() => resetBoot());
  own(() => pauseGate?.reset());
  own(() => detachLifecycle());

  const emitHudStats = (next: PlayerHudStats) => {
    hudStats = {
      ...next,
      draws: handle.drawCalls(),
      geometryBytes: handle.accountedGeometryBytes(),
      lightsDebugText: manifest.bundleDebugger ? lightsDebugText(handle.renderDiagnostics()) : null,
    };
    options.onStats?.(hudStats);
  };

  const haltPlayback = () => {
    if (!halted) stopPlayer();
  };

  // No loading popup: authored Scene Layers present loading through Game
  // Instance events. The root attributes expose the transaction to tests and
  // embedders; the world stays withheld by the load admission, not obstruction.
  const loadingRoot = document.getElementById("player-root") ?? document.body;
  const publishSceneLoading = (state: SceneLoadProgress | null) =>
    publishPlayerSceneLoading(loadingRoot, state);
  let hostSceneGuid: string | null = startup;
  let receivedActiveScene = false;
  const sceneReadiness = createSceneLoadReadiness({
    handle,
    loading: {
      acquire: () => () => {},
      progress: publishSceneLoading,
      paint: (signal) => waitForPlayerLoadingPaint(handle.engine, signal),
      layerPainted: ({ layerId, layerLoadId }) => {
        worker?.postControl({ type: "sceneLayerLoadingPainted", layerId, layerLoadId });
        runtime?.notifySceneLayerLoadingPainted(layerId, layerLoadId);
      },
      painted: ({ sceneAssetGuid, sceneLoadId }) => {
        worker?.postControl({ type: "sceneLoadingPainted", sceneAssetGuid, sceneLoadId });
        runtime?.notifySceneLoadingPainted(sceneAssetGuid, sceneLoadId);
      },
    },
    activate: ({ sceneAssetGuid }) => {
      if (!applyPlayerActiveScene(handle, game.scenes, { type: "activeScene", sceneAssetGuid }, hostSceneGuid, receivedActiveScene)) {
        throw new Error("The requested scene is not available in this build.");
      }
      hostSceneGuid = sceneAssetGuid;
      receivedActiveScene = true;
    },
    onReady: ({ sceneAssetGuid, sceneLoadId }) => {
      worker?.postControl({ type: "sceneModelsReady", sceneAssetGuid, sceneLoadId });
      runtime?.notifySceneModelsReady(sceneAssetGuid, sceneLoadId);
    },
    onLayerReady: ({ layerId, layerLoadId }) => {
      worker?.postControl({ type: "sceneLayerReady", layerId, layerLoadId });
      runtime?.notifySceneLayerReady(layerId, layerLoadId);
    },
    onFailed: (_scene, error) => {
      diagnostics.push({
        message: `Scene loading failed: ${error instanceof Error ? error.message : String(error)}`,
        severity: "error",
        code: "scene.load.failed",
      });
      try { options.onDiagnostic?.(diagnostics); } finally { haltPlayback(); }
    },
  });
  own(() => sceneReadiness.dispose());
  const onCommand = (command: { type: string } & Record<string, unknown>) => {
    if (halted) return;
    if (command.type === "sessionPaused") {
      const paused = pauseState.setConsolePaused(command.paused === true);
      handle.setPaused(paused);
      pauseGate?.setPaused(paused);
      worker?.postControl({ type: "setPaused", paused });
    }
    consoleHost.receive(command);
    options.onConsoleEvent?.(command);
    if (command.type === "snapshotLayout" && runtime)
      snapBuf = new Float32Array(snapshotFloatCount(Number(command.capacity)));
    if (command.type === "snapshotLayout")
      handle.applyCommand(command as never);
    applyPlayerEngineCommand(handle, command);
    if ((command.type === "sceneRealized" || command.type === "sceneLayerRealized") && runtime) {
      if (!runtime.copySnapshot(snapBuf)) throw new Error("Completed Scene snapshot is unavailable.");
      handle.pushSnapshot(snapBuf);
    }
    sceneReadiness.receive(command);
    if (command.type === "print") {
      printHud.applyPrint({
        message: command.message,
        key: command.key,
        duration: command.duration,
        color: command.color,
      });
    }
    if (command.type === "stats") {
      emitHudStats(
        applyWorkerPlayerStats(hudStats, {
          ticks: lastWorkerTickIndex,
          fps: Number(command.fps ?? 0),
          scriptMs: Number(command.scriptMs ?? 0),
          physicsMs: Number(command.physicsMs ?? 0),
          liveActors: Number(command.liveActors ?? 0),
          snapshotCapacity: Number(command.snapshotCapacity ?? 0),
        }),
      );
    }
    if (command.type === "diagnostic") {
      diagnostics.push({
        message: String(command.message ?? ""),
        severity: String(command.severity ?? "error"),
        code: typeof command.code === "string" ? command.code : undefined,
        assetGuid: command.assetGuid as string | undefined,
        graphId: command.graphId as string | undefined,
        nodeId: command.nodeId as string | undefined,
        btNodeId: command.btNodeId as string | undefined,
        bodyLine:
          typeof command.bodyLine === "number" ? command.bodyLine : undefined,
      });
      try { options.onDiagnostic?.(diagnostics); } finally {
        if (shouldHaltPlayerOnDiagnostic(command.code)) haltPlayback();
      }
    }
  };

  let releaseWorker = () => {};
  try {
    const ownedWorker = createPlayerWorkerHost();
    worker = ownedWorker;
    releaseWorker = own(() => ownedWorker.terminate());
    worker.onCommand((cmd) => onCommand(cmd as never));
    worker.onSnapshot((buffer) => {
      if (halted) return;
      lastWorkerTickIndex = applyPlayerSnapshotTick(
        lastWorkerTickIndex,
        buffer,
      );
      ticks = lastWorkerTickIndex;
      handle.pushSnapshot(buffer);
    });
    worker.postControl(loadControl);
    for (const control of packedBootControls(content, game.scripts)) {
      worker.postControl(control);
    }
  } catch (error) {
    worker = null;
    try { releaseWorker(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Player worker startup and termination failed.", { cause: error });
    }
    const inProcess = createRuntimeFromLoad(loadControl, (command) =>
      onCommand(command as never),
    );
    runtime = inProcess;
    own(() => inProcess.stop());
    pauseGate = createPlayPauseGate({
      pause: () => inProcess.pause(),
      resume: () => inProcess.resume(),
    });
    const boot = createPlayBootCoordinator();
    resetBoot = () => boot.reset();
    if (game.scripts.length > 0) {
      boot.queueScripts(inProcess, game.scripts, []);
    }
    for (const entry of content.animGraphs) {
      const document = parseAnimGraphDocument(entry.document);
      if (document) inProcess.registerAnimGraph(entry.guid, document);
    }
    for (const entry of content.behaviourTrees) {
      const document = parseBehaviourTreeDocument(entry.document);
      if (document) inProcess.registerBehaviourTree(entry.guid, document);
    }
    for (const entry of content.blackboards) {
      const document = parseBlackboardDocument(entry.document);
      if (document) inProcess.registerBlackboard(entry.guid, document);
    }
    if (content.tilemapPayloads.size > 0 || content.tilesetPayloads.size > 0) {
      inProcess.registerTileContent({
        tilemaps: content.tilemapPayloads,
        tilesets: content.tilesetPayloads,
        pixelsPerUnit: content.pixelsPerUnit,
      });
    }
    if (
      content.spritePayloads.size > 0 ||
      content.spriteAnimationPayloads.size > 0
    ) {
      inProcess.registerSpriteContent({
        sprites: content.spritePayloads,
        spriteAnimations: content.spriteAnimationPayloads,
        pixelsPerUnit: content.pixelsPerUnit,
      });
    }
    if (content.modelPayloads.size > 0) {
      inProcess.registerModelContent({
        models: content.modelPayloads,
        complexMeshes: content.complexMeshes,
      });
    }
    if (content.navmeshBytes && content.navmeshBytes.byteLength > 0) {
      boot.queueNavMesh(inProcess, content.navmeshBytes);
    }
    void pauseGate
      .beginPlay((onStarted) => boot.play(inProcess, onStarted))
      .catch((error: unknown) => {
        if (!halted) inProcess.reportError(error);
      });
  }
  // The subscription above fired before the runtime existed; report the
  // current status now that the worker or in-process runtime can store it.
  publishRenderPathStatus(handle.renderPathStatus());

  if (halted) return playerHandle();
  input = attachInputCapture(canvas, {
    skipPointerAndKeyboard: () => handle.isFreeCamEnabled(),
  });
  own(() => input?.dispose());
  const releaseUnlock = unlockAudioOnFirstGesture(() => {
    void handle.unlockAudio();
  }, canvas);
  own(releaseUnlock);
  let last = performance.now();
  let fpsWindowStart = last;

  const pump = () => {
    if (halted || lifecyclePaused) return;
    const now = performance.now();
    const elapsed = (now - last) / 1000;
    last = now;
    const tick = playInputStampTick(
      runtime?.getWorld().clock.tickIndex,
      lastWorkerTickIndex,
    );
    input?.setTick(tick);
    input?.pollGamepads();
    const drained = input?.ring.drain() ?? [];
    if (drained.length > 0) {
      if (worker) worker.pushInput(drained);
      else if (runtime) runtime.pushInputBuffer(encodeInputEvents(drained));
    }
    if (runtime) {
      runtime.advance(elapsed);
      if (runtime.copySnapshot(snapBuf)) {
        lastWorkerTickIndex = applyPlayerSnapshotTick(
          lastWorkerTickIndex,
          snapBuf,
        );
        ticks = lastWorkerTickIndex;
        handle.pushSnapshot(snapBuf);
      }
    }
    if (now - fpsWindowStart >= 1000) {
      emitHudStats(
        applyPlayerFpsSample(hudStats, handle.scheduler.stats().renderedFps),
      );
      fpsWindowStart = now;
    }
    raf = requestAnimationFrame(pump);
  };
  raf = requestAnimationFrame(pump);
  if (!halted) {
    detachLifecycle = attachLifecyclePause((paused) => {
      const wasPaused = lifecyclePaused;
      lifecyclePaused = paused;
      const effectivePaused = pauseState.setLifecyclePaused(paused);
      handle.setPaused(effectivePaused);
      pauseGate?.setPaused(effectivePaused);
      worker?.postControl({ type: "setPaused", paused: effectivePaused });
      if (paused) {
        cancelAnimationFrame(raf);
      } else if (wasPaused) {
        last = performance.now();
        fpsWindowStart = last;
        raf = requestAnimationFrame(pump);
      }
    });
  }

  function stopPlayer(): { diagnostics: PlayerDiagnostic[] } {
    halted = true;
    const errors = releaseAll();
    worker = null;
    runtime = null;
    input = null;
    if (errors.length) {
      diagnostics.push({ code: "player.cleanup.failed", severity: "error",
        message: `Player cleanup failed: ${errors.map((error) => error instanceof Error ? error.message : String(error)).join("; ")}` });
      options.onDiagnostic?.(diagnostics);
    }
    return { diagnostics };
  }

  function playerHandle(): PlayerBootHandle {
    return {
      ticks: () => ticks,
      rendering: () => halted ? null : handle.renderDiagnostics(),
      shadowDiagnostics: () => halted ? null : captureShadowDiagnostics(handle.scene, { host: "player", meshes: handle.scene.meshes }),
      visuals: () => handle.playVisualStates(),
      meshMaterialNames: () => handle.playMeshMaterialNames(),
      bakedSession: () =>
        halted ? null : handle.bakedSessionDiagnostics(),
      postProcessPassCount: () =>
        halted ? null : handle.postProcessPassCount(),
      renderTasks: () => (halted ? null : handle.renderTaskNames()),
      setRenderSettings: (settings) => {
        if (!halted) handle.setRenderSettings(settings);
      },
      executeConsoleCommand: (line) => consoleHost.execute(line),
      inspectWorld: () => consoleHost.inspectWorld(),
      stop: stopPlayer,
    };
  }
  return playerHandle();
}
