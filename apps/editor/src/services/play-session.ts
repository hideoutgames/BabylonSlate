import { createSaveStorageServer, createSessionSaveStorage } from "@haptic/core";
import { createSaveGameStorage } from "@haptic/vfs";
import type { ScalabilityAcknowledgement, RenderProjectSettings } from "@haptic/core";
import { buildMaterialParameterCatalog } from "@haptic/shader-graph";
import {
  parseAnimGraphDocument,
  resolveAnimGraphClips,
  type AnimClipCatalogEntry,
} from "@haptic/anim-graph";
import {
  parseBehaviourTreeDocument,
  parseBlackboardDocument,
} from "@haptic/behaviour-tree";
import {
  createPlayBootCoordinator,
  createPlayPauseGate,
  createRuntimeFromLoad,
  createSceneSourceHost,
  applyRuntimeSourceControl,
  type AcquireRuntimeScene,
  captureConsoleLogs,
  SessionDiagnosticAggregator,
  type RuntimeDiagnostic,
  type RuntimeDriver,
  type SessionReportEntry,
} from "@haptic/runtime";
import type { DebugInspectSnapshot } from "@haptic/object-model";
import { materialParameterTextureAssetGuids } from "@haptic/assets";
import {
  DEFAULT_PLAY_FRAME_CAP,
  printHudCssColor,
  type AudioProjectSettings,
  type ResolvedRenderingPipeline,
  type SerializedScene,
  type SerializedSceneLayer,
} from "@haptic/core";
import type {
  SpriteAnimationPayload,
  SpritePayload,
  TilemapPayload,
  TilesetPayload,
  ModelPayload,
  RetargetAnimationLoad,
} from "@haptic/assets";
import type {
  MaterialDocument,
  MaterialFunctionDocument,
} from "@haptic/shader-graph";
import {
  playLoadModelsControl,
  playLoadSpritesControl,
  playLoadTilemapsControl,
  playSceneByGuid,
} from "../lib/play-content";
import {
  createEngine,
  createSceneLoadReadiness,
  createSceneStreamingReadiness,
  describeEngineTexture,
  internalTexturesHeldByScene,
  waitForSceneLoadingPaint,
  type SceneLoadProgress,
  navDebugBlockersFromActors,
  type AudioLibrary,
  type EngineHandle,
  type ParticleLibrary,
  type PlayActorPosition,
  type SceneSourceAssets,
} from "@haptic/render";
import { spawnableLightsFromScripts, type SpawnableLight } from "@haptic/render/spawnable-lights";
import { encodeInputEvents } from "@haptic/input";
import {
  isPlayEngineCommandType,
  snapshotFloatCount,
  snapshotTickIndex,
  type CommandMessage,
  type ControlMessage,
  type DebugObserveTarget,
  type ScriptBundleEntry,
  type SessionPauseCause,
  type Breakpoint,
} from "@haptic/bridge";
import { attachInputCapture, type InputCaptureHandle } from "./input-capture";
import { createSessionBoundaryClient } from "./session-boundary-client";
import { RuntimeInspectorClient, type RuntimeInspectionAction, type RuntimeInspectionWriteOptions } from "./runtime-inspector-client";
import { RuntimeMaterialEditHost } from "./runtime-material-edit-host";
import { SimulationCaptureClient } from "./simulation-capture-client";
import { getBuildIdentity } from "../lib/build-identity";
import { observedMoveXFromEvents } from "../lib/play-input-observe";
import { createGameWorkerHost, type GameWorkerHost } from "./game-worker-host";
import { playLoadControl, type PlayPhysicsSettings } from "./play-physics";
import {
  editorDracoPublicBase,
  editorKtx2PublicBase,
  editorMeshoptPublicBase,
  editorThirdPartyNoticesUrl,
} from "../lib/public-engine-assets";
import {
  INFINITE_LOOP_DIAGNOSTIC_CODE,
  SessionDiagnostics,
  createDiagnosticOperationClient,
  createMessageRateMeter,
  observeBrowserLongTasks,
  type PerformanceProfile,
  type TracePayload,
} from "@haptic/debugger";

/**
 * Extract a `RuntimeDiagnostic` from a worker `diagnostic` command so it can
 * feed the same `SessionDiagnosticAggregator` the in-process driver uses.
 * The dedicated Worker path never runs `RuntimeDriver.reportError` on the
 * main thread, so without this the Preview session report would stay empty
 * for real script errors that occur while Play uses the Worker transport.
 */
export function diagnosticFromCommand(
  command: CommandMessage,
): RuntimeDiagnostic | null {
  if (command.type !== "diagnostic") return null;
  return {
    code: command.code,
    message: command.message,
    severity: command.severity,
    assetGuid: command.assetGuid,
    graphId: command.graphId,
    nodeId: command.nodeId,
    btNodeId: command.btNodeId,
    bodyLine: command.bodyLine,
    stack: command.stack,
    frameId: command.frameId,
  };
}

export function inspectSnapshotFromCommand(
  command: CommandMessage,
): DebugInspectSnapshot | null {
  if (command.type !== "inspectSnapshot") return null;
  return command.snapshot;
}

