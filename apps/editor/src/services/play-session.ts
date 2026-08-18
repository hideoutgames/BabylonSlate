import { parseAnimGraphDocument } from "@babylonslate/anim-graph";
import {
  parseBehaviourTreeDocument,
  parseBlackboardDocument,
} from "@babylonslate/behaviour-tree";
import {
  createPlayBootCoordinator,
  createPlayPauseGate,
  createRuntimeFromLoad,
  SessionDiagnosticAggregator,
  type RuntimeDiagnostic,
  type RuntimeDriver,
  type SessionReportEntry,
} from "@babylonslate/runtime";
import type { DebugInspectSnapshot } from "@babylonslate/object-model";
import { DEFAULT_PLAY_FRAME_CAP, parseInputMode, type AudioProjectSettings, type InputMode, type SerializedScene } from "@babylonslate/core";
import type {
  SpriteAnimationPayload,
  SpritePayload,
  TilemapPayload,
  TilesetPayload,
} from "@babylonslate/assets";
import type {
  MaterialDocument,
  MaterialFunctionDocument,
} from "@babylonslate/shader-graph";
import { playLoadSpritesControl, playLoadTilemapsControl, playSceneByGuid } from "../lib/play-content";
import {
  createEngine,
  type AudioLibrary,
  type EngineHandle,
  type ParticleLibrary,
  type PlayActorPosition,
} from "@babylonslate/render";
import { encodeInputEvents } from "@babylonslate/input";
import {
  snapshotFloatCount,
  snapshotTickIndex,
  type CommandMessage,
  type ControlMessage,
  type ScriptBundleEntry,
  type UiWidgetEventControl,
  type UserInterfaceRuntimeDocument,
} from "@babylonslate/bridge";
import { applyUiRuntimeControl } from "@babylonslate/runtime";
import { spawnListForScripts } from "./script-compiler";
import { attachInputCapture, type InputCaptureHandle } from "./input-capture";
import { observedMoveXFromEvents } from "../lib/play-input-observe";
import { createGameWorkerHost, type GameWorkerHost } from "./game-worker-host";
import {
  playLoadControl,
  type PlayPhysicsSettings,
} from "./play-physics";
import { editorKtx2PublicBase } from "../lib/public-engine-assets";
import {
  INFINITE_LOOP_DIAGNOSTIC_CODE,
  type TracePayload,
} from "@babylonslate/debugger";

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

export type PlayUiCommandHandlers = {
  onUiSetVisible?: (instanceId: string, widgetId: string, visible: boolean) => void;
  onUiApply?: (instanceId: string, classId: string, assetGuid: string) => void;
  onUiRemove?: (instanceId: string) => void;
};

/** Apply worker sessionPaused onto Play overlay chrome. */
export function applyPlaySessionPausedCommand(
  command: CommandMessage,
  onSessionPaused?: (paused: boolean) => void,
): boolean {
  if (command.type !== "sessionPaused") return false;
  onSessionPaused?.(command.paused);
  return true;
}

export const PLAY_ENGINE_APPLY_COMMAND_TYPES = new Set<CommandMessage["type"]>([
  "assignMesh",
  "assignMaterial",
  "possessCamera",
  "setShadowQuality",
  "spawn",
  "playSound",
  "stopSound",
  "setChannelVolume",
  "setGlobalVolume",
  "setFrameCap",
  "setRenderQuality",
  "setResolutionScale",
  "assignParticle",
  "setParticlePlaying",
  "setFreeCam",
  "setWireframe",
  "setShowBounds",
  "setShowCollision",
  "setShowNav",
  "debugColliders",
  "animState",
]);

export function shouldForwardPlayEngineCommand(type: string): boolean {
  return PLAY_ENGINE_APPLY_COMMAND_TYPES.has(type as CommandMessage["type"]);
}

