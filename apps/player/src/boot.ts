import { createSaveStorageServer } from "@babylonslate/core";
import { createSaveGameStorage } from "@babylonslate/vfs";
import type { ScalabilityAcknowledgement, RenderProjectSettings } from "@babylonslate/core";
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
  applyRuntimeSourceControl,
  createSceneSourceHost,
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
  createSceneStreamingReadiness,
  navDebugBlockersFromActors,
  particleStats,
  type EngineHandle,
  type RenderShadingSettings,
  type SceneLoadProgress,
} from "@babylonslate/render";
import { playFramebufferSize, type ResolvedRenderingPipeline, type SerializedScene } from "@babylonslate/core";
import { gameSourceSubset, requiredGameAssets, type GameSourceContent, type GameManifest } from "@babylonslate/exporter";
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
import { packedBootControls, packedContentFromGame, packedSourceControls, type PackedGameContent } from "./hydrate";
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
  scalability: () => ScalabilityAcknowledgement | undefined;
  shadowDiagnostics: () => ReturnType<typeof captureShadowDiagnostics> | null;
  visuals: () => ReturnType<EngineHandle["playVisualStates"]>;
  meshMaterialNames: () => string[];
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

/** Browser qualification surface installed only in test-mode player builds. */
export type PlayerTestHandle = Pick<PlayerBootHandle,
  "visuals" | "meshMaterialNames" | "rendering" | "shadowDiagnostics" |
  "postProcessPassCount" | "renderTasks" | "setRenderSettings" | "executeConsoleCommand" | "scalability" | "stop"
>;

