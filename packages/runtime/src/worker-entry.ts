import { simulationCaptureChunks } from "./simulation-capture-transport";
import { createSaveStorageClient, normalizeWaterDefinition } from "@haptic/core";
/**
 * Game worker entry. Hosts create a Worker from this module URL and post
 * control / input messages. In-process Play uses `createInProcessRuntime`.
 */
import { parseAnimGraphDocument } from "@haptic/anim-graph";
import {
  parseBehaviourTreeDocument,
  parseBlackboardDocument,
} from "@haptic/behaviour-tree";
import {
  normalizeModelPayload,
  normalizeTilemapPayload,
  normalizeTilesetPayload,
  parseSpriteAnimationPayload,
  type ModelPayload,
  type SpritePayload,
} from "@haptic/assets";
import {
  TransferablePingPong,
  dynamicMeshTransferables,
  type BridgeHostMessage,
  type BridgeWorkerMessage,
  type CommandMessage,
  type ControlMessage,
} from "@haptic/bridge";
import { createInProcessRuntime, type RuntimeDriver } from "./driver";
import { createRuntimeFromLoad } from "./play-load";
import { createPlayBootCoordinator } from "./play-boot";
import { createPlayPauseGate } from "./play-pause-gate";
import { applyInspectControl } from "./inspect-control";
import { createWorkerScheduler } from "./worker-scheduler";
import { captureConsoleLogs } from "./console-capture";
import { createSceneSnapshotDelivery } from "./scene-snapshot-delivery";
import { createSceneSourceClient } from "./scene-source";
import { cookedCollisionMeshMap } from "./source-content-control";

let runtime: RuntimeDriver | null = null;
let sceneSources = createSceneSourceClient(onCommand);
let saveStorage = createSaveStorageClient((request) => onCommand({ type: "saveStorageRequest", request }));
const boot = createPlayBootCoordinator();
let bootGeneration = 0;
let consoleQueue = Promise.resolve();
const sceneSnapshots = createSceneSnapshotDelivery({
  publishSnapshot: () => publishSnapshot(),
  send: queueCommand,
});
// Recycled via the host's `recycleSnapshot` message so the per-frame
// snapshot transfer never allocates a fresh ArrayBuffer once warmed up.
let snapshotPing = new TransferablePingPong(256);
// Poses are latest-state. A host that stops returning buffers (a stalled main
// thread or a hidden tab) must not queue a transfer every tick: with this many
// outstanding, a tick's pose is skipped and the newest one is published as
// soon as a buffer comes back. Structural commands are never held.
const MAX_IN_FLIGHT_SNAPSHOTS = 2;
let inFlightSnapshots = 0;
let snapshotSkipped = false;
// One-shot replies that describe a pose and were held by backpressure; each
// is sent, in order, right after the next pose snapshot. Never dropped.
let afterPose: CommandMessage[] = [];

function releaseAfterPose(): void {
  if (afterPose.length === 0) return;
  const held = afterPose;
  afterPose = [];
  for (const command of held) onCommand(command);
  // Right after the pose, not behind whatever the rest of the handler emits.
  flushCommands();
}
let installedGeneration = 0;
let pendingGeneration: number | null = null;
// A layout whose transfer buffers could not be allocated yet; poses wait for it.
let unpostedLayout: Extract<CommandMessage, { type: "snapshotLayout" }> | null = null;
let stopConsoleCapture: (() => void) | null = null;

// Plain commands leave as one `commands` message instead of one clone each. The
// queue is flushed where the emitting handler or tick ends and before every
// other post (`post`), so the host sees the order separate posts would give.
let commandQueue: CommandMessage[] = [];
let flushScheduled = false;

function queueCommand(command: CommandMessage): void {
  commandQueue.push(command);
  if (flushScheduled) return;
  flushScheduled = true;
  // Replies from promise and timer continuations have no handler end to flush them.
  queueMicrotask(flushScheduledCommands);
}

function flushScheduledCommands(): void {
  flushScheduled = false;
  flushCommands();
}

