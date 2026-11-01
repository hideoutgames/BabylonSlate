import type { ControlMessage, ScriptBundleEntry } from "@haptic/bridge";
import { buildMaterialParameterCatalog } from "@haptic/shader-graph";
import { parseAnimGraphDocument, resolveAnimGraphClips } from "@haptic/anim-graph";
import { parseBehaviourTreeDocument, parseBlackboardDocument } from "@haptic/behaviour-tree";
import {
  createPlayBootCoordinator,
  createPlayPauseGate,
  type RuntimeDriver,
  type SessionDiagnosticAggregator,
} from "@haptic/runtime";
import { materialParameterTextureAssetGuids } from "@haptic/assets";
import {
  playLoadModelsControl,
  playLoadSpritesControl,
  playLoadTilemapsControl,
} from "../lib/play-content";
import { editorThirdPartyNoticesUrl } from "../lib/public-engine-assets";
import type { GameWorkerHost } from "./game-worker-host";
import { playLoadControl } from "./play-physics";
import { resolvePlayFrameCap } from "./play-session-helpers";
import type { PlaySessionOptions } from "./play-session-types";

const FIXTURE_ASSET = "preview-fixture";
const FIXTURE_NODE = "throw-node";

export function playSessionBootControls(options: {
  load: Extract<ControlMessage, { type: "load" }>;
  scripts?: readonly ScriptBundleEntry[];
  animGraphs?: ReadonlyArray<{ guid: string; document: unknown }>;
  behaviourTrees?: ReadonlyArray<{ guid: string; document: unknown }>;
  blackboards?: ReadonlyArray<{ guid: string; document: unknown }>;
  waters?: Extract<ControlMessage, { type: "loadWater" }> | null;
  tilemaps?: Extract<ControlMessage, { type: "loadTilemaps" }> | null;
  sprites?: Extract<ControlMessage, { type: "loadSprites" }> | null;
  models?: Extract<ControlMessage, { type: "loadModels" }> | null;
  navmeshBytes?: Uint8Array | null;
  pauseOnPlay?: boolean;
}): ControlMessage[] {
  const controls: ControlMessage[] = [options.load];
  if ((options.scripts?.length ?? 0) > 0) {
    controls.push({
      type: "loadScripts",
      scripts: [...(options.scripts ?? [])],
      spawn: [],
    });
  }
  if ((options.animGraphs?.length ?? 0) > 0) {
    controls.push({
      type: "loadAnimGraphs",
      graphs: [...(options.animGraphs ?? [])],
    });
  }
  if (
    (options.behaviourTrees?.length ?? 0) > 0 ||
    (options.blackboards?.length ?? 0) > 0
  ) {
    controls.push({
      type: "loadBehaviourTrees",
      trees: [...(options.behaviourTrees ?? [])],
      blackboards: [...(options.blackboards ?? [])],
    });
  }
  if (options.waters) controls.push(options.waters);
  if (options.tilemaps) controls.push(options.tilemaps);
  if (options.sprites) controls.push(options.sprites);
  if (options.models) controls.push(options.models);
  const navmesh = options.navmeshBytes;
  if (navmesh && navmesh.byteLength > 0) {
    // `load` already clones every Scene's mesh into the worker, the startup one included; asking the
    // worker to import that entry avoids a second copy. Otherwise send one private buffer, which the
    // host transfers.
    const catalogued = options.load.sceneNavmeshBytes?.[options.load.sceneAssetGuid] === navmesh;
    controls.push(catalogued ? { type: "loadNavMesh" } : {
      type: "loadNavMesh",
      bytes: navmesh.buffer.slice(navmesh.byteOffset, navmesh.byteOffset + navmesh.byteLength) as ArrayBuffer,
    });
  }
  controls.push({ type: "play" });
  if (options.pauseOnPlay) {
    controls.push({ type: "setPaused", paused: true });
  }
  return controls;
}

/** When Play injects a fixture throw and a tree is loaded, navigate to the task. */
export function previewFixtureThrowHint(
  trees?: ReadonlyArray<{ guid: string; document: unknown }>,
): { assetGuid: string; btNodeId: string } | null {
  const entry = trees?.[0];
  if (!entry) return null;
  const parsed = parseBehaviourTreeDocument(entry.document);
  const task = parsed?.nodes.find((node) => node.kind === "task");
  if (!task) return null;
  return { assetGuid: entry.guid, btNodeId: task.id };
}

/** What a session boots with: its `load` control, its scripts and its Animation Graphs with their clips resolved. */
export type PlaySessionLoad = {
  loadControl: Extract<ControlMessage, { type: "load" }>;
  scripts: readonly ScriptBundleEntry[];
  animGraphs: ReadonlyArray<{ guid: string; document: unknown }> | undefined;
};

