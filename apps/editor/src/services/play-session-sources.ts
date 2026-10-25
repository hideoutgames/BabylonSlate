import {
  createSceneSourceHost,
  applyRuntimeSourceControl,
  type AcquireRuntimeScene,
  type RuntimeDriver,
} from "@haptic/runtime";
import type { SerializedScene } from "@haptic/core";
import type { EngineHandle } from "@haptic/render";
import type { CommandMessage, ControlMessage } from "@haptic/bridge";
import type { GameWorkerHost } from "./game-worker-host";
import type {
  PlaySceneSourceLoader,
  PlaySessionOptions,
  PlaySourcePreparation,
} from "./play-session-types";

/** What a Play session's source tracker reads from the session. */
export interface PlaySourceTrackerContext {
  /** The session's own copy, never a snapshot: releasing the initial sources deletes keys from it. */
  options: PlaySessionOptions;
  handle: EngineHandle;
  worker(): GameWorkerHost | null;
  runtime(): RuntimeDriver | null;
  stopped(): boolean;
  /** The session's boot `load` control; read only when the initial sources are released, after boot. */
  loadControl(): Extract<ControlMessage, { type: "load" }>;
}

/**
 * A Play session's render-side sources: the session, Scene, preload and
 * command source scopes it holds, and the asset load states it publishes to
 * the runtime as they load, become ready, fail or are released.
 */
export interface PlaySourceTracker {
  sessionSourcesReady: Promise<void>;
  /** Prepares a Scene's sources when the session has a Scene source loader. */
  acquireScene: AcquireRuntimeScene | undefined;
  preparedScenes: ReadonlyMap<string, SerializedScene>;
  preparedSceneReverbs: ReadonlyMap<string, Uint8Array>;
  prepareSources(
    prepared: PlaySourcePreparation, signal: AbortSignal, prepare?: boolean,
    priority?: import("@haptic/core").RuntimeAssetSchedulerPriority, warm?: boolean,
  ): Promise<() => void>;
  publishAssetStates(guids: readonly string[], fallback: import("@haptic/core").RuntimeAssetLoadState, queryCache?: boolean): void;
  /** An audio asset finished loading. */
  audioAssetReady(guid: string): void;
  /** A Scene finished loading, so it and the initial sources are ready. */
  sceneReady(sceneAssetGuid: string): void;
  streamReady(actorGuid: string, streamLoadId: number): void;
  streamFailed(actorGuid: string, streamLoadId: number): void;
  /** Handles a runtime command about sources; true when it was one. */
  receive(command: CommandMessage): boolean;
  releaseInitialSources(): void;
  releaseSessionSources(): void;
  /** Rejects pending source requests and drops every preload and prepared Scene when the session stops. */
  dispose(): void;
}