/** Resolve the next inspect waiter from a worker inspectSnapshot command. */
export function deliverInspectSnapshot(
  waiters: Array<(snapshot: DebugInspectSnapshot) => void>,
  command: CommandMessage,
): boolean {
  const snapshot = inspectSnapshotFromCommand(command);
  if (!snapshot) return false;
  waiters.shift()?.(snapshot);
  return true;
}

export function isFatalPlayDiagnostic(code: string | undefined): boolean {
  return code === INFINITE_LOOP_DIAGNOSTIC_CODE;
}

/** Apply worker sessionPaused onto Play overlay chrome, with the error it paused on, if any. */
export function applyPlaySessionPausedCommand(
  command: CommandMessage,
  onSessionPaused?: (paused: boolean, cause?: SessionPauseCause) => void,
): boolean {
  if (command.type !== "sessionPaused") return false;
  onSessionPaused?.(command.paused, command.cause);
  return true;
}

export function shouldForwardPlayEngineCommand(type: string): boolean {
  return isPlayEngineCommandType(type);
}

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

export function applyPlayHudConsoleCommand(
  command: CommandMessage,
  handlers: {
    onShowFps?: (enabled: boolean) => void;
    onStat?: (name: string, enabled: boolean) => void;
    onFreeCam?: (enabled: boolean) => void;
  },
): boolean {
  if (command.type === "setShowFps") {
    handlers.onShowFps?.(command.enabled);
    return true;
  }
  if (command.type === "setStat") {
    handlers.onShowFps?.(true);
    handlers.onStat?.(command.name, command.enabled);
    return true;
  }
  if (command.type === "setFreeCam") {
    handlers.onFreeCam?.(command.enabled);
    return true;
  }
  return false;
}

export type PlaySessionStepTarget = {
  worker?: { postControl: (message: ControlMessage) => void } | null;
  runtime?: {
    resume(): void;
    tick(): void;
    pause(): void;
  } | null;
};

/** Advance one paused tick: worker `step` control, or in-process resume/tick/pause. */
export function applyPlaySessionStep(target: PlaySessionStepTarget): boolean {
  if (target.worker) {
    target.worker.postControl({ type: "step" });
    return true;
  }
  if (target.runtime) {
    target.runtime.resume();
    // A throwing tick still returns to pause; Step never leaves the game running.
    try {
      target.runtime.tick();
    } finally {
      target.runtime.pause();
    }
    return true;
  }
  return false;
}

export type PlaySessionGraphDebugTarget = {
  worker?: { postControl: (message: ControlMessage) => void } | null;
  runtime?: { applyDebugObserve(target: DebugObserveTarget | null, instanceId: string | null): void } | null;
};

/** Point the runtime's graph debugger at a target and instance: a worker control, or the in-process runtime directly. */
export function applyPlayGraphDebugObserve(
  target: PlaySessionGraphDebugTarget,
  observe: DebugObserveTarget | null,
  instanceId: string | null,
): void {
  if (target.worker) target.worker.postControl({ type: "debugObserve", target: observe, instanceId });
  else target.runtime?.applyDebugObserve(observe, instanceId);
}

/** Replace the session's node breakpoints: a worker control, or the in-process runtime directly. */
export function applyPlayBreakpoints(
  target: {
    worker?: { postControl: (message: ControlMessage) => void } | null;
    runtime?: { applyBreakpoints(breakpoints: readonly Breakpoint[]): void } | null;
  },
  breakpoints: Breakpoint[],
): void {
  if (target.worker) target.worker.postControl({ type: "setBreakpoints", breakpoints });
  else target.runtime?.applyBreakpoints(breakpoints);
}

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

/**
 * Textures created during a session that are still in the shared Engine's
 * cache, compared by identity rather than count. Babylon's 1×1 placeholders
 * are created once per Engine on first use and live as long as it, so they
 * are not a session leak. Nor is a texture a live Scene outside the session
 * still references: an editor preview opened mid-session (a Class graph's
 * viewport) draws on the shared Engine and creates its own default checker and
 * BRDF table, which it releases when it closes. A texture no live Scene
 * references, or that only one of `playScenes` does, stays retained.
 */
export function texturesRetainedAfterPlay(
  engine: Pick<EngineHandle["engine"], "getLoadedTexturesCache" | "scenes">,
  before: ReadonlySet<unknown>,
  playScenes: ReadonlySet<EngineHandle["scene"]>,
): ReturnType<EngineHandle["engine"]["getLoadedTexturesCache"]> {
  const native = engine as unknown as Partial<Record<"_emptyTexture" | "_emptyCubeTexture" | "_emptyTexture3D" | "_emptyTexture2DArray", unknown>>;
  const placeholders = new Set([native._emptyTexture, native._emptyCubeTexture, native._emptyTexture3D, native._emptyTexture2DArray]);
  const created = engine.getLoadedTexturesCache().filter((texture) => !before.has(texture) && !placeholders.has(texture));
  if (created.length === 0) return created;
  const heldByOthers = new Set<unknown>();
  for (const scene of engine.scenes) {
    if (playScenes.has(scene)) continue;
    for (const texture of internalTexturesHeldByScene(scene)) heldByOthers.add(texture);
  }
  return created.filter((texture) => !heldByOthers.has(texture));
}

