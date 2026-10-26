import type { SerializedScene } from "@haptic/core";
import type { RuntimeDriver, SessionDiagnosticAggregator } from "@haptic/runtime";
import {
  createSceneLoadReadiness,
  createSceneStreamingReadiness,
  waitForSceneLoadingPaint,
  type EngineHandle,
} from "@haptic/render";
import type { CommandMessage } from "@haptic/bridge";
import { playSceneByGuid } from "../lib/play-content";
import type { GameWorkerHost } from "./game-worker-host";
import type { PlaySourceTracker } from "./play-session-sources";
import type { PlaySessionOptions } from "./play-session-types";

export function applyPlayActiveScene(options: {
  handle: {
    loadScene: (
      scene: SerializedScene,
      options?: { sceneAssetGuid?: string },
    ) => void;
    applySceneEnvironment: (scene: SerializedScene) => void;
    resetAudioSession: () => void;
    setAudioReverbField?: (bytes: Uint8Array | null) => void;
    resetParticleSession: () => void;
  };
  command: { type: string; sceneAssetGuid?: string };
  scenes: ReadonlyArray<{ guid: string; scene: SerializedScene }>;
  boot: { guid?: string; scene?: SerializedScene };
  currentSceneGuid: string | null;
  forceReload?: boolean;
  audioReverbByScene?: ReadonlyMap<string, Uint8Array>;
}): string | null {
  if (
    options.command.type !== "activeScene" ||
    typeof options.command.sceneAssetGuid !== "string"
  ) {
    return options.currentSceneGuid;
  }
  const guid = options.command.sceneAssetGuid;
  if (!options.forceReload && guid === options.currentSceneGuid) {
    return options.currentSceneGuid;
  }
  const scene = playSceneByGuid(guid, options.scenes, options.boot);
  if (!scene) throw new Error("The requested scene is not available in this Play session.");
  options.handle.loadScene(scene, { sceneAssetGuid: guid });
  options.handle.applySceneEnvironment(scene);
  options.handle.resetAudioSession();
  options.handle.setAudioReverbField?.(options.audioReverbByScene?.get(guid) ?? null);
  options.handle.resetParticleSession();
  return guid;
}

/** What a Play session's Scene readiness reads from the session. */
export interface PlaySceneReadinessContext {
  handle: EngineHandle;
  /** The session's own copy: activation reads the boot Scene when it runs, after a release may have removed it. */
  options: PlaySessionOptions;
  sources: PlaySourceTracker;
  hostDiagnostics: SessionDiagnosticAggregator;
  worker(): GameWorkerHost | null;
  runtime(): RuntimeDriver | null;
}

/**
 * A Play session's Scene load and Scene streaming readiness: it activates the
 * Scene the runtime makes active, tells the runtime when a Scene, layer or
 * stream has painted, is ready or failed, and keeps the source states in step.
 */
export function createPlaySceneReadiness(ctx: PlaySceneReadinessContext): {
  receive(command: CommandMessage): void;
  dispose(): void;
  /** The Scene the host shows: the last one activated, else the boot Scene. */
  currentSceneGuid(): string | null;
} {
  const { handle, options, sources, hostDiagnostics } = ctx;
  let hostSceneGuid: string | null = options.sceneAssetGuid ?? null;
  let receivedActiveScene = false;
  const sceneReadiness = createSceneLoadReadiness({
    handle: { ...handle, whenEditorModelsReady: async (owner) => {
      await sources.sessionSourcesReady;
      await handle.whenEditorModelsReady(owner);
    } },
    loading: {
      acquire: () => handle.scheduler.acquireObstruction(),
      progress: (state) => options.onSceneLoading?.(state),
      paint: waitForSceneLoadingPaint,
      layerPainted: ({ layerId, layerLoadId }) => {
        ctx.worker()?.postControl({ type: "sceneLayerLoadingPainted", layerId, layerLoadId });
        ctx.runtime()?.notifySceneLayerLoadingPainted(layerId, layerLoadId);
      },
      painted: ({ sceneAssetGuid, sceneLoadId }) => {
        ctx.worker()?.postControl({ type: "sceneLoadingPainted", sceneAssetGuid, sceneLoadId });
        ctx.runtime()?.notifySceneLoadingPainted(sceneAssetGuid, sceneLoadId);
      },
    },
    activate: ({ sceneAssetGuid }) => {
      hostSceneGuid = applyPlayActiveScene({
        handle,
        command: { type: "activeScene", sceneAssetGuid },
        scenes: [...sources.preparedScenes].map(([guid, scene]) => ({ guid, scene })),
        boot: { guid: options.sceneAssetGuid, scene: options.scene },
        currentSceneGuid: hostSceneGuid,
        forceReload: receivedActiveScene,
        audioReverbByScene: sources.preparedSceneReverbs,
      });
      if (receivedActiveScene && options.acquireSceneSources) sources.releaseInitialSources();
      receivedActiveScene = true;
    },
    onReady: ({ sceneAssetGuid, sceneLoadId }) => {
      sources.sceneReady(sceneAssetGuid);
      ctx.worker()?.postControl({ type: "sceneModelsReady", sceneAssetGuid, sceneLoadId });
      ctx.runtime()?.notifySceneModelsReady(sceneAssetGuid, sceneLoadId);
    },
    onLayerReady: ({ layerId, layerLoadId }) => {
      ctx.worker()?.postControl({ type: "sceneLayerReady", layerId, layerLoadId });
      ctx.runtime()?.notifySceneLayerReady(layerId, layerLoadId);
    },
    onFailed: (scene, error) => {
      if (scene.sceneAssetGuid) sources.publishAssetStates([scene.sceneAssetGuid], "failed");
      const message = `Scene loading failed: ${error instanceof Error ? error.message : String(error)}`;
      hostDiagnostics.push({ code: "scene.loading.failed", severity: "error", message,
        assetGuid: scene.sceneAssetGuid, frameId: 0,
        stack: error instanceof Error ? error.stack : undefined });
      try {
        options.onSceneLoadFailed?.();
        options.onLog?.(message, "error");
      } finally { queueMicrotask(() => options.onFatalDiagnostic?.()); }
    },
  });
  const streamReadiness = createSceneStreamingReadiness({
    handle,
    onProgress: ({ actorGuid, streamLoadId }, progress) => {
      ctx.worker()?.postControl({ type: "sceneStreamProgress", actorGuid, streamLoadId, progress });
      ctx.runtime()?.notifySceneStreamProgress(actorGuid, streamLoadId, progress);
    },
    onReady: ({ actorGuid, streamLoadId }) => {
      sources.streamReady(actorGuid, streamLoadId);
      ctx.worker()?.postControl({ type: "sceneStreamReady", actorGuid, streamLoadId });
      ctx.runtime()?.notifySceneStreamReady(actorGuid, streamLoadId);
    },
    onFailed: ({ actorGuid, streamLoadId }, error) => {
      sources.streamFailed(actorGuid, streamLoadId);
      const message = error instanceof Error ? error.message : String(error);
      ctx.worker()?.postControl({ type: "sceneStreamFailed", actorGuid, streamLoadId, message });
      ctx.runtime()?.notifySceneStreamFailed(actorGuid, streamLoadId, message);
    },
  });
  return {
    receive: (command) => {
      sceneReadiness.receive(command);
      streamReadiness.receive(command);
    },
    dispose: () => {
      sceneReadiness.dispose();
      streamReadiness.dispose();
    },
    currentSceneGuid: () => hostSceneGuid,
  };
}