/** Build the session's boot load; `sceneSourcesAvailable` is whether Scenes load through the session's source loader. */
export function playSessionLoad(options: PlaySessionOptions, sceneSourcesAvailable: boolean): PlaySessionLoad {
  const scripts = options.scripts ?? [];
  const physics = options.physics ?? {
    physicsWorld: "3d" as const,
    gravity: [0, -9.81, 0] as [number, number, number],
  };
  const animClipCatalog = options.animClipCatalog && [...options.animClipCatalog];
  const animGraphs = options.animGraphs?.map((entry) => {
    const document = parseAnimGraphDocument(entry.document);
    return document && animClipCatalog
      ? { ...entry, document: resolveAnimGraphClips(document, animClipCatalog) }
      : entry;
  });
  const loadControl = playLoadControl({
    sessionMode: options.mode ?? "play",
    sessionGeneration: options.sessionGeneration,
    simulationAssetGuids: options.simulationAssetGuids ? [...options.simulationAssetGuids] : undefined,
    saveGame: options.saveGame,
    frameCap: resolvePlayFrameCap(options.frameCap),
    ...(options.garbageCollectionIntervalTicks !== undefined ? { garbageCollectionIntervalTicks: options.garbageCollectionIntervalTicks } : {}),
    traceByteBudget: options.traceByteBudget,
    renderSettings: options.consoleRenderSettings ?? options.renderSettings,
    sceneAssetGuid: options.sceneAssetGuid ?? "play-scene",
    scene: options.scene,
    physicsWorld: physics.physicsWorld,
    gravity: physics.gravity,
    project: options.project,
    thirdPartyNoticesUrl: editorThirdPartyNoticesUrl(),
    gameInstanceClass: options.gameInstanceClass,
    scenes: options.scenes,
    sceneNavmeshBytes: Object.fromEntries(options.sceneNavmeshBytes ?? []),
    sceneLayers: options.sceneLayers,
    infiniteLoopDetection: options.infiniteLoopDetection,
    loopCount: options.loopCount,
    pauseOnErrors: options.pauseOnErrors,
    breakpoints: options.breakpoints,
    inputAssets: options.inputAssets,
    dataAssets: options.dataAssets,
    assetCatalog: options.assetCatalog,
    focusNavigation: options.focusNavigation,
    pixelsPerUnit: options.pixelsPerUnit,
    collisionPresets: options.collisionPresets,
    texturePixelSizes: Object.fromEntries(options.texturePixelSizes ?? []),
    audioAssetGuids: options.audioAssetGuids ?? [...(options.audioLibrary?.audio.keys() ?? [])],
    materialParameterCatalog: buildMaterialParameterCatalog(options.materialDocuments ?? new Map(), options.materialFunctions),
    materialTextureAssetGuids: materialParameterTextureAssetGuids(options.textureBytes, options.renderTargetTextures),
    animClipCatalog,
    renderTargets: Object.fromEntries(options.renderTargets ?? []),
    renderTargetTextures: Object.fromEntries(options.renderTargetTextures ?? []),
  });
  if (sceneSourcesAvailable) loadControl.sceneCatalog = options.sceneCatalog ?? [];
  if (options.classAssetGuids) loadControl.classAssetGuids = options.classAssetGuids;
  if (options.consoleCommands) loadControl.consoleCommands = options.consoleCommands;
  return { loadControl, scripts, animGraphs };
}

/** The controls that boot the session's game Worker, in order. */
export function playSessionWorkerControls(
  options: PlaySessionOptions,
  { loadControl, scripts, animGraphs }: PlaySessionLoad,
): ControlMessage[] {
  return playSessionBootControls({
    load: loadControl,
    scripts,
    animGraphs,
    behaviourTrees: options.behaviourTrees,
    blackboards: options.blackboards,
    waters: { type: "loadWater", waters: [...(options.waterPayloads ?? [])].map(([guid, document]) => ({ guid, document })) },
    tilemaps: playLoadTilemapsControl(
      options.tilemapPayloads,
      options.tilesetPayloads,
      options.pixelsPerUnit,
    ),
    sprites: playLoadSpritesControl(
      options.spritePayloads,
      options.spriteAnimationPayloads,
      options.pixelsPerUnit,
    ),
    models: playLoadModelsControl(options.modelPayloads, options.complexMeshes),
    navmeshBytes: options.navmeshBytes,
    pauseOnPlay: options.pauseOnPlay,
  });
}