/** Each retained texture by name, with its size, native references and ResourceCache owner, so a leak report names the owner. */
export function describeRetainedTextures(
  engine: EngineHandle["engine"],
  retained: ReturnType<typeof texturesRetainedAfterPlay>,
): string {
  const shown = retained.slice(0, 8).map((texture) => {
    const description = describeEngineTexture(engine, texture);
    const owner = description.resourceCache
      ? `ResourceCache ${description.resourceCache.assetGuid} (${description.resourceCache.leases} leases)`
      : "not ResourceCache-owned";
    return `${description.name} ${description.size}${description.cube ? " cube" : ""}, ${description.references} reference(s), ${owner}`;
  });
  return retained.length > shown.length ? `${shown.join("; ")}; and ${retained.length - shown.length} more` : shown.join("; ");
}

export interface PlaySessionResult {
  diagnostics: SessionReportEntry[];
  droppedDiagnostics: number;
  textureCountBefore: number;
  /**
   * Settles after the shared-Engine teardown confirms actual release and a
   * stopped worker was terminated, then measures the texture cache.
   * `quarantined` is true when release never confirmed; the promise never
   * rejects.
   */
  released: Promise<{
    textureCountAfter: number;
    /** True when textures created during Play outlived its release. */
    textureLeak: boolean;
    quarantined: boolean;
    /** When `textureLeak`: the retained textures by name, size, references and owner. */
    textureLeakDetail?: string;
  }>;
  /** Which runtime host was used. */
  runtimeMode: "worker" | "in-process";
  liveObjectCounts?: { meshes: number; textures: number };
  /** Finalized recorder payload, if snapshot start ran this session. */
  lastTrace: TracePayload | null;
}

export interface PlaySession {
  canvas: HTMLCanvasElement;
  handle: EngineHandle;
  runtime: RuntimeDriver | null;
  worker: GameWorkerHost | null;
  runtimeMode: "worker" | "in-process";
  diagnostics: SessionDiagnostics<import("@haptic/render").RenderFrameReport>;
  setPaused: (paused: boolean) => void;
  setPauseReason: (reason: import("@haptic/bridge").SessionPauseReason, paused: boolean) => Promise<import("@haptic/bridge").SessionBoundaryResult>;
  setInputMode: (mode: "game" | "edit") => Promise<void>;
  /**
   * Point the graph debugger at the live instances of `target` (null stops) and follow
   * `instanceId`. The runtime answers with `onDebugRoster` and, for the followed instance
   * only, `onExecutionTrace` each tick (and a Behaviour Tree's `onBtState`).
   */
  observeGraphDebug: (target: DebugObserveTarget | null, instanceId: string | null) => void;
  /** Replace the node breakpoints a Simulation stops at (its scripts check them). */
  setBreakpoints: (breakpoints: Breakpoint[]) => void;
  requestPausedRedraw: () => { accepted: boolean; reason?: string };
  /** Last resolved Move.x from the in-process runtime; null on the worker path. */
  lastMoveX: () => number | null;
  /** Latest snapshot actor positions for e2e collision / motion. */
  lastActorPositions: () => readonly PlayActorPosition[];
  /** Latest sim tick (in-process World clock, else last published snapshot). */
  lastTickIndex: () => number;
  /** Session-only Play/Preview fps cap; does not write `project.json`. */
  setFrameCap: (fps: number) => void;
  /** Actor guids spawned this session (authored scene + explicit runtime spawns). */
  spawnedActorGuids: () => readonly string[];
  executeConsoleCommand: (
    line: string,
  ) => Promise<{ success: boolean; output: string }>;
  inspectWorld: () => Promise<DebugInspectSnapshot>;
  /** Correlated typed selection and live edits; continuous drafts are coalesced. */
  requestRuntimeInspection: (action: RuntimeInspectionAction, options?: RuntimeInspectionWriteOptions) => Promise<import("@haptic/bridge").RuntimeInspectorResult>;
  /** Complete final canonical scene, captured before destructive Stop/End Play. */
  captureSimulationScene: (maxBytes?: number) => Promise<import("@haptic/runtime").SimulationSceneCaptureResult>;
  /** Advance one simulation tick while paused. */
  step: () => void;
  /**
   * Simulation's Step: one tick of a session paused only by the user, acknowledged through the
   * session boundary after the tick's commands, so the paused view can redraw the result.
   */
  stepPaused: () => Promise<import("@haptic/bridge").SessionBoundaryResult>;
  lastTrace: () => TracePayload | null;
  accountedBytes: () => number;
  liveObjectCounts: () => { meshes: number; textures: number };
  whenModelsReady: () => Promise<void>;
  modelLoadCount: () => number;
  drawCalls: () => number;
  bridgeMessagesPerSec: () => number;
  stop: () => PlaySessionResult;
}

