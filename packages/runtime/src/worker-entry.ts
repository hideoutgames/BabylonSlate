import { simulationCaptureChunks } from "./simulation-capture-transport";
import { createSaveStorageClient, normalizeWaterDefinition } from "@babylonslate/core";
/**
 * Game worker entry. Hosts create a Worker from this module URL and post
 * control / input messages. In-process Play uses `createInProcessRuntime`.
 */
import { parseAnimGraphDocument } from "@babylonslate/anim-graph";
import {
  parseBehaviourTreeDocument,
  parseBlackboardDocument,
} from "@babylonslate/behaviour-tree";
import {
  normalizeModelPayload,
  normalizeTilemapPayload,
  normalizeTilesetPayload,
  parseSpriteAnimationPayload,
  type ModelPayload,
  type SpritePayload,
} from "@babylonslate/assets";
import {
  TransferablePingPong,
  dynamicMeshTransferables,
  type BridgeHostMessage,
  type CommandMessage,
  type ControlMessage,
} from "@babylonslate/bridge";
import { createInProcessRuntime, type RuntimeDriver } from "./driver";
import { createRuntimeFromLoad } from "./play-load";
import { createPlayBootCoordinator } from "./play-boot";
import { createPlayPauseGate } from "./play-pause-gate";
import { applyInspectControl } from "./inspect-control";
import { createWorkerScheduler } from "./worker-scheduler";
import { captureConsoleLogs } from "./console-capture";
import { createSceneSnapshotDelivery } from "./scene-snapshot-delivery";
import { createSceneSourceClient } from "./scene-source";

let runtime: RuntimeDriver | null = null;
let sceneSources = createSceneSourceClient(onCommand);
let saveStorage = createSaveStorageClient((request) => onCommand({ type: "saveStorageRequest", request }));
const boot = createPlayBootCoordinator();
let bootGeneration = 0;
let consoleQueue = Promise.resolve();
const sceneSnapshots = createSceneSnapshotDelivery({
  publishSnapshot: () => publishSnapshot(),
  send: (command) => postMessage({ channel: "command", payload: command }),
});
// Recycled via the host's `recycleSnapshot` message so the per-frame
// snapshot transfer never allocates a fresh ArrayBuffer once warmed up.
let snapshotPing = new TransferablePingPong(256);
let installedGeneration = 0;
let pendingGeneration: number | null = null;
let stopConsoleCapture: (() => void) | null = null;

function onCommand(command: CommandMessage): void {
  if (command.type === "performanceTicks") {
    postMessage({ channel: "command", payload: command }, [command.rows.buffer as ArrayBuffer]);
    return;
  }
  if (sceneSnapshots.receive(command)) return;
  const geometryTransfers = dynamicMeshTransferables(command);
  if (geometryTransfers) {
    postMessage({ channel: "command", payload: command }, geometryTransfers);
    return;
  }
  if (command.type === "cableFrame") {
    postMessage({ channel: "command", payload: command }, [command.data.buffer as ArrayBuffer]);
    return;
  }
  if (command.type === "snapshotLayout") {
    try {
      snapshotPing = snapshotPing.grow(command.capacity);
      pendingGeneration = command.generation;
    } catch (error) {
      ensureRuntime().reportError(new Error(`Unable to allocate transferable Actor snapshots (${command.capacity}): ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
  }
  postMessage({ channel: "command", payload: command });
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
      void rt.captureSimulationState(msg).then(async result => {
        if (runtime !== rt || bootGeneration !== generation) return;
        if (!result.ok) { onCommand({ type: "simulationCaptureResult", sessionGeneration: msg.sessionGeneration, requestId: msg.requestId, result }); return; }
        let sequence = 0;
        for (const bytes of simulationCaptureChunks(result.scene)) {
          if (runtime !== rt || bootGeneration !== generation) return;
          const chunk: CommandMessage = { type: "simulationCaptureChunk", sessionGeneration: msg.sessionGeneration, requestId: msg.requestId, sequence: sequence++, bytes };
          postMessage({ channel: "command", payload: chunk }, [bytes.buffer as ArrayBuffer]);
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (runtime === rt && bootGeneration === generation) onCommand({ type: "simulationCaptureResult", sessionGeneration: msg.sessionGeneration, requestId: msg.requestId,
          result: { ok: true, identity: result.identity, byteSize: result.byteSize, chunkCount: sequence } });
      }).catch((error: unknown) => {
        // Report the failure now instead of leaving the host to its capture timeout.
        if (runtime === rt && bootGeneration === generation) refuse(error instanceof Error ? error.message : String(error));
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
        if (runtime === rt && result.success && result.payload?.kind === "mutation") publishSnapshot();
        onCommand({ type: "runtimeInspectorResult", ...result });
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
      const complexMeshes: Record<
        string,
        { vertices: Array<{ x: number; y: number; z: number }>; indices: number[] }
      > = {};
      for (const entry of msg.complexMeshes ?? []) {
        complexMeshes[entry.guid] = {
          vertices: entry.vertices,
          indices: entry.indices,
        };
      }
      rt.registerModelContent({ models, complexMeshes });
      return;
    }
    case "loadNavMesh": {
      const rt = ensureRuntime();
      boot.queueNavMesh(rt, new Uint8Array(msg.bytes));
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
      rt.tick();
      rt.pause();
      return;
    }
    case "stop":
      bootGeneration++;
      boot.reset();
      pauseGate.reset();
      sceneSnapshots.reset();
      scheduler.stop();
      ensureRuntime().stop();
      sceneSources.dispose();
      stopConsoleCapture?.();
      stopConsoleCapture = null;
      return;
    case "setPaused":
      pauseGate.setPaused(msg.paused);
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
  if (!rt || pendingGeneration !== null) return false;
  const buf = snapshotPing.beginWrite();
  if (!rt.copySnapshot(buf)) {
    snapshotPing.cancelWrite();
    return false;
  }
  const ab = snapshotPing.commitWrite();
  postMessage({ channel: "snapshot", payload: ab, generation: installedGeneration }, [ab]);
  return true;
}

function pump(elapsed: number): void {
  const rt = runtime;
  if (!rt) return;
  rt.advance(elapsed);
  if (!sceneSnapshots.flush()) publishSnapshot();
}

const scheduler = createWorkerScheduler(self, pump);

self.onmessage = (event: MessageEvent<BridgeHostMessage>) => {
  const msg = event.data;
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
    snapshotPing.recycle(msg.payload);
    sceneSnapshots.flush();
    return;
  }
  if (msg.channel === "snapshotLayoutAck" && msg.generation === pendingGeneration) {
    installedGeneration = msg.generation;
    pendingGeneration = null;
    sceneSnapshots.flush();
  }
};

self.addEventListener("error", (event) => {
  ensureRuntime().reportError(event.error ?? event.message);
});

self.addEventListener("unhandledrejection", (event) => {
  ensureRuntime().reportError(event.reason);
});