export type PlayerBootOptions = {
  canvas: HTMLCanvasElement;
  game: LoadedGame;
  /** Preview iframes borrow the editor host's application-private storage. */
  saveStorage?: import("@babylonslate/core").SaveGameStorage;
  /** Preview host's trace budget; omitted by standalone games. */
  traceByteBudget?: number;
  sharedEngine?: AbstractEngine;
  content?: PackedGameContent;
  /** Runs after every player resource has attempted cleanup, including startup rollback. */
  onStopped?: () => void;
  onRenderOutputChanged?: (settings: RenderProjectSettings) => void;
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
  own(() => game.dispose?.());
  const manifest: GameManifest = game.manifest;
  const startup = manifest.startupSceneGuid;
  const scene: SerializedScene | undefined = game.scenes.get(startup);
  if (!scene) {
    throw new Error("Set Startup Scene in Project Settings.");
  }
  const content = options.content ?? packedContentFromGame(game);
  const diagnostics: PlayerDiagnostic[] = [];
  const fontIds = new Set(manifest.assets.filter(entry => entry.type === "Font").map(entry => entry.guid));
  const fontFallbacks = new Map(manifest.assets.filter(entry => entry.type === "Font").map(entry => [entry.guid, entry.requiredDependencies?.filter(id => fontIds.has(id)) ?? []]));
  const fontCss = packedFontCssStacks(game.fontFamilies, "sans-serif", manifest.defaultFontGuid, fontFallbacks);

  let worker: PlayerWorkerHost | null = null;
  let runtime: RuntimeDriver | null = null;
  let input: ReturnType<typeof attachInputCapture> | null = null;
  const resourceFailures = new Set<string>();
  const clearResourceFailures = (ids: Iterable<string>) => { for (const id of ids) resourceFailures.delete(id); };
  const consoleHost = createPlayerConsoleHost({
    execute: () =>
      runtime ? (line) => runtime!.executeConsoleCommandAsync(line) : undefined,
    inspect: () => (runtime ? () => runtime!.inspectWorld() : undefined),
    post: (command) => worker?.postControl(command),
  });

  own(() => consoleHost.dispose());
  const publishScalabilityStatus = (acknowledgement: ScalabilityAcknowledgement) => {
    if (worker) worker.postControl({ type: "scalabilityStatus", acknowledgement });
    else runtime?.applyScalabilityStatus(acknowledgement);
  };
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
  let runtimeOutput = manifest.render;
  const handle: EngineHandle = createEngine(canvas, {
    sharedEngine: options.sharedEngine,
    playMode: true,
    frameCap: manifest.playFrameCap,
    renderSettings: manifest.render,
    spritePayloads: content.spritePayloads,
    spriteAnimations: content.spriteAnimationPayloads,
    waterPayloads: content.waterPayloads,
    tilemapPayloads: content.tilemapPayloads,
    tilesetPayloads: content.tilesetPayloads,
    pixelsPerUnit: content.pixelsPerUnit,
    sortingLayers: content.sortingLayers,
    pixelPerfect: content.pixelPerfect,
    touchMinTargetPx: manifest.touchMinTargetPx ?? 44,
    prepareAudioAsset: game.acquireAssets ? async (guid, request) => {
      const source = await game.acquireAssets!([guid], request);
      let releaseRender: (() => void) | undefined;
      try {
        request.signal.throwIfAborted();
        releaseRender = await handle.acquireSceneSources(renderSources(gameSourceSubset(game, source.assetGuids ?? requiredGameAssets(manifest, [guid]))), { signal: request.signal });
        request.signal.throwIfAborted();
        clearResourceFailures(requiredGameAssets(manifest, [guid]));
        await refreshSourceContent();
        request.signal.throwIfAborted();
        return () => { releaseRender?.(); source.release(); if (!halted) { refreshSourceContent(); publishAssetStates(); } };
      } catch (error) { releaseRender?.(); source.release(); throw error; }
    } : undefined,
    textureBytes: game.textureBytes,
    areaEmissions: game.areaEmissions,
    texturePixelSizes: content.texturePixelSizes,
    fontFacetypeBytes: game.fontFacetypeBytes,
    fontMsdfJson: game.fontMsdfJson,
    fontMsdfPng: game.fontMsdfPng,
    fontFaceEntries: [...game.fontBytes].map(([guid, bytes]) => ({ guid, family: game.fontFamilies.get(guid) ?? guid, bytes: bytes.slice().buffer })),
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
    renderTargets: content.renderTargets,
    renderTargetTextures: content.renderTargetTextures,
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
        // Particle Graph problems name the node to focus in the editor.
        nodeId: diagnostic.nodeId,
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
    onTouchAxis: (controlId, value) => {
      input?.ring.push({ kind: "touchAxis", controlId, value, tick: playInputStampTick(runtime?.getWorld().clock.tickIndex, lastWorkerTickIndex) });
    },
    onSceneLayerScroll: (event) => {
      const control = { type: "sceneLayerScroll" as const, ...event };
      if (worker) worker.postControl(control);
      else runtime?.applySceneLayerScroll(event.layerId, event.actorId, event.componentId, event.deltaX, event.deltaY);
    },
    onSceneLayerControl: (event) => {
      const control = { type: "sceneLayerControl" as const, ...event };
      if (worker) worker.postControl(control);
      else runtime?.applySceneLayerControl(control);
    },
    onSceneLayerFocusNavigate: (reverse) => {
      const control = { type: "sceneLayerFocusNavigate" as const, reverse };
      if (worker) worker.postControl(control);
      else runtime?.applySceneLayerFocusNavigate(reverse);
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
          size.safeAreaInsets,
        );
    },
    onAudioVoiceEnded: (voiceId) => {
      const control = { type: "audioVoiceEnded" as const, voiceId };
      if (worker) worker.postControl(control);
      else runtime?.applyAudioVoiceEnded(control);
    },
    onRenderPathChanged: publishRenderPathStatus,
    onScalabilityApplied: publishScalabilityStatus,
    onRagdollPoseCaptured: (result) => {
      if (worker) worker.postControl(result);
      else runtime?.applyRagdollPoseCaptured(result);
    },
    onRuntimeOutputChanged: (settings) => { runtimeOutput = settings; options.onRenderOutputChanged?.(settings); },
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
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          if (!playFramebufferSize(runtimeOutput) && canvas.clientWidth > 0 && canvas.clientHeight > 0) {
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
    traceByteBudget: options.traceByteBudget,
    renderSettings: manifest.render,
    project: manifest.project,
    saveGame: manifest.saveGame,
    type: "load" as const,
    sceneAssetGuid: startup,
    scene,
    physicsWorld: manifest.physicsWorld,
    inputAssets: manifest.inputAssets,
    dataAssets: content.dataAssets,
    inputMappings: manifest.inputMappings,
    focusNavigation: manifest.focusNavigation,
    pixelsPerUnit: content.pixelsPerUnit,
    texturePixelSizes: Object.fromEntries(content.texturePixelSizes),
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
    classAssetGuids: Object.fromEntries(manifest.assets.filter(entry => entry.type === "Class" || entry.type === "Graph").flatMap(entry => [...new Set([entry.classId, entry.name, entry.guid, `scene:${entry.guid}`].filter((id): id is string => !!id))].map(id => [id, entry.guid]))),
    consoleCommands: manifest.assets.flatMap(entry => {
      if (!entry.consoleCommand) return [];
      const classId = entry.classId ?? game.scripts.find(script => script.assetGuid === entry.guid)?.classId ?? entry.name ?? entry.guid;
      return [{ ...entry.consoleCommand, name: entry.consoleCommand.name || classId.toLowerCase(), classId, assetGuid: entry.guid }];
    }),
    ...(game.acquireScene ? { sceneCatalog: manifest.assets.filter(entry => entry.type === "Scene").map(entry => ({ guid: entry.guid, name: entry.name ?? entry.guid })) } : {}),
    sceneLayers,
    sceneNavmeshBytes: Object.fromEntries(content.navmeshByScene),
    ...loopGuardLoadFields(manifest),
    audioAssetGuids: manifest.assets.filter(entry => entry.type === "Audio").map(entry => entry.guid),
    materialParameterCatalog: buildMaterialParameterCatalog(content.materialDocuments, content.materialFunctions),
    materialTextureAssetGuids: materialParameterTextureAssetGuids(game.textureBytes, content.renderTargetTextures),
    renderTargets: Object.fromEntries(content.renderTargets),
    renderTargetTextures: Object.fromEntries(content.renderTargetTextures),
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
      if (!applyPlayerActiveScene(handle, game.scenes, { type: "activeScene", sceneAssetGuid }, hostSceneGuid, receivedActiveScene, content.audioReverbByScene)) {
        throw new Error("The requested scene is not available in this build.");
      }
      if (game.acquireScene && sceneAssetGuid !== startup) { handle.releaseInitialSources(); game.releaseStartup?.(); refreshSourceContent(); publishAssetStates(); }
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
      // Standalone hosts have no parent preview channel. Keep the underlying
      // exception visible as well as the structured lifecycle diagnostic.
      console.error("[player] Scene loading failed.", error);
      diagnostics.push({
        message: `Scene loading failed: ${error instanceof Error ? error.message : String(error)}`,
        severity: "error",
        code: "scene.load.failed",
      });
      try { options.onDiagnostic?.(diagnostics); } finally { haltPlayback(); }
    },
  });
  own(() => sceneReadiness.dispose());
  const streamReadiness = createSceneStreamingReadiness({
    handle,
    onProgress: ({ actorGuid, streamLoadId }, progress) => {
      worker?.postControl({ type: "sceneStreamProgress", actorGuid, streamLoadId, progress });
      runtime?.notifySceneStreamProgress(actorGuid, streamLoadId, progress);
    },
    onReady: ({ actorGuid, streamLoadId }) => {
      worker?.postControl({ type: "sceneStreamReady", actorGuid, streamLoadId });
      runtime?.notifySceneStreamReady(actorGuid, streamLoadId);
    },
    onFailed: ({ actorGuid, streamLoadId }, error) => {
      const message = error instanceof Error ? error.message : String(error);
      worker?.postControl({ type: "sceneStreamFailed", actorGuid, streamLoadId, message });
      runtime?.notifySceneStreamFailed(actorGuid, streamLoadId, message);
    },
  });
  own(() => streamReadiness.dispose());
  const saveStorage = options.saveStorage ?? createSaveGameStorage();
  const saveServer = createSaveStorageServer(saveStorage, (response) => worker?.postControl({ type: "saveStorageResponse", response }));
  own(() => saveServer.dispose());
  const syncMap = <K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>) => {
    target.clear();
    for (const [key, value] of source) target.set(key, value);
  };
  let nextSourceRequest = 0;
  let publishedScripts: readonly import("@babylonslate/bridge").ScriptBundleEntry[] | null = [...game.scripts];
  let sourcePublication: Promise<void> = Promise.resolve();
  const pendingSourceRequests = new Map<number, { resolve: () => void; reject: (error: unknown) => void }>();
  own(() => { for (const request of pendingSourceRequests.values()) request.reject(new DOMException("Player stopped", "AbortError")); pendingSourceRequests.clear(); });
  const refreshSourceContent = () => {
    const next = packedContentFromGame(game);
    // Services retain these library objects. Mutate their maps and install the
    // complete surviving union so releasing one instance cannot break another.
    for (const key of Object.keys(content) as Array<keyof PackedGameContent>) {
      const current = content[key];
      const replacement = next[key];
      if (current instanceof Map && replacement instanceof Map) syncMap(current as Map<unknown, unknown>, replacement);
      else if (Array.isArray(current) && Array.isArray(replacement)) current.splice(0, current.length, ...replacement as never[]);
    }
    for (const key of ["audio", "mixers", "channels", "attenuations"] as const) syncMap(content.audioLibrary[key] as Map<unknown, unknown>, next.audioLibrary[key]);
    content.audioLibrary.sourceRevisions = next.audioLibrary.sourceRevisions;
    content.navmeshBytes = next.navmeshBytes;
    content.audioReverbBytes = next.audioReverbBytes;
    syncMap(content.particleLibrary.emitters as Map<unknown, unknown>, next.particleLibrary.emitters);
    syncMap(content.particleLibrary.systems as Map<unknown, unknown>, next.particleLibrary.systems);
    for (const control of packedSourceControls(game, content)) {
      if (control.type === "loadScripts") {
        if (publishedScripts && control.scripts.length === publishedScripts.length && control.scripts.every((script, index) => script === publishedScripts![index])) continue;
        const scheduledScripts = [...control.scripts];
        publishedScripts = scheduledScripts;
        sourcePublication = sourcePublication.catch(() => {}).then(async () => {
          if (halted) throw new DOMException("Player stopped", "AbortError");
          if (worker) {
            const requestId = ++nextSourceRequest;
            await new Promise<void>((resolve, reject) => {
              pendingSourceRequests.set(requestId, { resolve, reject });
              try { worker!.postControl({ ...control, requestId }); }
              catch (error) { pendingSourceRequests.delete(requestId); reject(error); }
            });
          } else if (runtime) await applyRuntimeSourceControl(runtime, control);
        });
        // Acquisition paths await this same promise; eviction-only refreshes
        // still report an actionable failure without an unhandled rejection.
        void sourcePublication.catch(error => {
          if (publishedScripts === scheduledScripts) publishedScripts = null;
          if (!halted) options.onConsoleEvent?.({ type: "log", severity: "error", message: error instanceof Error ? error.message : String(error) });
        });
        continue;
      }
      if (worker) worker.postControl(control);
      else if (runtime) void applyRuntimeSourceControl(runtime, control).catch(error => runtime?.reportError(error));
    }
    return sourcePublication;
  };
  const renderSources = (sources: GameSourceContent) => {
    const prepared = packedContentFromGame(sources);
    const fonts = packedFontCssStacks(sources.fontFamilies, "sans-serif", manifest.defaultFontGuid, fontFallbacks);
    return {
      assets: {
        textureBytes: sources.textureBytes, areaEmissions: sources.areaEmissions,
        modelBytes: sources.modelBytes, modelPayloads: sources.modelPayloads,
        modelClipAnimationGuids: prepared.modelClipAnimationGuids, retargetAnimationLoads: prepared.retargetAnimationLoads,
        spritePayloads: prepared.spritePayloads, spriteAnimations: prepared.spriteAnimationPayloads,
        tilemaps: prepared.tilemapPayloads, tilesets: prepared.tilesetPayloads, waters: prepared.waterPayloads,
        renderTargets: prepared.renderTargets, renderTargetTextures: prepared.renderTargetTextures,
        texturePixelSizes: prepared.texturePixelSizes, pixelsPerUnit: prepared.pixelsPerUnit,
        fontFacetypeBytes: sources.fontFacetypeBytes, fontMsdfJson: sources.fontMsdfJson, fontMsdfPng: sources.fontMsdfPng,
        fontCssStack: fonts.fontCssStack, fontCssStackByGuid: fonts.fontCssStackByGuid,
      },
      materialDocuments: prepared.materialDocuments, materialFunctions: prepared.materialFunctions,
      audioLibrary: prepared.audioLibrary, particleLibrary: prepared.particleLibrary,
      fonts: [...sources.fontBytes].map(([guid, bytes]) => ({ guid, family: sources.fontFamilies.get(guid) ?? guid, bytes: bytes.slice().buffer })),
    };
  };
  if (game.acquireAssets) handle.setCommandSourceLoader?.(async (ids, request) => {
    const source = await game.acquireAssets!([...ids], { ...request, priority: "gameplay" });
    let releaseRender: (() => void) | undefined;
    try {
      request.signal.throwIfAborted();
      releaseRender = await handle.acquireSceneSources(renderSources(gameSourceSubset(game, source.assetGuids ?? requiredGameAssets(manifest, ids))), { prepare: true, signal: request.signal });
      request.signal.throwIfAborted();
      clearResourceFailures(requiredGameAssets(manifest, ids));
      await refreshSourceContent();
      request.signal.throwIfAborted();
      return () => { releaseRender?.(); source.release(); if (!halted) { refreshSourceContent(); publishAssetStates(); } };
    } catch (error) { releaseRender?.(); source.release(); throw error; }
  });
  const systemAssets = game.systemAssetGuids ?? requiredGameAssets(manifest, manifest.assets.filter(entry => entry.startupRequired).map(entry => entry.guid));
  const systemSources = game.acquireScene && systemAssets.size ? handle.acquireSceneSources(renderSources(gameSourceSubset(game, systemAssets))).then(release => { if (halted) release(); else own(release); }) : Promise.resolve();
  const acquireScene = game.acquireScene ? async (guid: string, request: { consumer: string; signal: AbortSignal }) => {
    const source = await game.acquireScene!(guid, request);
    let releaseRender: (() => void) | undefined;
    try {
      await systemSources;
      request.signal.throwIfAborted();
      releaseRender = await handle.acquireSceneSources(renderSources(gameSourceSubset(game, source.assetGuids ?? requiredGameAssets(manifest, [guid]))), { prepare: true, signal: request.signal });
      request.signal.throwIfAborted();
      clearResourceFailures(requiredGameAssets(manifest, [guid]));
      await refreshSourceContent();
      request.signal.throwIfAborted();
      publishAssetStates();
      return { scene: source.scene, release: () => { releaseRender?.(); source.release(); if (!halted) { refreshSourceContent(); publishAssetStates(); } } };
    } catch (error) { releaseRender?.(); source.release(); if (!halted) refreshSourceContent(); throw error; }
  } : undefined;
  const sceneSources = acquireScene ? createSceneSourceHost({ acquireScene, send: control => worker?.postControl(control) }) : undefined;
  own(() => sceneSources?.dispose());
  const preloads = new Map<string, { controller: AbortController; release?: () => void }>();
  const preparingPreloads = new Map<string, Set<string>>();
  const preloadResult = (result: { preloadId: string; success: boolean; error?: string; progress?: number }) => {
    if (worker) worker.postControl({ type: "assetPreloadResult", ...result });
    else runtime?.notifyAssetPreloadResult(result);
  };
  const publishAssetStates = () => {
    const states = manifest.assets.map(entry => ({ guid: entry.guid, state: [...preparingPreloads.values()].some(ids => ids.has(entry.guid)) ? "loading" as const : resourceFailures.has(entry.guid) ? "failed" as const : game.assets?.getLoadState(entry.guid) ?? "ready" as const }));
    if (worker) worker.postControl({ type: "assetLoadStates", states });
    else runtime?.setAssetLoadStates(states);
  };
  if (game.onSourcesChanged) own(game.onSourcesChanged(() => { if (!halted) { refreshSourceContent(); publishAssetStates(); } }));
  const releasePreload = (id: string) => {
    const request = preloads.get(id);
    if (!request) return;
    preloads.delete(id);
    preparingPreloads.delete(id);
    request.controller.abort();
    request.release?.();
    if (!halted) { refreshSourceContent(); publishAssetStates(); }
  };
  own(() => { for (const id of preloads.keys()) releasePreload(id); });
  const receivePreload = (command: { type: string } & Record<string, unknown>): boolean => {
    if (command.type === "assetPreloadRelease") { releasePreload(String(command.preloadId)); return true; }
    if (command.type !== "assetPreload") return false;
    const preloadId = String(command.preloadId);
    const ids = Array.isArray(command.assetGuids) ? command.assetGuids.filter((id): id is string => typeof id === "string") : [];
    releasePreload(preloadId);
    const request: { controller: AbortController; release?: () => void } = { controller: new AbortController() };
    preloads.set(preloadId, request);
    preparingPreloads.set(preloadId, requiredGameAssets(manifest, ids));
    clearResourceFailures(ids);
    publishAssetStates();
    void (async () => {
      if (!game.acquireAssets) throw new Error("This player does not provide demand-driven asset loading.");
      const source = await game.acquireAssets(ids, { consumer: `preload:${String(command.ownerId)}`, signal: request.controller.signal, priority: "preload",
        onProgress: ({ completed, total }) => { preloadResult({ preloadId, success: true, progress: total ? Math.min(0.9, completed / total * 0.9) : 0 }); publishAssetStates(); },
      });
      let releaseRender: (() => void) | undefined;
      try {
        request.controller.signal.throwIfAborted();
        releaseRender = await handle.acquireSceneSources(renderSources(gameSourceSubset(game, source.assetGuids ?? requiredGameAssets(manifest, ids))), { prepare: true, signal: request.controller.signal, priority: "preload" });
        request.controller.signal.throwIfAborted();
        request.release = () => { releaseRender?.(); source.release(); };
        clearResourceFailures(requiredGameAssets(manifest, ids));
        await refreshSourceContent();
        request.controller.signal.throwIfAborted();
        preparingPreloads.delete(preloadId);
        publishAssetStates();
        preloadResult({ preloadId, success: true, progress: 1 });
      } catch (error) { releaseRender?.(); source.release(); throw error; }
    })().catch((error: unknown) => {
      if (preloads.get(preloadId) !== request) return;
      for (const id of ids) resourceFailures.add(id);
      releasePreload(preloadId);
      preloadResult({ preloadId, success: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  };
  const onCommand = (command: { type: string } & Record<string, unknown>) => {
    if (command.type === "assetSourcesReady") {
      const requestId = Number(command.requestId);
      const request = pendingSourceRequests.get(requestId);
      if (request) { pendingSourceRequests.delete(requestId); if (command.success === true) request.resolve(); else request.reject(new Error(String(command.error ?? "Compiled Class source preparation failed."))); }
      return;
    }
    if (receivePreload(command)) return;
    if (sceneSources?.receive(command as never)) return;
    if (command.type === "saveStorageRequest") { saveServer.receive(command.request as import("@babylonslate/core").SaveStorageRequest); return; }
    if (halted) return;
    if (command.type === "sceneStreamBlocking") handle.setSceneStreamingPaused(command.blocking === true);
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
    if ((command.type === "sceneRealized" || command.type === "sceneLayerRealized" || command.type === "sceneStreamRealized") && runtime) {
      if (!runtime.copySnapshot(snapBuf)) throw new Error("Completed Scene snapshot is unavailable.");
      handle.pushSnapshot(snapBuf);
    }
    sceneReadiness.receive(command);
    streamReadiness.receive(command);
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
          publishMs: Number(command.publishMs ?? 0),
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
    worker.onError((error) => {
      if (halted) return;
      diagnostics.push({ code: "player.worker.failed", severity: "error", message: error.message });
      try { options.onDiagnostic?.(diagnostics); }
      finally { haltPlayback(); }
    });
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
    publishAssetStates();
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
      saveStorage,
      acquireScene ? { acquireScene } : undefined,
    );
    runtime = inProcess;
    publishAssetStates();
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
    inProcess.registerWaterContent(content.waterPayloads);
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
  const initialScalability = handle.scalabilityStatus?.();
  if (initialScalability) publishScalabilityStatus(initialScalability);

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
      scalability: () => handle.scalabilityStatus?.(),
      shadowDiagnostics: () => halted ? null : captureShadowDiagnostics(handle.scene, { host: "player", meshes: handle.scene.meshes }),
      visuals: () => handle.playVisualStates(),
      meshMaterialNames: () => handle.playMeshMaterialNames(),
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
