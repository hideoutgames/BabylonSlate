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
  type BridgeHostMessage,
  type CommandMessage,
  type ControlMessage,
} from "@babylonslate/bridge";
import { createInProcessRuntime, type RuntimeDriver } from "./driver";
import { createRuntimeFromLoad, shouldSpawnScriptedActor } from "./play-load";
import { createPlayBootCoordinator } from "./play-boot";
import { createPlayPauseGate } from "./play-pause-gate";
import { applyInspectControl } from "./inspect-control";

let runtime: RuntimeDriver | null = null;
const boot = createPlayBootCoordinator();
// Recycled via the host's `recycleSnapshot` message so the per-frame
// snapshot transfer never allocates a fresh ArrayBuffer once warmed up.
const snapshotPing = new TransferablePingPong(256);

function onCommand(command: CommandMessage): void {
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
    case "load": {
      if (runtime) {
        runtime.stop();
        runtime = null;
      }
      boot.reset();
      runtime = createRuntimeFromLoad(msg, onCommand);
      return;
    }
    case "loadScripts": {
      const rt = ensureRuntime();
      const spawn =
        msg.spawn ??
        msg.scripts
          .filter((script) => shouldSpawnScriptedActor(script.classId))
          .map((script) => ({ classId: script.classId }));
      boot.queueScripts(rt, msg.scripts, spawn);
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
      void pauseGate.beginPlay(() => boot.play(rt)).then(() => {
        if (lastTick === 0) requestAnimationFrame(pump);
      });
      return;
    }
    case "pause":
      pauseGate.setPaused(true);
      return;
    case "step": {
      const rt = ensureRuntime();
      rt.resume();
      rt.tick();
      rt.pause();
      return;
    }
    case "stop":
      ensureRuntime().stop();
      return;
    case "setPaused":
      pauseGate.setPaused(msg.paused);
      return;
    case "console": {
      const result = ensureRuntime().executeConsoleCommand(msg.line);
      onCommand({
        type: "consoleResult",
        success: result.success,
        output: result.output,
      });
      return;
    }
    case "inspect":
      applyInspectControl(ensureRuntime(), msg, onCommand);
      return;
    case "sceneLayerPointer":
      ensureRuntime().applySceneLayerPointer(msg);
      return;
    case "sceneLayerResize":
      ensureRuntime().applySceneLayerResize(
        msg.frustumWidth,
        msg.frustumHeight,
        msg.canvasWidth,
        msg.canvasHeight,
      );
      return;
    case "audioVoiceEnded":
      ensureRuntime().applyAudioVoiceEnded(msg);
      return;
    case "sceneModelsReady":
      ensureRuntime().notifySceneModelsReady(msg.sceneAssetGuid);
      return;
  }
}

let lastTick = 0;
function pump(): void {
  const rt = runtime;
  if (!rt) return;
  const now = performance.now();
  if (lastTick === 0) lastTick = now;
  const elapsed = (now - lastTick) / 1000;
  lastTick = now;
  rt.advance(elapsed);
  const buf = snapshotPing.beginWrite();
  if (rt.copySnapshot(buf)) {
    const ab = snapshotPing.commitWrite();
    postMessage({ channel: "snapshot", payload: ab, transferable: true }, [
      ab,
    ]);
  } else {
    snapshotPing.cancelWrite();
  }
  requestAnimationFrame(pump);
}

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
  }
};

self.addEventListener("error", (event) => {
  ensureRuntime().reportError(event.error ?? event.message);
});

self.addEventListener("unhandledrejection", (event) => {
  ensureRuntime().reportError(event.reason);
});