export type PlaySourcePreparation = {
  sources: SceneSourceAssets;
  controls?: ControlMessage[];
  getControls?: () => ControlMessage[];
  release(): void;
  controlsAfterRelease?: () => ControlMessage[];
  required?: ReadonlySet<string>;
};
export type PlaySceneSourceLoader = (guid: string, options: {
  consumer: string; signal: AbortSignal;
}) => Promise<PlaySourcePreparation & { scene: SerializedScene; /** The Scene's baked reverb field, if any. */ audioReverb: Uint8Array | null }>;
export type PlayAssetSourceLoader = (guids: string[], options: {
  consumer: string; signal: AbortSignal; onProgress?: (progress: number) => void;
  /** Orders this load's source reads against other queued work; default gameplay. */
  priority?: import("@haptic/core").RuntimeAssetSchedulerPriority;
  fontModes?: import("@haptic/render").CommandFontModes;
}) => Promise<PlaySourcePreparation>;

/** Resolve a Play session cap; omitted or non-positive values become 60. */
export function resolvePlayFrameCap(fps?: number): number {
  return typeof fps === "number" && fps > 0 ? fps : DEFAULT_PLAY_FRAME_CAP;
}

/**
 * Tick stamp for Play canvas events. In-process Play uses World.clock;
 * the worker host has no World on the main thread, so it must use the last
 * snapshot `tickIndex` rather than `performance.now() / (1000/60)`.
 */
export function playInputStampTick(
  inProcessTickIndex: number | undefined,
  lastWorkerTickIndex: number,
): number {
  return inProcessTickIndex ?? lastWorkerTickIndex;
}

/** Worker hosts stamp input from snapshot tickIndex so throttled stats cannot drop sticks. */
export function applyPlaySnapshotTick(
  previous: number,
  buffer: Float32Array,
): number {
  return snapshotTickIndex(buffer) ?? previous;
}

/** One Print node message as the HUD and console show it. */
export interface PlayPrintEntry {
  message: string;
  key: string;
  duration: number;
  color: string;
}

/** A worker `print` command as a HUD entry. An empty message is a valid empty line; a non-string is not. */
export function printEntryFromCommand(command: CommandMessage): PlayPrintEntry | null {
  if (command.type !== "print" || typeof command.message !== "string") return null;
  return {
    message: command.message,
    key: command.key ?? "",
    duration: command.duration ?? 2,
    color: printHudCssColor(command.color),
  };
}

export interface PlayHudStats {
  fps: number;
  scriptMs: number;
  physicsMs: number;
  /** Snapshot publish time, reported apart from the tick's script/physics budget. */
  publishMs: number;
  /** The last tick's milliseconds per timed phase (`TICK_TIMING_PHASES`), when the worker reports them. */
  phaseMs?: readonly number[];
  frameId: number;
  /** The worker's tick index, from its latest `stats` command. */
  ticks?: number;
  liveActors?: number;
  snapshotCapacity?: number;
}

/** Worker `stats` commands are the source of truth for script/physics/publish ms. */
export function applyWorkerPlayStats(
  previous: PlayHudStats | undefined,
  command: {
    fps?: number;
    scriptMs: number;
    physicsMs: number;
    publishMs?: number;
    phaseMs?: readonly number[];
    frameId: number;
    ticks?: number;
    liveActors?: number;
    snapshotCapacity?: number;
  },
): PlayHudStats {
  return {
    fps: previous?.fps ?? 0,
    scriptMs: command.scriptMs,
    physicsMs: command.physicsMs,
    publishMs: command.publishMs ?? 0,
    ...(command.phaseMs ? { phaseMs: command.phaseMs } : {}),
    frameId: command.frameId,
    ticks: command.ticks ?? previous?.ticks ?? 0,
    liveActors: command.liveActors ?? previous?.liveActors ?? 0,
    snapshotCapacity:
      command.snapshotCapacity ?? previous?.snapshotCapacity ?? 0,
  };
}

/** Main-thread FPS sample must not zero worker timings. */
export function applyPlayFpsSample(
  previous: PlayHudStats | undefined,
  fps: number,
): PlayHudStats {
  return {
    fps,
    scriptMs: previous?.scriptMs ?? 0,
    physicsMs: previous?.physicsMs ?? 0,
    publishMs: previous?.publishMs ?? 0,
    ...(previous?.phaseMs ? { phaseMs: previous.phaseMs } : {}),
    frameId: previous?.frameId ?? 0,
    ticks: previous?.ticks ?? 0,
    liveActors: previous?.liveActors ?? 0,
    snapshotCapacity: previous?.snapshotCapacity ?? 0,
  };
}

const FIXTURE_ASSET = "preview-fixture";
/** How long a stopped worker may take to run End Play and finish its save writes. */
const WORKER_STOP_TIMEOUT_MS = 3000;
const FIXTURE_NODE = "throw-node";

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

/**
 * Start a fullscreen Play session. Prefers a dedicated game Worker; falls back
 * to in-process runtime. Own Scene on the shared app Engine via registerView.
 */