export function applyPlayHudConsoleCommand(
  command: CommandMessage,
  handlers: {
    onShowFps?: (enabled: boolean) => void;
    onStat?: (name: string, enabled: boolean) => void;
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
  return false;
}

/** Apply worker UI commands onto Play HUD callbacks. */
export function applyPlayUiCommand(
  command: CommandMessage,
  handlers: PlayUiCommandHandlers,
): boolean {
  if (command.type === "uiSetVisible") {
    handlers.onUiSetVisible?.(command.instanceId, command.widgetId, command.visible);
    return true;
  }
  if (command.type === "uiApply") {
    handlers.onUiApply?.(command.instanceId, command.classId, command.assetGuid);
    return true;
  }
  if (command.type === "uiRemove") {
    handlers.onUiRemove?.(command.instanceId);
    return true;
  }
  return false;
}

/** Apply worker `setInputMode` onto Play capture and HUD callbacks. */
export function applyPlayInputModeCommand(
  command: CommandMessage,
  onSetInputMode?: (mode: InputMode) => void,
): boolean {
  if (command.type !== "setInputMode") return false;
  onSetInputMode?.(parseInputMode(command.mode));
  return true;
}

export type PlayUiWidgetEventTarget = {
  worker?: { postControl: (message: ControlMessage) => void } | null;
  runtime?: {
    dispatchUiWidgetEvent: (event: UiWidgetEventControl) => void;
  } | null;
};

/** Send a HUD widget event to the worker, or the in-process driver. */
export function dispatchPlayUiWidgetEvent(
  target: PlayUiWidgetEventTarget,
  event: Omit<UiWidgetEventControl, "type">,
): boolean {
  const payload: UiWidgetEventControl = { type: "uiWidgetEvent", ...event };
  if (target.worker) {
    target.worker.postControl(payload);
    return true;
  }
  if (target.runtime) {
    target.runtime.dispatchUiWidgetEvent(payload);
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
    target.runtime.tick();
    target.runtime.pause();
    return true;
  }
  return false;
}

export function playSessionBootControls(options: {
  load: Extract<ControlMessage, { type: "load" }>;
  userInterfaces?: readonly UserInterfaceRuntimeDocument[];
  scripts?: readonly ScriptBundleEntry[];
  spawn?: Array<{ classId: string; variables?: Record<string, unknown> }>;
  animGraphs?: ReadonlyArray<{ guid: string; document: unknown }>;
  behaviourTrees?: ReadonlyArray<{ guid: string; document: unknown }>;
  blackboards?: ReadonlyArray<{ guid: string; document: unknown }>;
  tilemaps?: Extract<ControlMessage, { type: "loadTilemaps" }> | null;
  sprites?: Extract<ControlMessage, { type: "loadSprites" }> | null;
  navmeshBytes?: Uint8Array | null;
  pauseOnPlay?: boolean;
}): ControlMessage[] {
  const controls: ControlMessage[] = [options.load];
  if ((options.userInterfaces?.length ?? 0) > 0) {
    controls.push({
      type: "loadUserInterfaces",
      documents: [...(options.userInterfaces ?? [])],
    });
  }
  if ((options.scripts?.length ?? 0) > 0) {
    controls.push({
      type: "loadScripts",
      scripts: [...(options.scripts ?? [])],
      spawn: options.spawn,
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
  if (options.tilemaps) controls.push(options.tilemaps);
  if (options.sprites) controls.push(options.sprites);
  if (options.navmeshBytes && options.navmeshBytes.byteLength > 0) {
    const copy = options.navmeshBytes.slice();
    controls.push({
      type: "loadNavMesh",
      bytes: copy.buffer.slice(
        copy.byteOffset,
        copy.byteOffset + copy.byteLength,
      ) as ArrayBuffer,
    });
  }
  controls.push({ type: "play" });
  if (options.pauseOnPlay) {
    controls.push({ type: "setPaused", paused: true });
  }
  return controls;
}

export interface PlaySessionResult {
  diagnostics: SessionReportEntry[];
  droppedDiagnostics: number;
  textureCountBefore: number;
  textureCountAfter: number;
  /** True when Play left more GPU textures than it started with. */
  textureLeak: boolean;
  /** Which runtime host was used. */
  runtimeMode: "worker" | "in-process";
  liveObjectCounts?: { meshes: number; textures: number };
}

export interface PlaySession {
  canvas: HTMLCanvasElement;
  handle: EngineHandle;
  runtime: RuntimeDriver | null;
  worker: GameWorkerHost | null;
  runtimeMode: "worker" | "in-process";
  setPaused: (paused: boolean) => void;
  /** Last resolved Move.x from the in-process runtime; null on the worker path. */
  lastMoveX: () => number | null;
  /** Latest snapshot actor positions for e2e collision / motion. */
  lastActorPositions: () => readonly PlayActorPosition[];
  /** Push a touch joystick sample into the Play input ring. */
  pushTouchAxis: (controlId: string, value: number) => void;
  /** Route a mounted HUD widget event to the worker or in-process runtime. */
  dispatchUiWidgetEvent: (
    event: Omit<UiWidgetEventControl, "type">,
  ) => boolean;
  /** Session-only Play/Preview fps cap; does not write `project.json`. */
  setFrameCap: (fps: number) => void;
  /** Actor guids spawned this session (authored scene + unmatched scripts). */
  spawnedActorGuids: () => readonly string[];
  executeConsoleCommand: (
    line: string,
  ) => Promise<{ success: boolean; output: string }>;
  inspectWorld: () => Promise<DebugInspectSnapshot>;
  /** Advance one simulation tick while paused. */
  step: () => void;
  lastTrace: () => TracePayload | null;
  accountedBytes: () => number;
  liveObjectCounts: () => { meshes: number; textures: number };
  drawCalls: () => number;
  bridgeMessagesPerSec: () => number;
  stop: () => PlaySessionResult;
}

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

export interface PlayHudStats {
  fps: number;
  scriptMs: number;
  physicsMs: number;
  frameId: number;
}

/** Worker `stats` commands are the source of truth for script/physics ms. */
export function applyWorkerPlayStats(
  previous: PlayHudStats | undefined,
  command: {
    fps?: number;
    scriptMs: number;
    physicsMs: number;
    frameId: number;
  },
): PlayHudStats {
  return {
    fps: command.fps && command.fps > 0 ? command.fps : (previous?.fps ?? 0),
    scriptMs: command.scriptMs,
    physicsMs: command.physicsMs,
    frameId: command.frameId,
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
    frameId: previous?.frameId ?? 0,
  };
}

const FIXTURE_ASSET = "preview-fixture";
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
  canvas: HTMLCanvasElement;
  sharedEngine: EngineHandle["engine"];
  injectFixtureThrow?: boolean;
  /** Scene physics world and gravity from the open scene document. */
  physics?: PlayPhysicsSettings;
  /** Compiled project graphs to run for this session. */
  scripts?: readonly ScriptBundleEntry[];
  /** Authored scene instantiated in the worker instead of demo actors. */
  sceneAssetGuid?: string;
  scene?: SerializedScene;
  gameInstanceClass?: string;
  scenes?: Array<{ guid: string; scene: SerializedScene }>;
  onStats?: (stats: {
    fps: number;
    scriptMs: number;
    physicsMs: number;
    frameId: number;
  }) => void;
  onLog?: (message: string, severity: string) => void;
  onPrint?: (entry: {
    message: string;
    key: string;
    duration: number;
    color: string;
  }) => void;
  /** Project `playFrameCap`; omitted or invalid → 60. */
  frameCap?: number;
  onUiSetVisible?: (instanceId: string, widgetId: string, visible: boolean) => void;
  onUiApply?: (instanceId: string, classId: string, assetGuid: string) => void;
  onUiRemove?: (instanceId: string) => void;
  onSetInputMode?: (mode: InputMode) => void;
  /** Slim UserInterface metadata; posted before `loadScripts`. */
  userInterfaces?: readonly UserInterfaceRuntimeDocument[];
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
  tilemapPayloads?: ReadonlyMap<string, TilemapPayload>;
  tilesetPayloads?: ReadonlyMap<string, TilesetPayload>;
  textureBytes?: ReadonlyMap<string, Uint8Array>;
  modelBytes?: ReadonlyMap<string, Uint8Array>;
  audioBytes?: ReadonlyMap<string, Uint8Array>;
  audioLibrary?: AudioLibrary;
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
  postProcessingEnabled?: boolean;
  hardwareScalingLevel?: number;
  pixelsPerUnit?: number;
  pixelPerfect?: boolean;
  /** Baked Scene navmesh bytes; Play imports and never generates. */
  navmeshBytes?: Uint8Array | null;
  infiniteLoopDetection?: boolean;
  loopCount?: number;
  /** Called when a session-fatal diagnostic (infinite loop) arrives. */
  onFatalDiagnostic?: () => void;
  /** When true, pause after Play boot so `boot.play`'s resume cannot undo it. */
  pauseOnPlay?: boolean;
  onSessionPaused?: (paused: boolean) => void;
  onShowFps?: (enabled: boolean) => void;
  onStatHighlight?: (name: string, enabled: boolean) => void;
  onSetRenderResolution?: (width: number, height: number) => void;
  onBtState?: (state: {
    slotId: number;
    status: string;
    btNodeId: string | null;
    lastResults: Record<string, string>;
    blackboard: Record<string, unknown>;
    stack: Array<{ nodeId: string; childIndex: number; opened: boolean }>;
  }) => void;
}): PlaySession {
  const { canvas, sharedEngine } = options;
  const textureCountBefore = sharedEngine.getLoadedTexturesCache().length;
  const liveBefore = {
    meshes: 0,
    textures: textureCountBefore,
  };

  const handle = createEngine(canvas, {
    sharedEngine,
    playMode: true,
    maxActors: 256,
    frameCap: resolvePlayFrameCap(options.frameCap),
    spritePayloads: options.spritePayloads,
    spriteAnimations: options.spriteAnimationPayloads,
    tilemapPayloads: options.tilemapPayloads,
    tilesetPayloads: options.tilesetPayloads,
    textureBytes: options.textureBytes,
    modelBytes: options.modelBytes,
    audioBytes: options.audioBytes,
    audioLibrary: options.audioLibrary,
    particleLibrary: options.particleLibrary,
    audioReverbBytes: options.audioReverbBytes,
    audioProjectSettings: options.audioProjectSettings,
    materialDocuments: options.materialDocuments,
    materialFunctions: options.materialFunctions,
    postProcessStack: options.scene?.settings.postProcessStack,
    postProcessingEnabled: options.postProcessingEnabled,
    hardwareScalingLevel: options.hardwareScalingLevel,
    pixelsPerUnit: options.pixelsPerUnit,
    pixelPerfect: options.pixelPerfect,
    environmentColor: options.scene?.settings.environmentColor,
    viewportMode: options.scene?.viewportMode,
    navmeshBytes: options.navmeshBytes,
    ktx2BasePath: editorKtx2PublicBase(),
    onPostProcessDiagnostic: (diagnostic) => {
      options.onLog?.(diagnostic.message, "warning");
    },
    onAudioDiagnostic: (diagnostic) => {
      options.onLog?.(diagnostic.message, "warning");
    },
    onParticleDiagnostic: (diagnostic) => {
      options.onLog?.(diagnostic.message, "warning");
    },
  });
  if (options.scene) {
    handle.applySceneEnvironment(options.scene);
  }
  handle.scheduler.invalidate("play");
  liveBefore.meshes = handle.liveObjectCounts().meshes;

  let worker: GameWorkerHost | null = null;
  let runtime: RuntimeDriver | null = null;
  let runtimeMode: "worker" | "in-process" = "in-process";
  let pauseGate: ReturnType<typeof createPlayPauseGate> | null = null;
  // Aggregates diagnostics received over the command channel (Worker mode).
  // The in-process path already aggregates via `runtime.getDiagnostics()`.
  const workerDiagnostics = new SessionDiagnosticAggregator();

  const spawnedActorGuids: string[] = [];
  const consoleWaiters: Array<(result: { success: boolean; output: string }) => void> =
    [];
  const inspectWaiters: Array<(snapshot: DebugInspectSnapshot) => void> = [];
  let recordedTrace: TracePayload | null = null;
  let commandCount = 0;
  let commandWindowStart = performance.now();
  let bridgeRate = 0;
  let hudStats: PlayHudStats | undefined;
  let lastWorkerTickIndex = 0;
  let input: InputCaptureHandle | null = null;

  const emitHudStats = (next: PlayHudStats) => {
    hudStats = next;
    options.onStats?.(next);
  };

  const noteCommand = () => {
    commandCount += 1;
    const now = performance.now();
    const elapsed = (now - commandWindowStart) / 1000;
    if (elapsed >= 0.2) {
      bridgeRate = commandCount / elapsed;
      commandCount = 0;
      commandWindowStart = now;
    }
  };

  const onCommand = (command: CommandMessage) => {
    noteCommand();
    if (command.type === "spawn") {
      spawnedActorGuids.push(command.actorGuid);
    }
    if (shouldForwardPlayEngineCommand(command.type)) {
      handle.applyCommand(command);
    }
    if (command.type === "activeScene") {
      const scene = playSceneByGuid(
        command.sceneAssetGuid,
        options.scenes ?? [],
        { guid: options.sceneAssetGuid, scene: options.scene },
      );
      if (scene) {
        handle.loadScene(scene);
        handle.applySceneEnvironment(scene);
        handle.resetAudioSession();
        handle.resetParticleSession();
      }
    }
    if (command.type === "log") {
      options.onLog?.(command.message, command.severity ?? "log");
    }
    if (command.type === "print" && command.message) {
      options.onPrint?.({
        message: command.message,
        key: command.key ?? "",
        duration: command.duration ?? 2,
        color: cssColor(command.color),
      });
    }
    if (command.type === "stats") {
      emitHudStats(
        applyWorkerPlayStats(hudStats, {
          fps: command.fps,
          scriptMs: command.scriptMs ?? 0,
          physicsMs: command.physicsMs ?? 0,
          frameId: command.frameId ?? 0,
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
    applyPlayUiCommand(command, {
      onUiSetVisible: options.onUiSetVisible,
      onUiApply: options.onUiApply,
      onUiRemove: options.onUiRemove,
    });
    applyPlaySessionPausedCommand(command, options.onSessionPaused);
    applyPlayHudConsoleCommand(command, {
      onShowFps: options.onShowFps,
      onStat: options.onStatHighlight,
    });
    if (
      applyPlayInputModeCommand(command, (mode) => {
        input?.setInputMode(mode);
        options.onSetInputMode?.(mode);
      })
    ) {
      return;
    }
    if (command.type === "setRenderResolution") {
      options.onSetRenderResolution?.(command.width, command.height);
    }
    if (command.type === "btState") {
      options.onBtState?.({
        slotId: command.slotId,
        status: command.status,
        btNodeId: command.btNodeId,
        lastResults: command.lastResults,
        blackboard: command.blackboard,
        stack: command.stack,
      });
    }
  };

  const scripts = options.scripts ?? [];
  const spawn = spawnListForScripts(scripts);
  const physics = options.physics ?? {
    physicsWorld: "3d" as const,
    gravity: [0, -9.81, 0] as [number, number, number],
  };
  const loadControl = playLoadControl({
    sceneAssetGuid: options.sceneAssetGuid ?? "play-scene",
    scene: options.scene,
    physicsWorld: physics.physicsWorld,
    gravity: physics.gravity,
    gameInstanceClass: options.gameInstanceClass,
    scenes: options.scenes,
    infiniteLoopDetection: options.infiniteLoopDetection,
    loopCount: options.loopCount,
    audioAssetGuids: [...(options.audioLibrary?.audio.keys() ?? [])],
  });

  try {
    worker = createGameWorkerHost();
    runtimeMode = "worker";
    worker.onCommand((cmd) => onCommand(cmd));
    worker.onSnapshot((buffer) => {
      lastWorkerTickIndex = applyPlaySnapshotTick(lastWorkerTickIndex, buffer);
      handle.pushSnapshot(buffer);
    });
    for (const control of playSessionBootControls({
      load: loadControl,
      userInterfaces: options.userInterfaces,
      scripts,
      spawn,
      animGraphs: options.animGraphs,
      behaviourTrees: options.behaviourTrees,
      blackboards: options.blackboards,
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
      navmeshBytes: options.navmeshBytes,
      pauseOnPlay: options.pauseOnPlay,
    })) {
      worker.postControl(control);
    }
  } catch (err) {
    worker = null;
    runtimeMode = "in-process";
    runtime = createRuntimeFromLoad(loadControl, (command) => onCommand(command));
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
    pauseGate = createPlayPauseGate({
      pause: () => inProcess.pause(),
      resume: () => inProcess.resume(),
    });
    if ((options.userInterfaces?.length ?? 0) > 0) {
      applyUiRuntimeControl(inProcess, {
        type: "loadUserInterfaces",
        documents: [...(options.userInterfaces ?? [])],
      });
    }
    if (scripts.length > 0) {
      boot.queueScripts(inProcess, scripts, spawn);
    }
    for (const entry of options.animGraphs ?? []) {
      const document = parseAnimGraphDocument(entry.document);
      if (document) inProcess.registerAnimGraph(entry.guid, document);
    }
    for (const entry of options.behaviourTrees ?? []) {
      const document = parseBehaviourTreeDocument(entry.document);
      if (document) inProcess.registerBehaviourTree(entry.guid, document);
    }
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
    if (options.navmeshBytes && options.navmeshBytes.byteLength > 0) {
      boot.queueNavMesh(inProcess, options.navmeshBytes);
    }
    void pauseGate.beginPlay(() => boot.play(inProcess)).catch((error) => {
      inProcess.reportError(error);
    });
    if (options.pauseOnPlay) {
      pauseGate.setPaused(true);
    }
    options.onLog?.(
      `Play worker unavailable (${err instanceof Error ? err.message : String(err)}); using in-process.`,
      "warning",
    );
  }

  input = attachInputCapture(canvas, {
    skipPointerAndKeyboard: () => handle.isFreeCamEnabled(),
  });

  const unlock = () => {
    void handle.unlockAudio();
  };
  canvas.addEventListener("pointerdown", unlock);
  canvas.addEventListener("touchstart", unlock);

  const snapBuf = new Float32Array(snapshotFloatCount(256));
  let last = performance.now();
  let raf = 0;
  let frames = 0;
  let fpsWindowStart = last;
  let sessionDiagnostics: SessionReportEntry[] = [];
  let droppedDiagnostics = 0;
  let lastObservedMoveX: number | null = null;
  let stopped = false;
  let stopResult: PlaySessionResult | null = null;

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
        lastWorkerTickIndex = applyPlaySnapshotTick(lastWorkerTickIndex, snapBuf);
        handle.pushSnapshot(snapBuf);
      }
    }
    // Worker pumps itself; host only feeds input + applies snapshots via onSnapshot.
    frames += 1;
    if (now - fpsWindowStart >= 1000) {
      emitHudStats(applyPlayFpsSample(hudStats, frames));
      frames = 0;
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
        err.stack = `Error: Preview fixture throw\n    at run (babylonslate:///${FIXTURE_ASSET}.js:1:1)`;
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

  return {
    canvas,
    handle,
    runtime,
    worker,
    runtimeMode,
    setPaused: (paused: boolean) => {
      handle.setPaused(paused);
      pauseGate?.setPaused(paused);
      worker?.postControl({ type: "setPaused", paused });
    },
    lastMoveX: () => {
      if (runtime) {
        return runtime.getResolvedInput().axes2D.Move?.x ?? lastObservedMoveX;
      }
      return lastObservedMoveX;
    },
    lastActorPositions: () => handle.lastActorPositions(),
    pushTouchAxis: (controlId: string, value: number) => {
      input?.pushTouchAxis(controlId, value);
    },
    dispatchUiWidgetEvent: (event) =>
      dispatchPlayUiWidgetEvent({ worker, runtime }, event),
    setFrameCap: (fps: number) => {
      handle.scheduler.setFrameCap(fps);
    },
    spawnedActorGuids: () => spawnedActorGuids,
    executeConsoleCommand: (line) => {
      if (runtime) {
        return Promise.resolve(runtime.executeConsoleCommand(line));
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
    step: () => {
      applyPlaySessionStep({ worker, runtime });
    },
    lastTrace: () => recordedTrace ?? runtime?.stopTrace() ?? null,
    accountedBytes: () => handle.resourceCache.accountedBytes(),
    liveObjectCounts: () => handle.liveObjectCounts(),
    drawCalls: () => handle.drawCalls(),
    bridgeMessagesPerSec: () => {
      const now = performance.now();
      const elapsed = (now - commandWindowStart) / 1000;
      if (elapsed >= 0.2) {
        bridgeRate = commandCount / Math.max(elapsed, 0.001);
        commandCount = 0;
        commandWindowStart = now;
      }
      return Math.round(bridgeRate);
    },
    stop: () => {
      if (stopped && stopResult) return stopResult;
      stopped = true;
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
      worker?.postControl({ type: "stop" });
      worker?.terminate();
      const liveAfter = handle.liveObjectCounts();
      handle.dispose();
      const textureCountAfter = sharedEngine.getLoadedTexturesCache().length;
      const textureLeak = textureCountAfter > textureCountBefore;
      if (textureLeak) {
        console.error(
          `[play] texture cache grew ${textureCountBefore} → ${textureCountAfter}`,
        );
      }
      stopResult = {
        diagnostics: sessionDiagnostics,
        droppedDiagnostics,
        textureCountBefore,
        textureCountAfter,
        textureLeak,
        runtimeMode,
        liveObjectCounts: liveAfter,
      };
      return stopResult;
    },
  };
}

/** Print colors arrive as linear 0..1 RGBA vectors from the graph. */
function cssColor(color?: {
  x: number;
  y: number;
  z: number;
  w: number;
}): string {
  if (!color) return "#ffffff";
  const channel = (v: number) =>
    Math.max(0, Math.min(255, Math.round((Number(v) || 0) * 255)));
  return `rgba(${channel(color.x)}, ${channel(color.y)}, ${channel(color.z)}, ${
    color.w ?? 1
  })`;
}

export const PREVIEW_FIXTURE_NODE_ID = FIXTURE_NODE;
export const PREVIEW_FIXTURE_ASSET_GUID = FIXTURE_ASSET;