/** Register the session's content with the in-process fallback runtime and start its Play boot. */
export function bootInProcessPlay(inProcess: RuntimeDriver, ctx: {
  options: PlaySessionOptions;
  scripts: readonly ScriptBundleEntry[];
  animGraphs: ReadonlyArray<{ guid: string; document: unknown }> | undefined;
  stopped(): boolean;
}): { pauseGate: ReturnType<typeof createPlayPauseGate>; resetBoot: () => void } {
  const { options, scripts, animGraphs } = ctx;
  inProcess.registerAnchors(FIXTURE_ASSET, [
    {
      line: 1,
      column: 0,
      assetGuid: FIXTURE_ASSET,
      graphId: "event-graph",
      nodeId: FIXTURE_NODE,
    },
  ]);
  const boot = createPlayBootCoordinator();
  const resetBoot = () => boot.reset();
  const pauseGate = createPlayPauseGate({
    pause: () => inProcess.pause(),
    resume: () => inProcess.resume(),
  });
  if (scripts.length > 0) {
    boot.queueScripts(inProcess, scripts, []);
  }
  for (const entry of animGraphs ?? []) {
    const document = parseAnimGraphDocument(entry.document);
    if (document) inProcess.registerAnimGraph(entry.guid, document);
  }
  for (const entry of options.behaviourTrees ?? []) {
    const document = parseBehaviourTreeDocument(entry.document);
    if (document) inProcess.registerBehaviourTree(entry.guid, document);
  }
  inProcess.registerWaterContent(options.waterPayloads ?? new Map());
  for (const entry of options.blackboards ?? []) {
    const document = parseBlackboardDocument(entry.document);
    if (document) inProcess.registerBlackboard(entry.guid, document);
  }
  if (
    (options.tilemapPayloads && options.tilemapPayloads.size > 0) ||
    (options.tilesetPayloads && options.tilesetPayloads.size > 0)
  ) {
    inProcess.registerTileContent({
      tilemaps: options.tilemapPayloads ?? new Map(),
      tilesets: options.tilesetPayloads ?? new Map(),
      pixelsPerUnit: options.pixelsPerUnit,
    });
  }
  if (
    (options.spritePayloads && options.spritePayloads.size > 0) ||
    (options.spriteAnimationPayloads &&
      options.spriteAnimationPayloads.size > 0)
  ) {
    inProcess.registerSpriteContent({
      sprites: options.spritePayloads ?? new Map(),
      spriteAnimations: options.spriteAnimationPayloads ?? new Map(),
      pixelsPerUnit: options.pixelsPerUnit,
    });
  }
  if (options.modelPayloads && options.modelPayloads.size > 0) {
    inProcess.registerModelContent({
      models: options.modelPayloads,
      complexMeshes: options.complexMeshes,
    });
  }
  if (options.navmeshBytes && options.navmeshBytes.byteLength > 0) {
    boot.queueNavMesh(inProcess, options.navmeshBytes);
  }
  void pauseGate
    .beginPlay((onStarted) => boot.play(inProcess, onStarted))
    .catch((error: unknown) => {
      if (!ctx.stopped()) inProcess.reportError(error);
    });
  if (options.pauseOnPlay) {
    pauseGate.setPaused(true);
  }
  return { pauseGate, resetBoot };
}

/**
 * Preview's injected fixture throw, a microtask after boot, through whichever
 * runtime host the session has then. `options` is the session's live copy.
 */
export function schedulePreviewFixtureThrow(ctx: {
  options: PlaySessionOptions;
  runtime(): RuntimeDriver | null;
  worker(): GameWorkerHost | null;
  workerDiagnostics: SessionDiagnosticAggregator;
}): void {
  const { options, workerDiagnostics } = ctx;
  if (options.injectFixtureThrow) {
    queueMicrotask(() => {
      const hint = previewFixtureThrowHint(options.behaviourTrees);
      const runtime = ctx.runtime();
      if (runtime) {
        const err = new Error("Preview fixture throw");
        err.stack = `Error: Preview fixture throw\n    at run (haptic:///${FIXTURE_ASSET}.js:1:1)`;
        runtime.reportError(err, undefined, hint ?? undefined);
      } else if (ctx.worker()) {
        // Worker path: route through the same aggregator a real worker
        // `diagnostic` command would use, rather than a report shortcut.
        workerDiagnostics.push({
          code: "runtime.uncaught",
          message: "Preview fixture throw",
          severity: "error",
          assetGuid: hint?.assetGuid ?? FIXTURE_ASSET,
          graphId: hint ? undefined : "event-graph",
          nodeId: hint ? undefined : FIXTURE_NODE,
          btNodeId: hint?.btNodeId,
          frameId: 1,
        });
        options.onLog?.("Preview fixture throw", "error");
      }
    });
  }
}