export function startPlaySession(options: {
  /** Preview uses the packaged player, never this in-process presentation host. */
  mode?: "play" | "simulate";
  sessionGeneration?: number;
  /** Transfer the preparation overlay, including wipe-on-start, to this owner. */
  simulationSaveStorage?: ReturnType<typeof createSessionSaveStorage>;
  /** Authoring asset identities admitted by preparation; this does not load assets. */
  simulationAssetGuids?: readonly string[];
  onRetentionUnavailable?: (reason: string) => void;
  saveGame?: import("@haptic/core").SaveGameConfiguration;
  renderSettings?: import("@haptic/render").RenderShadingSettings;
  consoleRenderSettings?: import("@haptic/render").RenderShadingSettings;
  canvas: HTMLCanvasElement;
  sharedEngine: EngineHandle["engine"];
  injectFixtureThrow?: boolean;
  /** Scene physics world and gravity from the open scene document. */
  physics?: PlayPhysicsSettings;
  /** Compiled project graphs to run for this session. */
  scripts?: readonly ScriptBundleEntry[];
  /** The light parts the startup sources may spawn (`spawnableLightsOfLoad`); defaults to those of `scripts`. */
  spawnableLights?: ReadonlyMap<string, SpawnableLight>;
  /** Authored scene instantiated in the worker instead of demo actors. */
  sceneAssetGuid?: string;
  scene?: SerializedScene;
  project?: { name: string; version: string };
  gameInstanceClass?: string;
  scenes?: Array<{ guid: string; scene: SerializedScene }>;
  sceneCatalog?: Array<{ guid: string; name: string }>;
  classAssetGuids?: Record<string, string>;
  consoleCommands?: Array<import("@haptic/core").ConsoleCommandMetadata & { classId: string; assetGuid: string }>;
  audioAssetGuids?: string[];
  acquireSceneSources?: PlaySceneSourceLoader;
  acquireAssetSources?: PlayAssetSourceLoader;
  releaseInitialSources?: () => void | ControlMessage[];
  sessionSources?: SceneSourceAssets;
  getAssetLoadState?: (guid: string) => import("@haptic/core").RuntimeAssetLoadState;
  getSourceControls?: () => ControlMessage[];
  sceneLayers?: Array<{ guid: string; layer: SerializedSceneLayer }>;
  onStats?: (stats: PlayHudStats) => void;
  onLog?: (message: string, severity: string) => void;
  /** Each log the runtime raises (Log nodes included), with its category; the host's Output Log feed. */
  onRuntimeLog?: (entry: { category: string; severity: string; message: string }) => void;
  onPrint?: (entry: PlayPrintEntry) => void;
  /** Project `playFrameCap`; omitted or invalid → 60. */
  frameCap?: number;
  /** Engine Settings trace retention budget, captured when Play starts. */
  traceByteBudget?: number;
  onProfile?: (profile: PerformanceProfile) => void;
  /** AnimationGraph documents for `loadAnimGraphs` / `registerAnimGraph`. */
  animGraphs?: ReadonlyArray<{ guid: string; document: unknown }>;
  /** BehaviourTree / Blackboard documents for worker load. */
  behaviourTrees?: ReadonlyArray<{ guid: string; document: unknown }>;
  blackboards?: ReadonlyArray<{ guid: string; document: unknown }>;
  /** Sprite payloads keyed by asset guid for Play clip UV seeks. */
  spritePayloads?: ReadonlyMap<string, SpritePayload>;
  /** Sprite Animation clips referenced by loaded Animation Graphs. */
  spriteAnimationPayloads?: ReadonlyMap<string, SpriteAnimationPayload>;
  /** Tilemap / tileset payloads for Play chunk meshes and Rapier chains. */
  renderTargets?: ReadonlyMap<string, import("@haptic/core").RenderTargetPayload>;
  renderTargetTextures?: ReadonlyMap<string, import("@haptic/core").RenderTargetTexturePayload>;
  waterPayloads?: ReadonlyMap<string, import("@haptic/core").WaterDefinition>;
  tilemapPayloads?: ReadonlyMap<string, TilemapPayload>;
  tilesetPayloads?: ReadonlyMap<string, TilesetPayload>;
  textureBytes?: ReadonlyMap<string, Uint8Array>;
  areaEmissions?: ReadonlyMap<string, import("@haptic/assets").AreaEmissionPixels>;
  texturePixelSizes?: ReadonlyMap<string, { width: number; height: number }>;
  fontFacetypeBytes?: ReadonlyMap<string, Uint8Array>;
  fontMsdfJson?: ReadonlyMap<string, Uint8Array>;
  fontMsdfPng?: ReadonlyMap<string, Uint8Array>;
  fontFaceEntries?: readonly import("@haptic/render").FontAssetEntry[];
  fontCssStack?: string;
  fontCssStackByGuid?: ReadonlyMap<string, string>;
  modelBytes?: ReadonlyMap<string, Uint8Array>;
  modelPayloads?: ReadonlyMap<string, ModelPayload>;
  /** Complex Collision meshes cooked during source preparation; Play never re-cooks them. */
  complexMeshes?: ReadonlyMap<string, import("@haptic/core").CollisionTriangleMesh>;
  /** Answers the runtime's `requestComplexCollision` for a Model the content scan missed. */
  cookComplexCollision?: (assetGuid: string) => Promise<import("@haptic/core").CollisionTriangleMesh | null>;
  modelClipAnimationGuids?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  retargetAnimationLoads?: ReadonlyMap<
    string,
    readonly RetargetAnimationLoad[]
  >;
  loadAudioSourceBytes?: import("@haptic/render").AudioSourceBytesLoader;
  audioLibrary?: AudioLibrary;
  /** Animation / Sprite Animation clip metadata for BT Play Animation. */
  animClipCatalog?: readonly AnimClipCatalogEntry[];
  particleLibrary?: ParticleLibrary;
  /** Baked Scene `audioReverb` bytes; Play imports and never generates. */
  audioReverbBytes?: Uint8Array | null;
  audioProjectSettings?: Partial<
    Pick<
      AudioProjectSettings,
      | "occlusionEnabled"
      | "reverbWetScale"
      | "reverbDecayScale"
      | "reverbDampingScale"
    >
  >;
  materialDocuments?: ReadonlyMap<string, MaterialDocument>;
  materialFunctions?: ReadonlyMap<string, MaterialFunctionDocument>;
  /** Reads bake assets (project registry or packed container). */
  postProcessingEnabled?: boolean;
  hardwareScalingLevel?: number;
  pixelsPerUnit?: number;
  /** Project Collision Presets (`PhysicsProjectSettings.collisionPresets`). */
  collisionPresets?: readonly import("@haptic/core").CollisionPreset[];
  sortingLayers?: readonly string[];
  pixelPerfect?: boolean;
  /** Overlay 2DButton pick floor in CSS pixels. */
  touchMinTargetPx?: number;
  /** Baked Scene navmesh bytes; Play imports and never generates. */
  navmeshBytes?: Uint8Array | null;
  sceneNavmeshBytes?: ReadonlyMap<string, Uint8Array>;
  audioReverbByScene?: ReadonlyMap<string, Uint8Array>;
  infiniteLoopDetection?: boolean;
  /** Simulation: pause the first time each node reports an error (Engine Settings, Pause On Errors). */
  pauseOnErrors?: boolean;
  /** Simulation: the enabled node breakpoints when it starts; `setBreakpoints` changes them. */
  breakpoints?: Breakpoint[];
  loopCount?: number;
  inputAssets?: import("@haptic/core").InputAssetDefinition[];
  dataAssets?: import("@haptic/core").DataAssetCatalogEntry[];
  /** Packaged authored assets the Asset Registry nodes query, snapshotted when Play starts. */
  assetCatalog?: import("@haptic/core").RuntimeAssetCatalogEntry[];
  focusNavigation?: import("@haptic/core").FocusNavigationSettings;
  /** Called when a session-fatal diagnostic (infinite loop) arrives. */
  onFatalDiagnostic?: () => void;
  /** Called when the runtime ended its own session (console `quit`); the host stops as for its Stop control. */
  onSessionEnded?: () => void;
  /** When true, pause after Play boot so `boot.play`'s resume cannot undo it. */
  pauseOnPlay?: boolean;
  onSceneLoading?: (state: SceneLoadProgress | null) => void;
  /** A scene load failed; it stays pending until the session stops, and the session reports a fatal diagnostic next. */
  onSceneLoadFailed?: () => void;
  onSessionPaused?: (paused: boolean, cause?: SessionPauseCause) => void;
  onShowFps?: (enabled: boolean) => void;
  onStatHighlight?: (name: string, enabled: boolean) => void;
  onFreeCam?: (enabled: boolean) => void;
  onSetRenderResolution?: (width: number, height: number) => void;
  onRenderOutputChanged?: (settings: RenderProjectSettings) => void;
  onBehaviourTreeDebug?: (enabled: boolean) => void;
  onBehaviourTreeSnapshot?: (
    trees: readonly import("@haptic/bridge").DebugBehaviourTree[],
  ) => void;
  onDebugRoster?: (roster: Extract<CommandMessage, { type: "debugRoster" }>) => void;
  onExecutionTrace?: (trace: Extract<CommandMessage, { type: "executionTrace" }>) => void;
  onDebugVariables?: (report: Extract<CommandMessage, { type: "debugVariables" }>) => void;
  onBtState?: (state: Extract<CommandMessage, { type: "btState" }>) => void;
}): PlaySession {
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
      return prepareSources(prepared, request.signal);
    } : undefined,
    audioLibrary: options.audioLibrary,
    particleLibrary: options.particleLibrary,
    audioReverbBytes: options.audioReverbBytes,
    audioProjectSettings: options.audioProjectSettings,
    materialDocuments: options.materialDocuments,
    materialFunctions: options.materialFunctions,
    // What the startup sources' Classes may spawn (Play's load rehearses a light of each kind), or the session's.
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
        publishAssetStates([diagnostic.assetGuid], "failed");
    },
    onAudioAssetReady: (guid) => {
      for (const [prepared, scope] of preparedSourceScopes) if (scope.guids.includes(guid)) markSourceReady(prepared);
      publishAssetStates([guid], "ready");
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
    onRenderPathChanged: publishRenderPathStatus,
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
  let releaseSessionSources: (() => void) | undefined;
  const sessionSourcesReady = options.sessionSources ? handle.acquireSceneSources(options.sessionSources).then((release) => {
    if (stopped) release(); else releaseSessionSources = release;
  }) : Promise.resolve();
  void sessionSourcesReady.catch((error: unknown) => options.onLog?.(`Session sources: ${String(error)}`, "error"));
  const preparedScenes = new Map((options.scenes ?? []).map((entry) => [entry.guid, entry.scene]));
  // Baked reverb follows its prepared Scene, so every later activation finds it.
  const preparedSceneReverbs = new Map(options.audioReverbByScene ?? []);
  const sceneSourceOwners = new Map<string, number>();
  let nextSourceRequestId = 0;
  const sourceRequests = new Map<number, { resolve(): void; reject(error: Error): void }>();
  const publishSourceControl = async (control: ControlMessage) => {
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
      .then((mesh) => stopped ? undefined : publishSourceControl(mesh
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
    if (worker) worker.postControl({ type: "assetLoadStates", states });
    else runtime?.setAssetLoadStates(states);
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
      if (stopped) return;
      for (const control of options.getSourceControls?.() ?? getControls() ?? []) {
        await publishSourceControl(control);
      }
    });
    sourceControlWork = work;
    return work;
  };
  const publishReleasedSources = (controls: readonly ControlMessage[] | void | (() => readonly ControlMessage[] | void)) => {
    if (stopped) return;
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
    send: (control) => worker?.postControl(control),
  }) : undefined;
  const preloads = new Map<string, { controller: AbortController; release?: () => void; guids: string[] }>();
  const publishPreloadResult = (result: { preloadId: string; success: boolean; error?: string; progress?: number }) => {
    if (worker) worker.postControl({ type: "assetPreloadResult", ...result });
    else runtime?.notifyAssetPreloadResult(result);
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
    loadControl.scene = undefined;
    loadControl.scenes = undefined;
    loadControl.sceneLayers = undefined;
  };
  let hostSceneGuid: string | null = options.sceneAssetGuid ?? null;
  let receivedActiveScene = false;
  const sceneReadiness = createSceneLoadReadiness({
    handle: { ...handle, whenEditorModelsReady: async (owner) => {
      await sessionSourcesReady;
      await handle.whenEditorModelsReady(owner);
    } },
    loading: {
      acquire: () => handle.scheduler.acquireObstruction(),
      progress: (state) => options.onSceneLoading?.(state),
      paint: waitForSceneLoadingPaint,
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
      hostSceneGuid = applyPlayActiveScene({
        handle,
        command: { type: "activeScene", sceneAssetGuid },
        scenes: [...preparedScenes].map(([guid, scene]) => ({ guid, scene })),
        boot: { guid: options.sceneAssetGuid, scene: options.scene },
        currentSceneGuid: hostSceneGuid,
        forceReload: receivedActiveScene,
        audioReverbByScene: preparedSceneReverbs,
      });
      if (receivedActiveScene && options.acquireSceneSources) releaseInitialSources();
      receivedActiveScene = true;
    },
    onReady: ({ sceneAssetGuid, sceneLoadId }) => {
      if (!initialSourcesReleased) { initialSourcesReady = true; publishAssetStates([...initialSourceGuids], "ready"); }
      for (const prepared of sceneSourceScopes.get(sceneAssetGuid) ?? []) markSourceReady(prepared);
      publishAssetStates([sceneAssetGuid], "ready");
      worker?.postControl({ type: "sceneModelsReady", sceneAssetGuid, sceneLoadId });
      runtime?.notifySceneModelsReady(sceneAssetGuid, sceneLoadId);
    },
    onLayerReady: ({ layerId, layerLoadId }) => {
      worker?.postControl({ type: "sceneLayerReady", layerId, layerLoadId });
      runtime?.notifySceneLayerReady(layerId, layerLoadId);
    },
    onFailed: (scene, error) => {
      if (scene.sceneAssetGuid) publishAssetStates([scene.sceneAssetGuid], "failed");
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
      worker?.postControl({ type: "sceneStreamProgress", actorGuid, streamLoadId, progress });
      runtime?.notifySceneStreamProgress(actorGuid, streamLoadId, progress);
    },
    onReady: ({ actorGuid, streamLoadId }) => {
      const source = streamSceneAssets.get(actorGuid);
      if (source?.loadId === streamLoadId) {
        if (source.prepared) markSourceReady(source.prepared);
        publishAssetStates([source.guid], "ready");
      }
      worker?.postControl({ type: "sceneStreamReady", actorGuid, streamLoadId });
      runtime?.notifySceneStreamReady(actorGuid, streamLoadId);
    },
    onFailed: ({ actorGuid, streamLoadId }, error) => {
      const source = streamSceneAssets.get(actorGuid);
      if (source?.loadId === streamLoadId) publishAssetStates([source.guid], "failed");
      const message = error instanceof Error ? error.message : String(error);
      worker?.postControl({ type: "sceneStreamFailed", actorGuid, streamLoadId, message });
      runtime?.notifySceneStreamFailed(actorGuid, streamLoadId, message);
    },
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
      sceneReadiness.receive(command);
      streamReadiness.receive(command);
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
    if (command.type === "assetSourcesReady") {
      const request = sourceRequests.get(command.requestId);
      sourceRequests.delete(command.requestId);
      if (command.success) request?.resolve();
      else request?.reject(new Error(command.error ?? "Script sources failed to prepare."));
      return;
    }
    if (command.type === "requestComplexCollision") { answerComplexCollision(command.assetGuid); return; }
    if (receivePreload(command)) return;
    if (sceneSources?.receive(command)) return;
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
    sceneReadiness.receive(command);
    streamReadiness.receive(command);
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
  if (acquireScene) loadControl.sceneCatalog = options.sceneCatalog ?? [];
  if (options.classAssetGuids) loadControl.classAssetGuids = options.classAssetGuids;
  if (options.consoleCommands) loadControl.consoleCommands = options.consoleCommands;

  try {
    worker = createGameWorkerHost();
    runtimeMode = "worker";
    worker.onCommand((cmd) => onCommand(cmd));
    worker.onSnapshot((buffer) => {
      if (stopped) return;
      lastWorkerTickIndex = applyPlaySnapshotTick(lastWorkerTickIndex, buffer);
      handle.pushSnapshot(buffer);
    });
    for (const control of playSessionBootControls({
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
    })) {
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
      acquireScene ? { acquireScene } : undefined,
    );
    runtime.registerAnchors(FIXTURE_ASSET, [
      {
        line: 1,
        column: 0,
        assetGuid: FIXTURE_ASSET,
        graphId: "event-graph",
        nodeId: FIXTURE_NODE,
      },
    ]);
    const inProcess = runtime;
    const boot = createPlayBootCoordinator();
    resetBoot = () => boot.reset();
    pauseGate = createPlayPauseGate({
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
        if (!stopped) inProcess.reportError(error);
      });
    if (options.pauseOnPlay) {
      pauseGate.setPaused(true);
    }
    options.onLog?.(
      `Play worker unavailable (${err instanceof Error ? err.message : String(err)}); using in-process.`,
      "warning",
    );
  }
  // The subscription fired before the runtime existed; report the current
  // status now that the worker or in-process runtime can store it.
  publishRenderPathStatus(handle.renderPathStatus());
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

  if (options.injectFixtureThrow) {
    queueMicrotask(() => {
      const hint = previewFixtureThrowHint(options.behaviourTrees);
      if (runtime) {
        const err = new Error("Preview fixture throw");
        err.stack = `Error: Preview fixture throw\n    at run (haptic:///${FIXTURE_ASSET}.js:1:1)`;
        runtime.reportError(err, undefined, hint ?? undefined);
      } else if (worker) {
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

  const diagnosticSessionId = `play:${options.sessionGeneration ?? 0}:${performance.now()}`;
  performanceDiagnostics = new SessionDiagnostics({
    mode: options.mode ?? "play",
    identity: () => {
      const build = getBuildIdentity();
      const render = handle.scalabilityStatus()?.effective?.render ?? options.consoleRenderSettings ?? options.renderSettings;
      const frameCap = handle.scheduler.gateState().frameCap;
      return { sessionId: diagnosticSessionId, mode: options.mode ?? "play", sourceSha: build?.sourceSha ?? null,
        buildId: build ? `${build.packageVersion}:${build.runNumber}.${build.runAttempt}` : null,
        sceneId: hostSceneGuid ?? options.sceneAssetGuid ?? "play-scene",
        backend: handle.engine.isWebGPU ? "webgpu" : "webgl2", renderPath: handle.renderPathStatus().effective.renderPath,
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
    whenModelsReady: async () => { await sessionSourcesReady; await handle.whenEditorModelsReady(); },
    modelLoadCount: () => handle.modelLoadCount(),
    drawCalls: () => handle.drawCalls(),
    bridgeMessagesPerSec: () => bridgeRate.perSecond(),
    stop: () => {
      if (stopped && stopResult) return stopResult;
      void performanceDiagnostics?.dispose().finally(() => diagnosticClient.dispose());
      resetBoot();
      pauseGate?.reset();
      sceneReadiness.dispose();
      streamReadiness.dispose();
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
      const liveAfter = handle.liveObjectCounts();
      // The leak check runs once release confirms, when these Scenes are disposed. One that is not still owns what it holds.
      const playScenes = new Set(handle.ownedScenes());
      handle.dispose();
      releaseSessionSources?.();
      releaseSessionSources = undefined;
      releaseInitialSources();
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