/** Never throws, so a flush on the way to a pose or a `finally` cannot lose that post or mask an error. */
function flushCommands(): void {
  if (commandQueue.length === 0) return;
  const batch = commandQueue;
  commandQueue = [];
  try {
    postMessage({ channel: "commands", payload: batch } satisfies BridgeWorkerMessage);
  } catch {
    // A command the structured clone rejects must not drop the rest of the
    // batch: send the others alone, in order, and report each failure as uncaught.
    for (const command of batch) {
      try {
        postMessage({ channel: "command", payload: command } satisfies BridgeWorkerMessage);
      } catch (error) {
        queueMicrotask(() => { throw error; });
      }
    }
  }
}

/** Every post except the batch itself, so queued commands are never overtaken. */
function post(message: BridgeWorkerMessage, transfer?: Transferable[]): void {
  flushCommands();
  if (transfer) postMessage(message, transfer);
  else postMessage(message);
}

function onCommand(command: CommandMessage): void {
  if (command.type === "performanceTicks") {
    post({ channel: "command", payload: command }, [command.rows.buffer as ArrayBuffer]);
    return;
  }
  if (sceneSnapshots.receive(command)) return;
  if (command.type === "sessionEnded") {
    // `quit` already ran End Play and On Game End. The host ends the session, and in the
    // player terminates this worker, only once their save writes are answered.
    const rt = runtime;
    const generation = bootGeneration;
    void saveStorage.whenIdle().then(() => {
      if (runtime === rt && generation === bootGeneration) queueCommand(command);
    });
    return;
  }
  const geometryTransfers = dynamicMeshTransferables(command);
  if (geometryTransfers) {
    post({ channel: "command", payload: command }, geometryTransfers);
    return;
  }
  if (command.type === "cableFrame") {
    post({ channel: "command", payload: command }, [command.data.buffer as ArrayBuffer]);
    return;
  }
  if (command.type === "snapshotLayout") {
    installSnapshotLayout(command);
    return;
  }
  queueCommand(command);
}

/**
 * Grow the transfer buffers for a layout, then announce it. When allocation
 * fails, the failure is reported once and poses wait; each later publish
 * retries the newest layout, so poses resume once memory allows.
 */
function installSnapshotLayout(command: Extract<CommandMessage, { type: "snapshotLayout" }>): boolean {
  try {
    snapshotPing = snapshotPing.grow(command.capacity);
  } catch (error) {
    if (unpostedLayout?.generation !== command.generation) {
      ensureRuntime().reportError(new Error(`Unable to allocate transferable Actor snapshots (${command.capacity}): ${error instanceof Error ? error.message : String(error)}`));
    }
    unpostedLayout = command;
    return false;
  }
  unpostedLayout = null;
  pendingGeneration = command.generation;
  post({ channel: "command", payload: command });
  return true;
}

function ensureRuntime(seed = 1): RuntimeDriver {
  if (!runtime) {
    runtime = createInProcessRuntime({
      seed,
      onCommand,
    });
  }
  return runtime;
}

const pauseGate = createPlayPauseGate({
  pause: () => ensureRuntime().pause(),
  resume: () => ensureRuntime().resume(),
});