export function createPlaySourceTracker(ctx: PlaySourceTrackerContext): PlaySourceTracker {
  const { options, handle } = ctx;
  let releaseSessionSources: (() => void) | undefined;
  const sessionSourcesReady = options.sessionSources ? handle.acquireSceneSources(options.sessionSources).then((release) => {
    if (ctx.stopped()) release(); else releaseSessionSources = release;
  }) : Promise.resolve();
  void sessionSourcesReady.catch((error: unknown) => options.onLog?.(`Session sources: ${String(error)}`, "error"));
  const preparedScenes = new Map((options.scenes ?? []).map((entry) => [entry.guid, entry.scene]));
  // Baked reverb follows its prepared Scene, so every later activation finds it.
  const preparedSceneReverbs = new Map(options.audioReverbByScene ?? []);
  const sceneSourceOwners = new Map<string, number>();
  let nextSourceRequestId = 0;
  const sourceRequests = new Map<number, { resolve(): void; reject(error: Error): void }>();
  const publishSourceControl = async (control: ControlMessage) => {
    const worker = ctx.worker();
    const runtime = ctx.runtime();
    if (worker && control.type === "loadScripts") {
      const requestId = ++nextSourceRequestId;
      await new Promise<void>((resolve, reject) => {
        sourceRequests.set(requestId, { resolve, reject });
        worker!.postControl({ ...control, requestId });
      });
    } else if (worker) worker.postControl(control);
    else if (runtime && !await applyRuntimeSourceControl(runtime, control))
      throw new Error(`Unsupported source preparation control: ${control.type}.`);
  };
  // Runtime fallback for a Complex Collision Model the content scan missed. The
  // answer is always asynchronous, so it never re-enters the requesting tick.
  const answerComplexCollision = (assetGuid: string) => {
    void Promise.resolve()
      .then(() => options.cookComplexCollision?.(assetGuid) ?? null)
      .catch((error: unknown) => {
        options.onLog?.(`Complex Collision for ${assetGuid}: ${error instanceof Error ? error.message : String(error)}`, "warning");
        return null;
      })
      .then((mesh) => ctx.stopped() ? undefined : publishSourceControl(mesh
        ? { type: "loadComplexCollision", meshes: [{ guid: assetGuid, positions: mesh.positions, indices: mesh.indices }] }
        : { type: "loadComplexCollision", meshes: [], unavailable: [assetGuid] }))
      .catch((error: unknown) => options.onLog?.(`Complex Collision for ${assetGuid}: ${String(error)}`, "error"));
  };
  const knownAssetGuids = new Set<string>();
  const preparedAssetGuids = new Set<string>();
  const initialSourceGuids = new Set(options.getSourceControls?.().flatMap((control) => control.type === "loadSceneContent" ? control.assetGuids : []) ?? []);
  let initialSourcesReady = false;
  const publishedAssetStates = new Map<string, import("@haptic/core").RuntimeAssetLoadState>();
  const preparedSourceScopes = new Map<PlaySourcePreparation, { guids: string[]; ready: boolean }>();
  const sceneSourceScopes = new Map<string, Set<PlaySourcePreparation>>();
  const streamSceneAssets = new Map<string, { guid: string; loadId: number; prepared?: PlaySourcePreparation }>();
  const publishAssetStates = (guids: readonly string[], fallback: import("@haptic/core").RuntimeAssetLoadState, queryCache = false) => {
    const states = guids.map((guid) => {
      knownAssetGuids.add(guid);
      if (!queryCache && fallback === "ready") preparedAssetGuids.add(guid);
      const cached = queryCache ? options.getAssetLoadState?.(guid) : undefined;
      let state = cached === "ready" && !preparedAssetGuids.has(guid) ? "unloaded" as const : cached ?? fallback;
      if (state === "unloaded" && publishedAssetStates.get(guid) === "failed") state = "failed";
      publishedAssetStates.set(guid, state);
      return { guid, state };
    });
    const worker = ctx.worker();
    if (worker) worker.postControl({ type: "assetLoadStates", states });
    else ctx.runtime()?.setAssetLoadStates(states);
  };
  const markSourceReady = (prepared: PlaySourcePreparation) => {
    const scope = preparedSourceScopes.get(prepared);
    if (!scope) return;
    scope.ready = true;
    publishAssetStates(scope.guids, "ready");
  };
  let sourceControlWork: Promise<void> = Promise.resolve();
  const publishSourceBatch = (getControls: () => readonly ControlMessage[] | void): Promise<void> => {
    const work = sourceControlWork.catch(() => {}).then(async () => {
      if (ctx.stopped()) return;
      for (const control of options.getSourceControls?.() ?? getControls() ?? []) {
        await publishSourceControl(control);
      }
    });
    sourceControlWork = work;
    return work;
  };
  const publishReleasedSources = (controls: readonly ControlMessage[] | void | (() => readonly ControlMessage[] | void)) => {
    if (ctx.stopped()) return;
    void publishSourceBatch(typeof controls === "function" ? controls : () => controls).catch((error: unknown) => {
      options.onLog?.(`Source release: ${error instanceof Error ? error.message : String(error)}`, "error");
    });
    if (options.getAssetLoadState) publishAssetStates([...knownAssetGuids], "unloaded", true);
  };
  const prepareSources = async (
    prepared: PlaySourcePreparation, signal: AbortSignal, prepare = false,
    priority: import("@haptic/core").RuntimeAssetSchedulerPriority = "gameplay", warm = false,
  ) => {
    let releaseRender: (() => void) | undefined;
    const scope = { guids: [...(prepared.required ?? [])], ready: false };
    preparedSourceScopes.set(prepared, scope);
    publishAssetStates(scope.guids, "loading");
    const releaseState = () => {
      preparedSourceScopes.delete(prepared);
      const remaining = new Set([...preparedSourceScopes.values()].filter((owner) => owner.ready).flatMap((owner) => owner.guids));
      if (initialSourcesReady) for (const guid of initialSourceGuids) remaining.add(guid);
      for (const guid of scope.guids) if (!remaining.has(guid)) preparedAssetGuids.delete(guid);
      publishAssetStates(scope.guids.filter((guid) => !remaining.has(guid)), "unloaded");
    };
    try {
      signal.throwIfAborted();
      releaseRender = await handle.acquireSceneSources(prepared.sources, { prepare, warm, signal, priority });
      signal.throwIfAborted();
      await publishSourceBatch(() => prepared.getControls?.() ?? prepared.controls);
      signal.throwIfAborted();
      if (prepare) markSourceReady(prepared);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseRender?.();
        releaseRender = undefined;
        prepared.release();
        releaseState();
        publishReleasedSources(prepared.controlsAfterRelease);
      };
    } catch (error) {
      releaseRender?.();
      prepared.release();
      publishAssetStates(scope.guids, signal.aborted ? "unloaded" : "failed");
      releaseState();
      publishReleasedSources(prepared.controlsAfterRelease);
      throw error;
    }
  };
  const acquireScene: AcquireRuntimeScene | undefined = options.acquireSceneSources ? async (guid, request) => {
    publishAssetStates([guid], "loading");
    if (request.stream) streamSceneAssets.set(request.stream.actorGuid, { guid, loadId: request.stream.streamLoadId });
    let prepared: Awaited<ReturnType<PlaySceneSourceLoader>>;
    let release: () => void;
    try {
      prepared = await options.acquireSceneSources!(guid, request);
      release = await prepareSources(prepared, request.signal, true);
    } catch (error) {
      publishAssetStates([guid], request.signal.aborted ? "unloaded" : "failed");
      throw error;
    }
    preparedScenes.set(guid, prepared.scene);
    if (prepared.audioReverb) preparedSceneReverbs.set(guid, prepared.audioReverb);
    else preparedSceneReverbs.delete(guid);
    let sceneScopes = sceneSourceScopes.get(guid);
    if (!sceneScopes) sceneSourceScopes.set(guid, sceneScopes = new Set());
    sceneScopes.add(prepared);
    if (request.stream) streamSceneAssets.set(request.stream.actorGuid, { guid, loadId: request.stream.streamLoadId, prepared });
    sceneSourceOwners.set(guid, (sceneSourceOwners.get(guid) ?? 0) + 1);
    let released = false;
    return { scene: prepared.scene, release: () => {
      if (released) return;
      released = true;
      sceneSourceScopes.get(guid)?.delete(prepared);
      if (!sceneSourceScopes.get(guid)?.size) sceneSourceScopes.delete(guid);
      const remaining = (sceneSourceOwners.get(guid) ?? 1) - 1;
      if (remaining) sceneSourceOwners.set(guid, remaining);
      else {
        sceneSourceOwners.delete(guid); preparedScenes.delete(guid); preparedSceneReverbs.delete(guid);
        preparedAssetGuids.delete(guid); publishAssetStates([guid], "unloaded");
      }
      release();
    } };
  } : undefined;
  handle.setCommandSourceLoader?.(options.acquireAssetSources ? async (guids, request) =>
    prepareSources(await options.acquireAssetSources!([...guids], request), request.signal, true) : null);
  const sceneSources = acquireScene ? createSceneSourceHost({ acquireScene,
    send: (control) => ctx.worker()?.postControl(control),
  }) : undefined;
  const preloads = new Map<string, { controller: AbortController; release?: () => void; guids: string[] }>();
  const publishPreloadResult = (result: { preloadId: string; success: boolean; error?: string; progress?: number }) => {
    const worker = ctx.worker();
    if (worker) worker.postControl({ type: "assetPreloadResult", ...result });
    else ctx.runtime()?.notifyAssetPreloadResult(result);
  };
  const releasePreload = (preloadId: string) => {
    const request = preloads.get(preloadId);
    if (!request) return;
    preloads.delete(preloadId);
    request.controller.abort(new Error("Asset preload was released."));
    request.release?.();
    if (options.getAssetLoadState) publishAssetStates(request.guids, "unloaded", true);
  };
  const receivePreload = (command: CommandMessage) => {
    if (command.type === "assetPreloadRelease") { releasePreload(command.preloadId); return true; }
    if (command.type !== "assetPreload") return false;
    const { preloadId, assetGuids, ownerId, priority } = command;
    if (preloads.has(preloadId)) return true;
    if (!options.acquireAssetSources) {
      publishPreloadResult({ preloadId, success: false, error: "This Play session has no asset source loader." });
      return true;
    }
    const request: { controller: AbortController; release?: () => void; guids: string[] } = {
      controller: new AbortController(), guids: assetGuids,
    };
    preloads.set(preloadId, request);
    publishAssetStates(assetGuids, "loading");
    void options.acquireAssetSources(assetGuids, { consumer: ownerId, signal: request.controller.signal, priority,
      onProgress: (progress) => {
        if (preloads.get(preloadId) === request) publishPreloadResult({ preloadId, success: true, progress: Math.min(0.9, progress * 0.9) });
      },
    // A preload is a latent spawn's (Spawn Actor, a Class load): it resolves with the actor's variants compiled.
    }).then((prepared) => prepareSources(prepared, request.controller.signal, true, priority, true)).then((release) => {
      if (preloads.get(preloadId) !== request) { release(); return; }
      request.release = release;
      publishAssetStates(assetGuids, "ready");
      publishPreloadResult({ preloadId, success: true, progress: 1 });
    }).catch((error: unknown) => {
      if (preloads.get(preloadId) !== request) return;
      releasePreload(preloadId);
      publishAssetStates(assetGuids, "failed");
      publishPreloadResult({ preloadId, success: false, error: `Assets requested by ${ownerId}: ${error instanceof Error ? error.message : String(error)}` });
    });
    return true;
  };
  let initialSourcesReleased = false;
  const releaseInitialSources = () => {
    if (initialSourcesReleased) return;
    initialSourcesReleased = true;
    handle.releaseInitialSources();
    publishReleasedSources(options.releaseInitialSources?.());
    const scoped = new Set([...preparedSourceScopes.values()].flatMap((scope) => scope.guids));
    const persistent = options.getSourceControls?.().flatMap((control) => control.type === "loadSceneContent" ? control.assetGuids : []) ?? [];
    for (const guid of initialSourceGuids) if (!scoped.has(guid)) preparedAssetGuids.delete(guid);
    initialSourceGuids.clear();
    for (const guid of persistent) if (!scoped.has(guid)) initialSourceGuids.add(guid);
    if (initialSourcesReady) publishAssetStates([...initialSourceGuids], "ready");
    for (const guid of preparedScenes.keys()) if (!sceneSourceOwners.has(guid)) preparedScenes.delete(guid);
    for (const guid of preparedSceneReverbs.keys()) if (!sceneSourceOwners.has(guid)) preparedSceneReverbs.delete(guid);
    for (const key of ["textureBytes", "modelBytes", "modelPayloads", "complexMeshes", "spritePayloads", "spriteAnimationPayloads",
      "tilemapPayloads", "tilesetPayloads", "waterPayloads", "fontFacetypeBytes", "fontMsdfJson", "fontMsdfPng",
      "fontCssStackByGuid", "fontFaceEntries", "materialDocuments", "materialFunctions", "audioLibrary", "particleLibrary",
      "renderTargets", "renderTargetTextures", "areaEmissions", "texturePixelSizes", "modelClipAnimationGuids",
      "retargetAnimationLoads", "animGraphs", "behaviourTrees", "blackboards", "dataAssets", "sceneNavmeshBytes",
      "audioReverbByScene", "navmeshBytes", "audioReverbBytes", "scenes", "scene", "sceneLayers"] as const) delete options[key];
    const loadControl = ctx.loadControl();
    loadControl.scene = undefined;
    loadControl.scenes = undefined;
    loadControl.sceneLayers = undefined;
  };
  const audioAssetReady = (guid: string) => {
    for (const [prepared, scope] of preparedSourceScopes) if (scope.guids.includes(guid)) markSourceReady(prepared);
    publishAssetStates([guid], "ready");
  };
  const sceneReady = (sceneAssetGuid: string) => {
    if (!initialSourcesReleased) { initialSourcesReady = true; publishAssetStates([...initialSourceGuids], "ready"); }
    for (const prepared of sceneSourceScopes.get(sceneAssetGuid) ?? []) markSourceReady(prepared);
    publishAssetStates([sceneAssetGuid], "ready");
  };
  const streamReady = (actorGuid: string, streamLoadId: number) => {
    const source = streamSceneAssets.get(actorGuid);
    if (source?.loadId === streamLoadId) {
      if (source.prepared) markSourceReady(source.prepared);
      publishAssetStates([source.guid], "ready");
    }
  };
  const streamFailed = (actorGuid: string, streamLoadId: number) => {
    const source = streamSceneAssets.get(actorGuid);
    if (source?.loadId === streamLoadId) publishAssetStates([source.guid], "failed");
  };
  const receive = (command: CommandMessage) => {
    if (command.type === "assetSourcesReady") {
      const request = sourceRequests.get(command.requestId);
      sourceRequests.delete(command.requestId);
      if (command.success) request?.resolve();
      else request?.reject(new Error(command.error ?? "Script sources failed to prepare."));
      return true;
    }
    if (command.type === "requestComplexCollision") { answerComplexCollision(command.assetGuid); return true; }
    if (receivePreload(command)) return true;
    return sceneSources?.receive(command) ?? false;
  };
  const dispose = () => {
    for (const request of sourceRequests.values()) request.reject(new Error("Play stopped during script preparation."));
    sourceRequests.clear();
    sceneSources?.dispose();
    for (const preloadId of preloads.keys()) releasePreload(preloadId);
    preparedScenes.clear();
    preparedSceneReverbs.clear();
    sceneSourceOwners.clear();
    streamSceneAssets.clear();
    sceneSourceScopes.clear();
    preparedSourceScopes.clear();
  };
  return {
    sessionSourcesReady,
    acquireScene,
    preparedScenes,
    preparedSceneReverbs,
    prepareSources,
    publishAssetStates,
    audioAssetReady,
    sceneReady,
    streamReady,
    streamFailed,
    receive,
    releaseInitialSources,
    releaseSessionSources: () => {
      releaseSessionSources?.();
      releaseSessionSources = undefined;
    },
    dispose,
  };
}
