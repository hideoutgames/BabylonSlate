import { createSaveStorageServer, createSessionSaveStorage } from "@haptic/core";
import { createSaveGameStorage } from "@haptic/vfs";
import type { ScalabilityAcknowledgement } from "@haptic/core";
import {
  type createPlayPauseGate,
  createRuntimeFromLoad,
  captureConsoleLogs,
  SessionDiagnosticAggregator,
  type RuntimeDriver,
  type SessionReportEntry,
} from "@haptic/runtime";
import type { DebugInspectSnapshot } from "@haptic/object-model";
import {
  createEngine,
  navDebugBlockersFromActors,
} from "@haptic/render";
import { spawnableLightsFromScripts } from "@haptic/render/spawnable-lights";
import { encodeInputEvents } from "@haptic/input";
import {
  snapshotFloatCount,
  type CommandMessage,
} from "@haptic/bridge";
import { attachInputCapture, type InputCaptureHandle } from "./input-capture";
import { createSessionBoundaryClient } from "./session-boundary-client";
import { RuntimeInspectorClient } from "./runtime-inspector-client";
import { RuntimeMaterialEditHost } from "./runtime-material-edit-host";
import { SimulationCaptureClient } from "./simulation-capture-client";
import { getBuildIdentity } from "../lib/build-identity";
import { observedMoveXFromEvents } from "../lib/play-input-observe";
import { createGameWorkerHost, type GameWorkerHost } from "./game-worker-host";
import {
  editorDracoPublicBase,
  editorKtx2PublicBase,
  editorMeshoptPublicBase,
} from "../lib/public-engine-assets";
import {
  SessionDiagnostics,
  createDiagnosticOperationClient,
  createMessageRateMeter,
  observeBrowserLongTasks,
  type TracePayload,
} from "@haptic/debugger";
import {
  applyPlayBreakpoints,
  applyPlayFpsSample,
  applyPlayGraphDebugObserve,
  applyPlayHudConsoleCommand,
  applyPlaySessionPausedCommand,
  applyPlaySessionStep,
  applyPlaySnapshotTick,
  applyWorkerPlayStats,
  deliverInspectSnapshot,
  describeRetainedTextures,
  diagnosticFromCommand,
  isFatalPlayDiagnostic,
  playInputStampTick,
  printEntryFromCommand,
  resolvePlayFrameCap,
  shouldForwardPlayEngineCommand,
  texturesRetainedAfterPlay,
} from "./play-session-helpers";
import {
  bootInProcessPlay,
  playSessionLoad,
  playSessionWorkerControls,
  schedulePreviewFixtureThrow,
} from "./play-session-boot";
import { createPlaySourceTracker } from "./play-session-sources";
import { createPlaySceneReadiness } from "./play-scene-readiness";
import type {
  PlayHudStats,
  PlaySession,
  PlaySessionOptions,
  PlaySessionResult,
} from "./play-session-types";

// Play's helpers, types, boot and Scene readiness live in their own modules;
// importers keep this path, which re-exports their public names.
export {
  diagnosticFromCommand,
  inspectSnapshotFromCommand,
  deliverInspectSnapshot,
  isFatalPlayDiagnostic,
  applyPlaySessionPausedCommand,
  shouldForwardPlayEngineCommand,
  applyPlayHudConsoleCommand,
  applyPlaySessionStep,
  applyPlayGraphDebugObserve,
  texturesRetainedAfterPlay,
  resolvePlayFrameCap,
  playInputStampTick,
  applyPlaySnapshotTick,
  printEntryFromCommand,
  applyWorkerPlayStats,
  applyPlayFpsSample,
} from "./play-session-helpers";
export type { PlaySessionStepTarget, PlaySessionGraphDebugTarget } from "./play-session-helpers";
export { applyPlayActiveScene } from "./play-scene-readiness";
export { playSessionBootControls, previewFixtureThrowHint } from "./play-session-boot";
export type {
  PlaySessionResult,
  PlaySession,
  PlaySourcePreparation,
  PlaySceneSourceLoader,
  PlayAssetSourceLoader,
  PlayPrintEntry,
  PlayHudStats,
} from "./play-session-types";

/** How long a stopped worker may take to run End Play and finish its save writes. */
const WORKER_STOP_TIMEOUT_MS = 3000;

/**
 * Start a fullscreen Play session. Prefers a dedicated game Worker; falls back
 * to in-process runtime. Own Scene on the shared app Engine via registerView.
 */