function handleControl(msg: ControlMessage): void {
  switch (msg.type) {
    case "quiesceSimulation": {
      const rt = runtime;
      if (!rt) {
        onCommand({ type: "simulationQuiesced", sessionGeneration: msg.sessionGeneration, requestId: msg.requestId,
          success: false, reason: "Runtime is unavailable.", paused: false, pauseReasons: [], tickIndex: 0,
          sceneAssetGuid: "", sceneLoadId: 0, commandRevision: 0 }); return;
      }
      void rt.quiesceSimulation(msg).then(result => onCommand({ type: "simulationQuiesced", ...result }));
      return;
    }
    case "captureSimulationState": {
      const rt = runtime;
      const generation = bootGeneration;
      const refuse = (reason: string) => onCommand({ type: "simulationCaptureResult", sessionGeneration: msg.sessionGeneration, requestId: msg.requestId,
        result: { ok: false, code: "boundary", path: "scene", reason, identity: {
          generation: msg.sessionGeneration, sceneAssetGuid: "", sceneInstanceId: "", sceneLoadId: 0, tickIndex: 0, commandRevision: 0 } } });
      if (!rt) { refuse("Runtime is unavailable."); return; }
      // Every request ends with a result, so chunks already posted never wait on
      // the host's capture timeout when `load` or `stop` replaces the session.
      const superseded = () => runtime !== rt || bootGeneration !== generation;
      const refuseSuperseded = () => refuse("The session was replaced or stopped before its final capture completed.");
      void rt.captureSimulationState(msg).then(async result => {
        if (superseded()) { refuseSuperseded(); return; }
        if (!result.ok) { onCommand({ type: "simulationCaptureResult", sessionGeneration: msg.sessionGeneration, requestId: msg.requestId, result }); return; }
        let sequence = 0;
        for (const bytes of simulationCaptureChunks(result.scene)) {
          if (superseded()) { refuseSuperseded(); return; }
          const chunk: CommandMessage = { type: "simulationCaptureChunk", sessionGeneration: msg.sessionGeneration, requestId: msg.requestId, sequence: sequence++, bytes };
          post({ channel: "command", payload: chunk }, [bytes.buffer as ArrayBuffer]);
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (superseded()) { refuseSuperseded(); return; }
        onCommand({ type: "simulationCaptureResult", sessionGeneration: msg.sessionGeneration, requestId: msg.requestId,
          result: { ok: true, identity: result.identity, byteSize: result.byteSize, chunkCount: sequence } });
      }).catch((error: unknown) => {
        // Report the failure now instead of leaving the host to its capture timeout.
        refuse(error instanceof Error ? error.message : String(error));
      });
      return;
    }
    case "runtimeMaterialEditPrepared":
    case "runtimeMaterialEditApplied":
      runtime?.applyRuntimeMaterialEditResult(msg);
      return;
    case "diagnosticOperation": {
      const rt = runtime;
      if (!rt) {
        onCommand({ type: "diagnosticOperationResult", sessionGeneration: msg.sessionGeneration, requestId: msg.requestId,
          recordingId: msg.operation.recordingId, success: false, reason: "Runtime is unavailable." });
        return;
      }
      void rt.requestDiagnosticOperation(msg).then(result => onCommand({ type: "diagnosticOperationResult", ...result }));
      return;
    }
    case "cancelRuntimeInspector":
      runtime?.cancelRuntimeInspector(msg);
      return;
    case "runtimeInspector": {
      const rt = runtime;
      if (!rt) {
        onCommand({ type: "runtimeInspectorResult", sessionGeneration: msg.sessionGeneration, requestId: msg.requestId,
          success: false, reason: "Runtime is unavailable.", tickIndex: 0, frameId: 0, commandRevision: 0, structuralRevision: 0 });
        return;
      }
      void rt.requestRuntimeInspector(msg).then(result => {
        const command: CommandMessage = { type: "runtimeInspectorResult", ...result };
        // A paused host redraws on this result, so it must follow the edited pose.
        if (runtime === rt && result.success && result.payload?.kind === "mutation" && !publishSnapshot() && snapshotSkipped) {
          afterPose.push(command);
          return;
        }
        onCommand(command);
      });
      return;
    }
    case "sessionBoundary": {
      const rt = runtime;
      if (!rt) {
        onCommand({ type: "sessionBoundaryResult", sessionGeneration: msg.sessionGeneration, requestId: msg.requestId,
          success: false, reason: "Runtime is unavailable.", paused: false, pauseReasons: [], tickIndex: 0,
          sceneAssetGuid: "", sceneLoadId: 0, commandRevision: 0 });
        return;
      }
      void rt.requestSessionBoundary(msg).then(result => {
        if (runtime === rt && result.success && !result.paused && msg.action.kind === "pause") scheduler.resetClock();
        onCommand({ type: "sessionBoundaryResult", ...result });
      });
      return;
    }
    case "loadSceneContent": ensureRuntime().registerSceneContent(msg); return;
    case "saveStorageResponse":
      saveStorage.receive(msg.response);
      return;
    case "sceneSourceResponse":
      sceneSources.receive(msg);
      return;
    case "load": {
      releaseAfterPose();
      bootGeneration++;
      boot.reset();
      pauseGate.reset();
      sceneSnapshots.reset();
      stopConsoleCapture?.();
      stopConsoleCapture = captureConsoleLogs(console, (message, severity) => {
        if (runtime) runtime.reportLog(message, severity);
        else onCommand({ type: "log", message, severity, category: "console", frameId: 0 });
      });
      scheduler.stop();
      if (runtime) {
        runtime.stop();
        runtime = null;
      }
      // The replaced runtime's layout never applies to the next one.
      unpostedLayout = null;
      saveStorage.dispose();
      sceneSources.dispose();
      sceneSources = createSceneSourceClient(onCommand);
      saveStorage = createSaveStorageClient((request) => onCommand({ type: "saveStorageRequest", request }));
      runtime = createRuntimeFromLoad(msg, onCommand, saveStorage.storage,
        msg.sceneCatalog ? { acquireScene: sceneSources.acquireScene } : undefined);
      return;
    }
    case "loadScripts": {
      const rt = ensureRuntime();
      void boot.queueScripts(rt, msg.scripts, msg.spawn ?? [], msg.replace).then(() => {
        if (msg.requestId !== undefined) onCommand({ type: "assetSourcesReady", requestId: msg.requestId,
          success: runtime === rt, ...(runtime !== rt ? { error: "Runtime changed during script preparation." } : {}) });
      }, (error: unknown) => {
        if (msg.requestId !== undefined) onCommand({ type: "assetSourcesReady", requestId: msg.requestId,
          success: false, error: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    case "loadAnimGraphs": {
      const rt = ensureRuntime();
      for (const entry of msg.graphs) {
        const document = parseAnimGraphDocument(entry.document);
        if (document) rt.registerAnimGraph(entry.guid, document);
      }
      return;
    }
    case "loadBehaviourTrees": {
      const rt = ensureRuntime();
      for (const entry of msg.trees) {
        const document = parseBehaviourTreeDocument(entry.document);
        if (document) rt.registerBehaviourTree(entry.guid, document);
      }
      for (const entry of msg.blackboards ?? []) {
        const document = parseBlackboardDocument(entry.document);
        if (document) rt.registerBlackboard(entry.guid, document);
      }
      return;
    }
    case "loadWater": {
      ensureRuntime().registerWaterContent(new Map(msg.waters.map((entry) => [entry.guid, normalizeWaterDefinition(entry.document)])));
      return;
    }
    case "loadTilemaps": {
      const rt = ensureRuntime();
      const tilemaps: Record<string, ReturnType<typeof normalizeTilemapPayload>> =
        {};
      const tilesets: Record<string, ReturnType<typeof normalizeTilesetPayload>> =
        {};
      for (const entry of msg.tilemaps) {
        tilemaps[entry.guid] = normalizeTilemapPayload(entry.document);
      }
      for (const entry of msg.tilesets) {
        tilesets[entry.guid] = normalizeTilesetPayload(entry.document);
      }
      rt.registerTileContent({
        tilemaps,
        tilesets,
        pixelsPerUnit: msg.pixelsPerUnit,
      });
      return;
    }
    case "loadSprites": {
      const rt = ensureRuntime();
      const sprites: Record<string, SpritePayload> = {};
      const spriteAnimations: Record<
        string,
        ReturnType<typeof parseSpriteAnimationPayload>
      > = {};
      for (const entry of msg.sprites) {
        const document = entry.document;
        if (!document || typeof document !== "object") continue;
        const record = document as { frames?: unknown; clips?: unknown };
        if (!Array.isArray(record.frames) || !Array.isArray(record.clips)) {
          continue;
        }
        sprites[entry.guid] = document as SpritePayload;
      }
      for (const entry of msg.spriteAnimations) {
        spriteAnimations[entry.guid] = parseSpriteAnimationPayload(
          entry.document,
        );
      }
      rt.registerSpriteContent({
        sprites,
        spriteAnimations,
        pixelsPerUnit: msg.pixelsPerUnit,
      });
      return;
    }
    case "loadModels": {
      const rt = ensureRuntime();
      const models: Record<string, ModelPayload> = {};
      for (const entry of msg.models) {
        models[entry.guid] = normalizeModelPayload(entry.document);
      }
      rt.registerModelContent({ models, complexMeshes: cookedCollisionMeshMap(msg.complexMeshes) });
      return;
    }
    case "loadComplexCollision": {
      ensureRuntime().registerComplexCollisionMeshes(cookedCollisionMeshMap(msg.meshes), msg.unavailable);
      return;
    }
    case "loadNavMesh": {
      const rt = ensureRuntime();
      boot.queueNavMesh(rt, msg.bytes ? new Uint8Array(msg.bytes) : undefined);
      return;
    }
    case "play": {
      const rt = ensureRuntime();
      const generation = bootGeneration;
      void pauseGate.beginPlay((onStarted) => boot.play(rt, () => {
        if (runtime !== rt || generation !== bootGeneration) return;
        onStarted();
        scheduler.start();
      })).catch((error: unknown) => {
        if (runtime !== rt || generation !== bootGeneration) return;
        scheduler.stop();
        sceneSnapshots.reset();
        rt.reportError(error);
      });
      return;
    }
    case "step": {
      const rt = ensureRuntime();
      rt.resume();
      try {
        rt.tick();
      } finally {
        rt.pause();
      }
      return;
    }
    case "stop": {
      releaseAfterPose();
      bootGeneration++;
      boot.reset();
      pauseGate.reset();
      sceneSnapshots.reset();
      scheduler.stop();
      ensureRuntime().stop();
      sceneSources.dispose();
      stopConsoleCapture?.();
      stopConsoleCapture = null;
      // End Play and On Game End may still be writing saves through the host:
      // report the stop once they finish, so the host keeps this worker until then.
      void saveStorage.whenIdle().then(() => onCommand({ type: "runtimeStopped" }));
      return;
    }
    case "setPaused":
      // A render hold is a time-only pause the runtime keeps apart from Pause; it never waits for the boot gate.
      if (msg.reason === "rendering") {
        if (msg.paused) runtime?.pause("rendering"); else runtime?.resume("rendering");
      } else pauseGate.setPaused(msg.paused);
      return;
    case "debugObserve":
      runtime?.applyDebugObserve(msg.target, msg.instanceId);
      return;
    case "console": {
      const rt = ensureRuntime();
      const generation = bootGeneration;
      // Hosts correlate replies in control-channel order while reads stay async.
      consoleQueue = consoleQueue.then(async () => {
        const result = await rt.executeConsoleCommandAsync(msg.line);
        if (runtime === rt && generation === bootGeneration) onCommand({ type: "consoleResult", ...result });
      }).catch(error => {
        if (runtime === rt && generation === bootGeneration) onCommand({ type: "consoleResult", success: false, output: String(error) });
      });
      return;
    }
    case "inspect":
      applyInspectControl(ensureRuntime(), msg, onCommand);
      return;
    case "sceneLayerScroll":
      ensureRuntime().applySceneLayerScroll(msg.layerId, msg.actorId, msg.componentId, msg.deltaX, msg.deltaY);
      break;
    case "sceneLayerPointer":
      ensureRuntime().applySceneLayerPointer(msg);
      return;
    case "sceneLayerControl":
      ensureRuntime().applySceneLayerControl(msg);
      return;
    case "sceneLayerFocusNavigate":
      ensureRuntime().applySceneLayerFocusNavigate(msg.reverse);
      return;
    case "sceneLayerResize":
      ensureRuntime().applySceneLayerResize(
        msg.frustumWidth,
        msg.frustumHeight,
        msg.canvasWidth,
        msg.canvasHeight,
        msg.safeAreaInsets,
      );
      return;
    case "audioVoiceEnded":
      ensureRuntime().applyAudioVoiceEnded(msg);
      return;
    case "scalabilityStatus":
      ensureRuntime().applyScalabilityStatus(msg.acknowledgement);
      return;
    case "renderPathStatus":
      ensureRuntime().applyRenderPathStatus(msg);
      return;
    case "ragdollPoseCaptured":
      runtime?.applyRagdollPoseCaptured(msg);
      return;
    case "sceneLoadingPainted":
      runtime?.notifySceneLoadingPainted(msg.sceneAssetGuid, msg.sceneLoadId);
      return;
    case "sceneModelsReady":
      runtime?.notifySceneModelsReady(msg.sceneAssetGuid, msg.sceneLoadId);
      return;
    case "sceneStreamReady":
      runtime?.notifySceneStreamReady(msg.actorGuid, msg.streamLoadId);
      return;
    case "assetPreloadResult":
      runtime?.notifyAssetPreloadResult(msg);
      return;
    case "assetLoadStates":
      runtime?.setAssetLoadStates(msg.states);
      return;
    case "sceneStreamProgress":
      runtime?.notifySceneStreamProgress(msg.actorGuid, msg.streamLoadId, msg.progress);
      return;
    case "sceneStreamFailed":
      runtime?.notifySceneStreamFailed(msg.actorGuid, msg.streamLoadId, msg.message);
      return;
    case "sceneLayerLoadingPainted":
      runtime?.notifySceneLayerLoadingPainted(msg.layerId, msg.layerLoadId);
      return;
    case "sceneLayerReady":
      runtime?.notifySceneLayerReady(msg.layerId, msg.layerLoadId);
      return;
  }
}

function publishSnapshot(): boolean {
  const rt = runtime;
  if (!rt) return false;
  if (unpostedLayout) installSnapshotLayout(unpostedLayout);
  if (unpostedLayout || pendingGeneration !== null) return false;
  if (inFlightSnapshots >= MAX_IN_FLIGHT_SNAPSHOTS) {
    snapshotSkipped = true;
    return false;
  }
  const buf = snapshotPing.beginWrite();
  if (!rt.copySnapshot(buf)) {
    snapshotPing.cancelWrite();
    return false;
  }
  const ab = snapshotPing.commitWrite();
  inFlightSnapshots++;
  snapshotSkipped = false;
  post({ channel: "snapshot", payload: ab, generation: installedGeneration }, [ab]);
  releaseAfterPose();
  return true;
}

function pump(elapsed: number): void {
  const rt = runtime;
  if (!rt) return;
  try {
    rt.advance(elapsed);
    if (!sceneSnapshots.flush()) publishSnapshot();
  } finally {
    flushCommands();
  }
}

const scheduler = createWorkerScheduler(self, pump);

function handleHostMessage(msg: BridgeHostMessage): void {
  if (msg.channel === "control") {
    handleControl(msg.payload);
    return;
  }
  if (msg.channel === "input") {
    // Do not ensureRuntime() here: a pre-load dummy World would eat the
    // first stick samples and then be thrown away on `load`.
    runtime?.pushInputBuffer(msg.payload as ArrayBuffer);
    return;
  }
  if (msg.channel === "recycleSnapshot") {
    // Every posted buffer comes back once, stale layout generations included.
    inFlightSnapshots = Math.max(0, inFlightSnapshots - 1);
    snapshotPing.recycle(msg.payload);
    if (!sceneSnapshots.flush() && snapshotSkipped) publishSnapshot();
    return;
  }
  if (msg.channel === "snapshotLayoutAck" && msg.generation === pendingGeneration) {
    installedGeneration = msg.generation;
    pendingGeneration = null;
    sceneSnapshots.flush();
  }
}

self.onmessage = (event: MessageEvent<BridgeHostMessage>) => {
  try {
    handleHostMessage(event.data);
  } finally {
    flushCommands();
  }
};

self.addEventListener("error", (event) => {
  try {
    ensureRuntime().reportError(event.error ?? event.message);
  } finally {
    flushCommands();
  }
});

self.addEventListener("unhandledrejection", (event) => {
  try {
    ensureRuntime().reportError(event.reason);
  } finally {
    flushCommands();
  }
});