export function startPlaySession(options: PlaySessionOptions): PlaySession {
  options = { ...options };
  const { canvas, sharedEngine } = options;
  const texturesBefore = new Set(sharedEngine.getLoadedTexturesCache());
  const textureCountBefore = texturesBefore.size;
  const liveBefore = {
    meshes: 0,
    textures: textureCountBefore,
  };

  let worker: GameWorkerHost | null = null;
  let runtime: RuntimeDriver | null = null;
  // eslint-disable-next-line prefer-const -- runtime command handlers installed first may run before assignment.
  let performanceDiagnostics: SessionDiagnostics<import("@haptic/render").RenderFrameReport> | undefined;
  const diagnosticClient = createDiagnosticOperationClient({
    sessionGeneration: options.sessionGeneration ?? 0,
    send: async (request) => {
      if (worker) { worker.postControl({ type: "diagnosticOperation", ...request }); return; }
      if (!runtime) throw new Error("The game runtime is unavailable.");
      diagnosticClient.receive(await runtime.requestDiagnosticOperation(request));
    },
  });
  // Declared before any runtime callback can read them.
  let stopped = false;
  let stopResult: PlaySessionResult | null = null;
  /** Terminates the stopped worker; set while its stop phase runs. */
  let finishWorkerStop: (() => void) | null = null;
  let gameInputMode: "game" | "edit" = "game";
  let inputTransition = 0;
  let inputTransitionPending = false;
  /** Capture routes exclusively once anything took input away; it must also hear the return. */
  let inputExclusive = false;
  let acknowledgedPaused = false;
  let lastBoundaryId = 0;
  const requestedPauses = new Set<import("@haptic/bridge").SessionPauseReason>();
  const boundaryClient = createSessionBoundaryClient(options.sessionGeneration ?? 0, (request) => {
    if (worker) worker.postControl({ type: "sessionBoundary", ...request });
    else if (runtime) void runtime.requestSessionBoundary(request).then((result) => boundaryClient.receive(result));
    else throw new Error("The game runtime is unavailable");
  });
  const inspectorClient = new RuntimeInspectorClient({
    sessionGeneration: options.sessionGeneration ?? 0,
    cancel: request => {
      if (worker) worker.postControl({ type: "cancelRuntimeInspector", ...request });
      else runtime?.cancelRuntimeInspector(request);
    },
    send: async request => {
      if (worker) { worker.postControl({ type: "runtimeInspector", ...request }); return; }
      if (!runtime) throw new Error("The game runtime is unavailable");
      const owner = runtime;
      const result = await owner.requestRuntimeInspector(request);
      if (runtime !== owner || stopped) return;
      if (result.success && result.payload?.kind === "mutation") {
        // Apply the authoritative edited pose before acknowledging it. This is
        // snapshot publication only: paused edits never advance a game tick.
        if (!owner.copySnapshot(snapBuf)) throw new Error("The runtime edit applied, but its presentation snapshot is unavailable.");
        lastWorkerTickIndex = applyPlaySnapshotTick(lastWorkerTickIndex, snapBuf);
        handle.pushSnapshot(snapBuf);
        if (acknowledgedPaused) handle.requestPausedRedraw();
      }
      inspectorClient.receive(result);
    },
  });
  const suppressGameInput = () => {
    // A `rendering` hold stops game time only: it never neutralizes held input or exits pointer lock.
    const suppressed = inputTransitionPending || gameInputMode === "edit" || acknowledgedPaused ||
      [...requestedPauses].some((reason) => reason !== "rendering");
    const routed = options.mode === "simulate";
    // Ordinary Play keeps shared routing until something actually takes input
    // away; from then on the exclusive capture is told when input returns.
    if (input && (routed || suppressed || inputExclusive)) {
      input.setSuppressed(suppressed);
      inputExclusive = true;
    }
    if (routed) handle.setGameInputEnabled(!suppressed);
    return suppressed;
  };
  let pendingPauseBoundary: Promise<import("@haptic/bridge").SessionBoundaryResult> | null = null;
  const synchronizePauseBoundary = (action: import("@haptic/bridge").SessionBoundaryRequest["action"]) => {
    const work = boundaryClient.request(action).then(result => {
      if (result.success && result.requestId > lastBoundaryId) {
        lastBoundaryId = result.requestId;
        // A `rendering` hold keeps the view drawing and the input flowing; the Engine pauses its own game time for it.
        acknowledgedPaused = result.pauseReasons.some((reason) => reason !== "rendering");
        handle.setGameTimePaused(acknowledgedPaused);
        if (!result.paused) last = performance.now();
        suppressGameInput();
      }
      return result;
    });
    pendingPauseBoundary = work;
    return work;
  };
  const setPauseReason: PlaySession["setPauseReason"] = (reason, paused) => {
    if (paused) requestedPauses.add(reason); else requestedPauses.delete(reason);
    suppressGameInput();
    return synchronizePauseBoundary({ kind: "pause", reason, paused });
  };

  const publishScalabilityStatus = (acknowledgement: ScalabilityAcknowledgement) => {
    if (worker) worker.postControl({ type: "scalabilityStatus", acknowledgement });
    else runtime?.applyScalabilityStatus(acknowledgement);
  };

  /** The game asked for device motion, perhaps before input capture was attached. */
  let deviceMotionRequested = false;
  const handle = createEngine(canvas, {
    renderSettings: options.consoleRenderSettings ?? options.renderSettings,
    physicsWorld: options.physics?.physicsWorld ?? options.scene?.settings.physicsWorld,
    sharedEngine,
    playMode: true,
    // While the view holds for WebGPU render pipelines the game waits, as for a blocking load.
    onPipelineHold: (held) => {
      if (stopped || (!worker && !runtime)) return;
      void setPauseReason("rendering", held).catch((error: unknown) => options.onLog?.(String(error), "error"));
    },
    frameCap: resolvePlayFrameCap(options.frameCap),
    spritePayloads: options.spritePayloads,
    spriteAnimations: options.spriteAnimationPayloads,
    waterPayloads: options.waterPayloads,
    renderTargets: options.renderTargets,
    renderTargetTextures: options.renderTargetTextures,
    tilemapPayloads: options.tilemapPayloads,
    tilesetPayloads: options.tilesetPayloads,
    textureBytes: options.textureBytes,
    areaEmissions: options.areaEmissions,
    texturePixelSizes: options.texturePixelSizes,
    fontFacetypeBytes: options.fontFacetypeBytes,
    fontMsdfJson: options.fontMsdfJson,
    fontMsdfPng: options.fontMsdfPng,
    fontFaceEntries: options.fontFaceEntries,
    fontCssStack: options.fontCssStack,
    fontCssStackByGuid: options.fontCssStackByGuid,
    modelBytes: options.modelBytes,
    modelPayloads: options.modelPayloads,
    modelClipAnimationGuids: options.modelClipAnimationGuids,
    retargetAnimationLoads: options.retargetAnimationLoads,
    loadAudioSourceBytes: options.loadAudioSourceBytes,
    prepareAudioAsset: options.acquireAssetSources ? async (guid, request) => {
      const prepared = await options.acquireAssetSources!([guid], request);
      return sourceTracker.prepareSources(prepared, request.signal);
    } : undefined,
    audioLibrary: options.audioLibrary,
    particleLibrary: options.particleLibrary,
    audioReverbBytes: options.audioReverbBytes,
    audioProjectSettings: options.audioProjectSettings,
    materialDocuments: options.materialDocuments,
    materialFunctions: options.materialFunctions,
    // What the startup sources' Classes may spawn, or the session's.
    spawnableLights: options.spawnableLights ?? spawnableLightsFromScripts(options.scripts ?? []),
    postProcessStack: options.scene?.settings.postProcessStack,
    postProcessingEnabled: options.postProcessingEnabled,
    hardwareScalingLevel: options.hardwareScalingLevel,
    pixelsPerUnit: options.pixelsPerUnit,
    sortingLayers: options.sortingLayers,
    pixelPerfect: options.pixelPerfect,
    touchMinTargetPx: options.touchMinTargetPx,
    environmentColor: options.scene?.settings.environmentColor,
    viewportMode: options.scene?.viewportMode,
    navmeshBytes: options.navmeshBytes,
    navBlockers: options.scene
      ? navDebugBlockersFromActors(options.scene.actors)
      : undefined,
    ktx2BasePath: editorKtx2PublicBase(),
    dracoBasePath: editorDracoPublicBase(),
    meshoptBasePath: editorMeshoptPublicBase(),
    onPostProcessDiagnostic: (diagnostic) => {
      options.onLog?.(diagnostic.message, "warning");
    },
    onAudioDiagnostic: (diagnostic) => {
      options.onLog?.(diagnostic.message, "warning");
      if (diagnostic.assetGuid && ["audio.missing_source", "audio.decode_failed", "audio.budget_exceeded", "audio.play_failed", "audio.load_failed"].includes(diagnostic.code))
        sourceTracker.publishAssetStates([diagnostic.assetGuid], "failed");
    },
    onAudioAssetReady: (guid) => {
      sourceTracker.audioAssetReady(guid);
    },
    onParticleDiagnostic: (diagnostic) => {
      options.onLog?.(diagnostic.message, "warning");
    },
    onMaterialDiagnostic: (diagnostic) => {
      options.onLog?.(
        diagnostic.message,
        diagnostic.severity === "error" ? "error" : "warning",
      );
    },
    // Virtual sticks share the capture's suppression and fresh-transition admission.
    onTouchAxis: (controlId, value) => input?.setTouchAxis(controlId, value),
    onDeviceMotionRequest: () => {
      deviceMotionRequested = true;
      input?.enableMotion();
    },
    onSceneLayerScroll: (event) => {
      if (options.mode === "simulate" && suppressGameInput()) return;
      const control = { type: "sceneLayerScroll" as const, ...event };
      if (worker) worker.postControl(control);
      else runtime?.applySceneLayerScroll(event.layerId, event.actorId, event.componentId, event.deltaX, event.deltaY);
    },
    onSceneLayerControl: (event) => {
      if (options.mode === "simulate" && suppressGameInput()) return;
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
    onScalabilityApplied: publishScalabilityStatus,
    onRagdollPoseCaptured: (result) => {
      if (worker) worker.postControl(result);
      else runtime?.applyRagdollPoseCaptured(result);
    },
    onRuntimeOutputChanged: (settings) => {
      if (options.onRenderOutputChanged) options.onRenderOutputChanged(settings);
      else options.onSetRenderResolution?.(settings.width, settings.height);
    },
  });
  if (options.scene) {
    handle.applySceneEnvironment(options.scene);
  }
  handle.scheduler.invalidate("play");
  const releaseConsoleCapture = captureConsoleLogs(
    console,
    (message, severity) => {
      if (runtime) runtime.reportLog(message, severity);
      else options.onLog?.(message, severity);
    },
  );
  const onWindowError = (event: ErrorEvent) =>
    options.onLog?.(event.error?.stack ?? event.message, "error");
  const onRejection = (event: PromiseRejectionEvent) =>
    options.onLog?.(
      event.reason instanceof Error
        ? (event.reason.stack ?? event.reason.message)
        : String(event.reason),
      "error",
    );
  window.addEventListener("error", onWindowError);
  window.addEventListener("unhandledrejection", onRejection);
  liveBefore.meshes = handle.liveObjectCounts().meshes;

  let runtimeMode: "worker" | "in-process" = "in-process";
  let pauseGate: ReturnType<typeof createPlayPauseGate> | null = null;
  let resetBoot = () => {};
  // Aggregates diagnostics received over the command channel (Worker mode).
  // The in-process path already aggregates via `runtime.getDiagnostics()`.
  const workerDiagnostics = new SessionDiagnosticAggregator();
  const hostDiagnostics = new SessionDiagnosticAggregator();

  const spawnedActorGuids: string[] = [];
  const sourceTracker = createPlaySourceTracker({
    options,
    handle,
    worker: () => worker,
    runtime: () => runtime,
    stopped: () => stopped,
    loadControl: () => loadControl,
  });
  const sceneLoads = createPlaySceneReadiness({
    handle,
    options,
    sources: sourceTracker,
    hostDiagnostics,
    worker: () => worker,
    runtime: () => runtime,
  });
  const consoleWaiters: Array<
    (result: { success: boolean; output: string }) => void
  > = [];
  const inspectWaiters: Array<(snapshot: DebugInspectSnapshot) => void> = [];
  let recordedTrace: TracePayload | null = null;
  const bridgeRate = createMessageRateMeter(() => performance.now());
  let hudStats: PlayHudStats | undefined;
  let lastWorkerTickIndex = 0;
  let input: InputCaptureHandle | null = null;

  const emitHudStats = (next: PlayHudStats) => {
    hudStats = next;
    options.onStats?.(next);
  };

  const simulationSaveStorage = options.mode === "simulate"
    ? options.simulationSaveStorage ?? createSessionSaveStorage(createSaveGameStorage())
    : undefined;
  const saveStorage = simulationSaveStorage ?? createSaveGameStorage();
  const saveServer = createSaveStorageServer(saveStorage, (response) => worker?.postControl({ type: "saveStorageResponse", response }));
  let captureTask: Promise<import("@haptic/runtime").SimulationSceneCaptureResult> | null = null;
  let captureAbort: AbortController | null = null;
  let captureRequested = false;
  let captureFenceActive = false;
  let captureFenceChanged = false;
  const acceptQuiesced = (result: import("@haptic/bridge").SessionBoundaryResult) => {
    if (captureClient.receive({ type: "simulationQuiesced", ...result }) && result.success) {
      captureFenceActive = true;
      captureFenceChanged = false;
    }
  };
  const captureClient = new SimulationCaptureClient({
    generation: options.sessionGeneration ?? 0,
    quiesce: async request => {
      if (worker) { worker.postControl({ type: "quiesceSimulation", ...request }); return; }
      if (!runtime) throw new Error("The Simulation runtime is unavailable.");
      acceptQuiesced(await runtime.quiesceSimulation(request));
    },
    capture: async request => {
      if (worker) { worker.postControl({ type: "captureSimulationState", ...request }); return; }
      if (!runtime) throw new Error("The Simulation runtime is unavailable.");
      captureClient.receiveComplete(request, await runtime.captureSimulationState(request));
    },
  });
  const captureSimulationScene: PlaySession["captureSimulationScene"] = (maxBytes) => {
    if (options.mode !== "simulate" || stopped) return Promise.reject(new Error("A live Simulation session is required for final scene capture."));
    if (captureTask) return captureTask;
    captureRequested = true;
    captureFenceActive = false;
    inspectorClient.dispose();
    input?.neutralize();
    requestedPauses.add("loading");
    suppressGameInput();
    const abort = new AbortController();
    captureAbort = abort;
    const work = (async () => {
      const boundary = await captureClient.quiesce();
      if (!boundary.success) throw new Error(boundary.reason ?? "Simulation did not reach a final boundary.");
      abort.signal.throwIfAborted();
      acknowledgedPaused = true;
      handle.setGameTimePaused(true);
      const drainTimer = setTimeout(() => abort.abort(new Error("Final render-owned resources did not settle within 30 seconds. Retry or Discard the Simulation changes.")), 30_000);
      let rendered: { commandRevision: number };
      try { rendered = await handle.quiesceAuthoringRevision(boundary.commandRevision, abort.signal); }
      finally { clearTimeout(drainTimer); }
      if (captureFenceChanged) throw new Error("A render-owned property changed after the final Simulation boundary.");
      const result = await captureClient.capture(rendered.commandRevision, maxBytes);
      abort.signal.throwIfAborted();
      if (captureFenceChanged) throw new Error("A render-owned property changed while the final Simulation scene was transferring.");
      return result;
    })();
    captureTask = work.finally(() => {
      abort.abort();
      if (captureAbort === abort) captureAbort = null;
      captureTask = null;
    });
    return captureTask;
  };
  const materialEditHost = new RuntimeMaterialEditHost({
    sessionGeneration: options.sessionGeneration ?? 0,
    mode: options.mode ?? "play",
    prepare: request => handle.prepareRuntimeMaterialEdit(request),
    commit: command => handle.commitRuntimeMaterialEdit(command),
    release: token => handle.releaseRuntimeMaterialPreparation(token),
    respond: response => {
      if (worker) worker.postControl(response);
      else runtime?.applyRuntimeMaterialEditResult(response);
    },
  });
  // In-process, a completed Scene, layer or stream reaches readiness with the
  // snapshot that shows it. When none can be copied yet, the next pumped
  // snapshot delivers it, as the worker's scene snapshot delivery does.
  let realizedAwaitingSnapshot: CommandMessage[] = [];
  const deliverRealized = () => {
    const realized = realizedAwaitingSnapshot;
    realizedAwaitingSnapshot = [];
    for (const command of realized) {
      sceneLoads.receive(command);
    }
  };
  const reportRuntimeLog = (command: Extract<CommandMessage, { type: "log" }>) => {
    const severity = command.severity ?? "log";
    options.onLog?.(command.message, severity);
    options.onRuntimeLog?.({ category: command.category, severity, message: command.message });
  };
  const onCommand = (command: CommandMessage) => {
    // Diagnostics finish their final recording while the session stops.
    if (command.type === "diagnosticOperationResult") { diagnosticClient.receive(command); return; }
    if (command.type === "performanceTicks") {
      if (command.sessionGeneration === (options.sessionGeneration ?? 0)) performanceDiagnostics?.receiveTicks(command);
      return;
    }
    if (command.type === "diagnosticOperationStopped") {
      if (command.sessionGeneration === (options.sessionGeneration ?? 0)) performanceDiagnostics?.runtimeStopped(command);
      return;
    }
    // Stop released the presentation, preparation and every correlated client.
    // Output that was already queued, or the stop phase's own, only reaches the log.
    // The worker's stop phase may still write saves, then reports it is done.
    if (stopped) {
      if (command.type === "saveStorageRequest") saveServer.receive(command.request);
      else if (command.type === "runtimeStopped") finishWorkerStop?.();
      else if (command.type === "log") reportRuntimeLog(command);
      else if (command.type === "diagnostic") options.onLog?.(command.message, command.severity ?? "error");
      return;
    }
    if (command.type === "sessionEnded") {
      queueMicrotask(() => options.onSessionEnded?.());
      return;
    }
    if (command.type === "simulationRetentionUnavailable") {
      if (command.sessionGeneration === (options.sessionGeneration ?? 0)) options.onRetentionUnavailable?.(command.reason);
      return;
    }
    if (command.type === "simulationQuiesced") { acceptQuiesced(command); return; }
    if (command.type === "simulationCaptureChunk" || command.type === "simulationCaptureResult") { captureClient.receive(command); return; }
    // Debug views are not activity and never reach the renderer.
    if (command.type === "debugRoster") { options.onDebugRoster?.(command); return; }
    if (command.type === "executionTrace") { options.onExecutionTrace?.(command); return; }
    if (command.type === "debugVariables") { options.onDebugVariables?.(command); return; }
    if (command.type === "btState") { options.onBtState?.(command); return; }
    if (captureFenceActive && shouldForwardPlayEngineCommand(command.type)) captureFenceChanged = true;
    if (materialEditHost.receive(command)) return;
    if (command.type === "sessionBoundaryResult") { boundaryClient.receive(command); return; }
    if (command.type === "runtimeInspectorResult") {
      if (command.success && command.payload?.kind === "mutation" && acknowledgedPaused) handle.requestPausedRedraw();
      inspectorClient.receive(command);
      return;
    }
    if (sourceTracker.receive(command)) return;
    if (command.type === "saveStorageRequest") { saveServer.receive(command.request); return; }
    bridgeRate.note();
    if (command.type === "activeScene") { inspectorClient.invalidateScene(); materialEditHost.invalidate(); }
    if (command.type === "despawn") { inspectorClient.invalidateActor(command.actorGuid); materialEditHost.invalidateActor(command.actorGuid); }
    if (command.type === "simulationBlocking") handle.setSceneStreamingPaused(command.blocking);
    if (command.type === "snapshotLayout" && runtime)
      snapBuf = new Float32Array(snapshotFloatCount(command.capacity));
    if (command.type === "spawn") {
      spawnedActorGuids.push(command.actorGuid);
    }
    if (
      command.type === "snapshotLayout" ||
      shouldForwardPlayEngineCommand(command.type)
    ) {
      handle.applyCommand(command);
    }
    if ((command.type === "sceneRealized" || command.type === "sceneLayerRealized" || command.type === "sceneStreamRealized") && runtime) {
      realizedAwaitingSnapshot.push(command);
      if (!runtime.copySnapshot(snapBuf)) return;
      handle.pushSnapshot(snapBuf);
      deliverRealized();
      return;
    }
    sceneLoads.receive(command);
    if (command.type === "log") reportRuntimeLog(command);
    const printEntry = printEntryFromCommand(command);
    if (printEntry) options.onPrint?.(printEntry);
    if (command.type === "stats") {
      emitHudStats(
        applyWorkerPlayStats(hudStats, {
          fps: command.fps,
          scriptMs: command.scriptMs ?? 0,
          physicsMs: command.physicsMs ?? 0,
          publishMs: command.publishMs,
          phaseMs: command.phaseMs,
          frameId: command.frameId ?? 0,
          // A dropped snapshot must not leave the count behind the simulation.
          ticks: command.tickIndex ?? lastWorkerTickIndex,
          liveActors: command.liveActors,
          snapshotCapacity: command.snapshotCapacity,
        }),
      );
    }
    if (command.type === "diagnostic") {
      options.onLog?.(command.message, command.severity ?? "error");
      const diagnostic = diagnosticFromCommand(command);
      if (diagnostic) workerDiagnostics.push(diagnostic);
      if (isFatalPlayDiagnostic(command.code)) {
        queueMicrotask(() => options.onFatalDiagnostic?.());
      }
    }
    if (command.type === "consoleResult") {
      const waiter = consoleWaiters.shift();
      waiter?.({ success: command.success, output: command.output });
    }
    deliverInspectSnapshot(inspectWaiters, command);
    if (command.type === "trace") {
      recordedTrace = command.payload as unknown as TracePayload;
    }
    if (command.type === "sessionPaused") {
      // Console Pause/Resume already changed the runtime reason. Ask for its
      // completed boundary without rewriting another outstanding pause hold.
      void synchronizePauseBoundary({ kind: "resetInput" }).catch((error: unknown) => options.onLog?.(String(error), "error"));
    }
    applyPlaySessionPausedCommand(command, options.onSessionPaused);
    applyPlayHudConsoleCommand(command, {
      onShowFps: options.onShowFps,
      onStat: options.onStatHighlight,
      onFreeCam: options.onFreeCam,
    });
    if (command.type === "setBehaviourTreeDebug")
      options.onBehaviourTreeDebug?.(command.enabled);
    if (command.type === "behaviourTreeSnapshot")
      options.onBehaviourTreeSnapshot?.(command.trees);
  };

  const { loadControl, scripts, animGraphs } = playSessionLoad(options, sourceTracker.acquireScene !== undefined);

  try {
    worker = createGameWorkerHost();
    runtimeMode = "worker";
    worker.onCommand((cmd) => onCommand(cmd));
    worker.onSnapshot((buffer) => {
      if (stopped) return;
      lastWorkerTickIndex = applyPlaySnapshotTick(lastWorkerTickIndex, buffer);
      handle.pushSnapshot(buffer);
    });
    for (const control of playSessionWorkerControls(options, { loadControl, scripts, animGraphs })) {
      worker.postControl(control);
    }
  } catch (err) {
    // A worker that started but could not take its boot controls must not keep running beside the fallback.
    worker?.terminate();
    worker = null;
    runtimeMode = "in-process";
    runtime = createRuntimeFromLoad(loadControl, (command) =>
      onCommand(command),
      saveStorage,
      sourceTracker.acquireScene ? { acquireScene: sourceTracker.acquireScene } : undefined,
    );
    ({ pauseGate, resetBoot } = bootInProcessPlay(runtime, { options, scripts, animGraphs, stopped: () => stopped }));
    options.onLog?.(
      `Play worker unavailable (${err instanceof Error ? err.message : String(err)}); using in-process.`,
      "warning",
    );
  }
  // The view size too: two-finger drags, cursor projection and Scene Layers measure against it.
  handle.publishSceneLayerSize();
  const initialScalability = handle.scalabilityStatus?.();
  if (initialScalability) publishScalabilityStatus(initialScalability);

  input = attachInputCapture(canvas, {
    skipPointerAndKeyboard: () => handle.isFreeCamEnabled(),
    // The engine's canvas listeners, added by createEngine above, settle UI ownership first.
    ownsPointer: (pointerId) => handle.ownsGamePointer(pointerId),
  });
  if (deviceMotionRequested) input.enableMotion();
  if (options.mode === "simulate") input.setSuppressed(false);

  const unlock = () => {
    void handle.unlockAudio().catch((error: unknown) =>
      options.onLog?.(`Audio unlock: ${error instanceof Error ? error.message : String(error)}`, "warning"));
  };
  canvas.addEventListener("pointerdown", unlock);
  canvas.addEventListener("touchstart", unlock);

  let snapBuf = new Float32Array(snapshotFloatCount(256));
  let last = performance.now();
  let raf = 0;
  let fpsWindowStart = last;
  let sessionDiagnostics: SessionReportEntry[] = [];
  let droppedDiagnostics = 0;
  let lastObservedMoveX: number | null = null;

  const pump = () => {
    if (stopped) return;
    const now = performance.now();
    const elapsed = (now - last) / 1000;
    last = now;
    const tick = playInputStampTick(
      runtime?.getWorld().clock.tickIndex,
      lastWorkerTickIndex,
    );
    input.setTick(tick);
    input.pollGamepads();
    const drained = input.ring.drain();
    if (drained.length > 0) {
      lastObservedMoveX = observedMoveXFromEvents(drained, lastObservedMoveX);
      if (worker) worker.pushInput(drained);
      else if (runtime) runtime.pushInputBuffer(encodeInputEvents(drained));
    }
    if (runtime) {
      runtime.advance(elapsed);
      if (runtime.copySnapshot(snapBuf)) {
        lastWorkerTickIndex = applyPlaySnapshotTick(
          lastWorkerTickIndex,
          snapBuf,
        );
        handle.pushSnapshot(snapBuf);
        deliverRealized();
      }
    }
    // Worker pumps itself; host only feeds input + applies snapshots via onSnapshot.
    if (now - fpsWindowStart >= 1000) {
      emitHudStats(
        applyPlayFpsSample(hudStats, handle.scheduler.stats().renderedFps),
      );
      fpsWindowStart = now;
    }
    raf = requestAnimationFrame(pump);
  };
  raf = requestAnimationFrame(pump);

  schedulePreviewFixtureThrow({ options, runtime: () => runtime, worker: () => worker, workerDiagnostics });

  const diagnosticSessionId = `play:${options.sessionGeneration ?? 0}:${performance.now()}`;
  performanceDiagnostics = new SessionDiagnostics({
    mode: options.mode ?? "play",
    identity: () => {
      const build = getBuildIdentity();
      const render = handle.scalabilityStatus()?.effective?.render ?? options.consoleRenderSettings ?? options.renderSettings;
      const frameCap = handle.scheduler.gateState().frameCap;
      return { sessionId: diagnosticSessionId, mode: options.mode ?? "play", sourceSha: build?.sourceSha ?? null,
        buildId: build ? `${build.packageVersion}:${build.runNumber}.${build.runAttempt}` : null,
        sceneId: sceneLoads.currentSceneGuid() ?? options.sceneAssetGuid ?? "play-scene",
        backend: handle.engine.isWebGPU ? "webgpu" : "webgl2",
        runtimeHost: runtimeMode, quality: JSON.stringify(render ?? {}), frameCap: Number.isFinite(frameCap) ? frameCap : null,
        dynamicResolution: render?.quality?.resolution?.dynamic === true,
        enabledDiagnostics: ["performance"], gpuTiming: "unavailable" };
    },
    observeFrames: (listener) => handle.observePerformance(listener),
    observeGpuTiming: (listener, onError) => handle.observeGpuTiming(listener, onError),
    sampleMemory: () => ({ textureBytes: handle.resourceCache.accountedBytes(), geometryBytes: handle.accountedGeometryBytes() }),
    observeLongTasks: observeBrowserLongTasks,
    runtimeOperation: (request) => diagnosticClient.request(request),
    captureFrame: async (signal) => {
      const cancel = () => handle.cancelFrameCapture("Frame capture was cancelled.");
      signal.addEventListener("abort", cancel, { once: true });
      try {
        // A paused report is render-only only after the requested game-clock
        // boundary has completed; a legacy caller-paused view is insufficient.
        let pending: typeof pendingPauseBoundary;
        do {
          pending = pendingPauseBoundary;
          if (pending) {
            const result = await pending;
            if (!result.success) throw new Error(result.reason ?? "Game pause did not reach its completed boundary.");
          }
          signal.throwIfAborted();
        } while (pending !== pendingPauseBoundary);
        return await handle.captureFrame();
      }
      finally { signal.removeEventListener("abort", cancel); }
    },
    onProfile: (profile) => options.onProfile?.(profile),
  });
  return {
    canvas,
    handle,
    runtime,
    worker,
    runtimeMode,
    diagnostics: performanceDiagnostics,
    setPaused: (paused: boolean) => {
      void setPauseReason("user", paused).catch((error: unknown) => options.onLog?.(String(error), "error"));
    },
    setPauseReason,
    setInputMode: async (mode) => {
      const transition = ++inputTransition;
      const previous = gameInputMode;
      inputTransitionPending = true;
      gameInputMode = mode;
      input.neutralize();
      suppressGameInput();
      let reset = false;
      try {
        const result = await boundaryClient.request({ kind: "resetInput" });
        if (!result.success) throw new Error(result.reason ?? "Game input could not be reset");
        reset = true;
      } finally {
        if (transition === inputTransition && !stopped) {
          // A failed reset keeps the previous mode instead of half-applying the new one.
          if (!reset) gameInputMode = previous;
          inputTransitionPending = false;
          suppressGameInput();
          if (reset) handle.setSimulationEditMode(mode === "edit");
        }
      }
    },
    observeGraphDebug: (target, instanceId) => {
      if (!stopped) applyPlayGraphDebugObserve({ worker, runtime }, target, instanceId);
    },
    setBreakpoints: (breakpoints) => {
      if (!stopped) applyPlayBreakpoints({ worker, runtime }, breakpoints);
    },
    requestPausedRedraw: () => handle.requestPausedRedraw(),
    lastMoveX: () => {
      if (runtime) {
        return runtime.getResolvedInput().axes2D.Move?.x ?? lastObservedMoveX;
      }
      return lastObservedMoveX;
    },
    lastActorPositions: () => handle.lastActorPositions(),
    lastTickIndex: () =>
      playInputStampTick(
        runtime?.getWorld().clock.tickIndex,
        lastWorkerTickIndex,
      ),
    setFrameCap: (fps: number) => {
      handle.scheduler.setFrameCap(fps);
    },
    spawnedActorGuids: () => spawnedActorGuids,
    executeConsoleCommand: (line) => {
      if (captureRequested) return Promise.resolve({ success: false, output: "Simulation is resolving its final scene; choose Retry or Discard." });
      if (stopped)
        return Promise.resolve({
          success: false,
          output: "Play session stopped",
        });
      if (runtime) {
        return runtime.executeConsoleCommandAsync(line);
      }
      if (worker) {
        return new Promise((resolve) => {
          consoleWaiters.push(resolve);
          worker.postControl({ type: "console", line });
        });
      }
      return Promise.resolve({
        success: false,
        output: "runtime unavailable",
      });
    },
    inspectWorld: () => {
      if (runtime) {
        return Promise.resolve(runtime.inspectWorld());
      }
      if (worker) {
        return new Promise((resolve) => {
          inspectWaiters.push(resolve);
          worker.postControl({ type: "inspect" });
        });
      }
      return Promise.resolve({ tickIndex: 0, nodes: [] });
    },
    requestRuntimeInspection: (action, options) => inspectorClient.request(action, options),
    captureSimulationScene,
    step: () => {
      if (captureRequested) return;
      applyPlaySessionStep({ worker, runtime });
    },
    stepPaused: () => captureRequested
      ? Promise.reject(new Error("The Simulation is stopping."))
      : synchronizePauseBoundary({ kind: "step" }),
    lastTrace: () => recordedTrace ?? runtime?.stopTrace() ?? null,
    accountedBytes: () => handle.resourceCache.accountedBytes(),
    liveObjectCounts: () => handle.liveObjectCounts(),
    whenModelsReady: async () => { await sourceTracker.sessionSourcesReady; await handle.whenEditorModelsReady(); },
    modelLoadCount: () => handle.modelLoadCount(),
    drawCalls: () => handle.drawCalls(),
    bridgeMessagesPerSec: () => bridgeRate.perSecond(),
    stop: () => {
      if (stopped && stopResult) return stopResult;
      void performanceDiagnostics?.dispose().finally(() => diagnosticClient.dispose());
      resetBoot();
      pauseGate?.reset();
      sceneLoads.dispose();
      stopped = true;
      boundaryClient.dispose();
      inspectorClient.dispose();
      captureAbort?.abort();
      captureClient.dispose();
      materialEditHost.dispose();
      simulationSaveStorage?.dispose();
      releaseConsoleCapture();
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onRejection);
      for (const resolve of consoleWaiters.splice(0))
        resolve({ success: false, output: "Play session stopped" });
      for (const resolve of inspectWaiters.splice(0))
        resolve({ tickIndex: 0, nodes: [] });
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", unlock);
      canvas.removeEventListener("touchstart", unlock);
      input.dispose();
      if (runtime) {
        runtime.stop();
        sessionDiagnostics = runtime.getDiagnostics().entries();
        droppedDiagnostics = runtime.getDiagnostics().droppedCount();
      } else {
        sessionDiagnostics = workerDiagnostics.entries();
        droppedDiagnostics = workerDiagnostics.droppedCount();
      }
      sessionDiagnostics.push(...hostDiagnostics.entries());
      droppedDiagnostics += hostDiagnostics.droppedCount();
      // Settles once no stopped worker can still write saves.
      let workerStopped: Promise<void> = Promise.resolve();
      if (worker) {
        // End Play and On Game End run in the worker's stop phase and may write
        // saves: keep the worker and its save server until it reports stopped.
        const stopping = worker;
        stopping.postControl({ type: "stop" });
        workerStopped = new Promise<void>((resolve) => {
          const timeout = setTimeout(() => finishWorkerStop?.(), WORKER_STOP_TIMEOUT_MS);
          finishWorkerStop = () => {
            finishWorkerStop = null;
            clearTimeout(timeout);
            saveServer.dispose();
            stopping.terminate();
            resolve();
          };
        });
      } else {
        saveServer.dispose();
      }
      sourceTracker.dispose();
      const liveAfter = handle.liveObjectCounts();
      // The leak check runs once release confirms, when these Scenes are disposed. One that is not still owns what it holds.
      const playScenes = new Set(handle.ownedScenes());
      handle.dispose();
      sourceTracker.releaseSessionSources();
      sourceTracker.releaseInitialSources();
      // Shared-Engine teardown defers Scene/library release until actual
      // native release confirms; measure the texture cache only then. A
      // rejected release quarantines the owners — retained textures are not a
      // leak, and the render layer already warns. The next session also waits
      // for the stopped worker, so its End Play saves cannot land in it.
      const released = Promise.all([
        handle.whenReleased().then(
          () => false,
          () => true,
        ),
        workerStopped,
      ])
        .then(([quarantined]) => {
          const textureCountAfter =
            sharedEngine.getLoadedTexturesCache().length;
          const retained = texturesRetainedAfterPlay(sharedEngine, texturesBefore, playScenes);
          const textureLeak = retained.length > 0;
          const textureLeakDetail = textureLeak ? describeRetainedTextures(sharedEngine, retained) : undefined;
          if (textureLeak && !quarantined) {
            console.error(
              `[play] ${retained.length} texture(s) created during Play outlived it (cache ${textureCountBefore} → ${textureCountAfter}): ${textureLeakDetail}`,
            );
          }
          return { textureCountAfter, textureLeak, quarantined, textureLeakDetail };
        });
      stopResult = {
        diagnostics: sessionDiagnostics,
        droppedDiagnostics,
        textureCountBefore,
        released,
        runtimeMode,
        liveObjectCounts: liveAfter,
        lastTrace: recordedTrace ?? runtime?.stopTrace() ?? null,
      };
      return stopResult;
    },
  };
}
