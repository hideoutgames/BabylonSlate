import { parseAnimGraphDocument } from "@babylonslate/anim-graph";
import {
  parseBehaviourTreeDocument,
  parseBlackboardDocument,
} from "@babylonslate/behaviour-tree";
import {
  createPlayBootCoordinator,
  createRuntimeFromLoad,
  SessionDiagnosticAggregator,
  type RuntimeDiagnostic,
  type RuntimeDriver,
  type SessionReportEntry,
} from "@babylonslate/runtime";
import { DEFAULT_PLAY_FRAME_CAP, type SerializedScene } from "@babylonslate/core";
import type { SpritePayload, TilemapPayload, TilesetPayload } from "@babylonslate/assets";
import { playLoadTilemapsControl } from "../lib/play-content";
import {
  createEngine,
  type EngineHandle,
  type PlayActorPosition,
} from "@babylonslate/render";
import { encodeInputEvents } from "@babylonslate/input";
import {
  snapshotFloatCount,
  type CommandMessage,
  type ScriptBundleEntry,
} from "@babylonslate/bridge";
import { spawnListForScripts } from "./script-compiler";
import { attachInputCapture, type InputCaptureHandle } from "./input-capture";
import { observedMoveXFromEvents } from "../lib/play-input-observe";
import { createGameWorkerHost, type GameWorkerHost } from "./game-worker-host";
import {
  playLoadControl,
  type PlayPhysicsSettings,
} from "./play-physics";
import type { TracePayload } from "@babylonslate/debugger";

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
    stack: command.stack,
    frameId: command.frameId,
  };
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
  /** Session-only Play/Preview fps cap; does not write `project.json`. */
  setFrameCap: (fps: number) => void;
  /** Actor guids spawned this session (authored scene + unmatched scripts). */
  spawnedActorGuids: () => readonly string[];
  executeConsoleCommand: (
    line: string,
  ) => Promise<{ success: boolean; output: string }>;
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
 * `stats.tickIndex` rather than `performance.now() / (1000/60)`.
 */
export function playInputStampTick(
  inProcessTickIndex: number | undefined,
  lastWorkerTickIndex: number,
): number {
  return inProcessTickIndex ?? lastWorkerTickIndex;
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
  onUiSetVisible?: (widgetId: string, visible: boolean) => void;
  onUiApply?: (instanceId: string, assetGuid: string) => void;
  onUiRemove?: (instanceId: string) => void;
  /** AnimationGraph documents for `loadAnimGraphs` / `registerAnimGraph`. */
  animGraphs?: ReadonlyArray<{ guid: string; document: unknown }>;
  /** BehaviourTree / Blackboard documents for worker load. */
  behaviourTrees?: ReadonlyArray<{ guid: string; document: unknown }>;
  blackboards?: ReadonlyArray<{ guid: string; document: unknown }>;
  /** Sprite payloads keyed by asset guid for Play clip UV seeks. */
  spritePayloads?: ReadonlyMap<string, SpritePayload>;
  /** Tilemap / tileset payloads for Play chunk meshes and Rapier chains. */
  tilemapPayloads?: ReadonlyMap<string, TilemapPayload>;
  tilesetPayloads?: ReadonlyMap<string, TilesetPayload>;
  textureBytes?: ReadonlyMap<string, Uint8Array>;
  modelBytes?: ReadonlyMap<string, Uint8Array>;
  pixelsPerUnit?: number;
  onSetRenderResolution?: (width: number, height: number) => void;
  onBtState?: (state: {
    slotId: number;
    status: string;
    btNodeId: string | null;
    lastResults: Record<string, string>;
    blackboard: Record<string, unknown>;
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
    tilemapPayloads: options.tilemapPayloads,
    tilesetPayloads: options.tilesetPayloads,
    textureBytes: options.textureBytes,
    modelBytes: options.modelBytes,
    pixelsPerUnit: options.pixelsPerUnit,
  });
  handle.scheduler.invalidate("play");
  liveBefore.meshes = handle.liveObjectCounts().meshes;

  let worker: GameWorkerHost | null = null;
  let runtime: RuntimeDriver | null = null;
  let runtimeMode: "worker" | "in-process" = "in-process";
  // Aggregates diagnostics received over the command channel (Worker mode).
  // The in-process path already aggregates via `runtime.getDiagnostics()`.
  const workerDiagnostics = new SessionDiagnosticAggregator();

  const spawnedActorGuids: string[] = [];
  const consoleWaiters: Array<(result: { success: boolean; output: string }) => void> =
    [];
  let recordedTrace: TracePayload | null = null;
  let commandCount = 0;
  let commandWindowStart = performance.now();
  let bridgeRate = 0;
  let hudStats: PlayHudStats | undefined;
  let lastWorkerTickIndex = 0;

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
    if (command.type === "assignMesh") {
      handle.applyCommand(command);
    }
    if (command.type === "animState") {
      handle.applyCommand(command);
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
      lastWorkerTickIndex = command.tickIndex;
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
    }
    if (command.type === "consoleResult") {
      const waiter = consoleWaiters.shift();
      waiter?.({ success: command.success, output: command.output });
    }
    if (command.type === "trace") {
      recordedTrace = command.payload as unknown as TracePayload;
    }
    if (command.type === "uiSetVisible") {
      options.onUiSetVisible?.(command.widgetId, command.visible);
    }
    if (command.type === "uiApply") {
      options.onUiApply?.(command.instanceId, command.assetGuid);
    }
    if (command.type === "uiRemove") {
      options.onUiRemove?.(command.instanceId);
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
      });
    }
    if (command.type === "playSound") {
      options.onLog?.(
        `[audio] ${command.assetGuid} vol=${command.volume}`,
        "log",
      );
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
  });

  try {
    worker = createGameWorkerHost();
    runtimeMode = "worker";
    worker.onCommand((cmd) => onCommand(cmd));
    worker.onSnapshot((buffer) => handle.pushSnapshot(buffer));
    worker.postControl(loadControl);
    if (scripts.length > 0) {
      worker.postControl({
        type: "loadScripts",
        scripts: [...scripts],
        spawn,
      });
    }
    if ((options.animGraphs?.length ?? 0) > 0) {
      worker.postControl({
        type: "loadAnimGraphs",
        graphs: [...(options.animGraphs ?? [])],
      });
    }
    if (
      (options.behaviourTrees?.length ?? 0) > 0 ||
      (options.blackboards?.length ?? 0) > 0
    ) {
      worker.postControl({
        type: "loadBehaviourTrees",
        trees: [...(options.behaviourTrees ?? [])],
        blackboards: [...(options.blackboards ?? [])],
      });
    }
    const tilemapsControl = playLoadTilemapsControl(
      options.tilemapPayloads,
      options.tilesetPayloads,
      options.pixelsPerUnit,
    );
    if (tilemapsControl) {
      worker.postControl(tilemapsControl);
    }
    worker.postControl({ type: "play" });
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
    void boot.play(inProcess).catch((error) => {
      inProcess.reportError(error);
    });
    options.onLog?.(
      `Play worker unavailable (${err instanceof Error ? err.message : String(err)}); using in-process.`,
      "warning",
    );
  }

  const input: InputCaptureHandle = attachInputCapture(canvas);

  const unlock = () => {
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        void ctx.resume();
      }
    } catch {
      // ignore
    }
    canvas.removeEventListener("pointerdown", unlock);
  };
  canvas.addEventListener("pointerdown", unlock);

  const snapBuf = new Float32Array(snapshotFloatCount(256));
  let last = performance.now();
  let raf = 0;
  let frames = 0;
  let fpsWindowStart = last;
  let sessionDiagnostics: SessionReportEntry[] = [];
  let droppedDiagnostics = 0;
  let lastObservedMoveX: number | null = null;

  const pump = () => {
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
      if (runtime) {
        const err = new Error("Preview fixture throw");
        err.stack = `Error: Preview fixture throw\n    at run (babylonslate:///${FIXTURE_ASSET}.js:1:1)`;
        runtime.reportError(err);
      } else if (worker) {
        // Worker path: route through the same aggregator a real worker
        // `diagnostic` command would use, rather than a report shortcut.
        workerDiagnostics.push({
          code: "runtime.uncaught",
          message: "Preview fixture throw",
          severity: "error",
          assetGuid: FIXTURE_ASSET,
          graphId: "event-graph",
          nodeId: FIXTURE_NODE,
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
      if (runtime) {
        if (paused) runtime.pause();
        else runtime.resume();
      }
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
      input.pushTouchAxis(controlId, value);
    },
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
    lastTrace: () => recordedTrace ?? runtime?.stopTrace() ?? null,
    accountedBytes: () => handle.resourceCache.accountedBytes(),
    liveObjectCounts: () => handle.liveObjectCounts(),
    drawCalls: () => {
      const engine = handle.engine as { drawCalls?: number };
      return engine.drawCalls ?? 0;
    },
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
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", unlock);
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
      return {
        diagnostics: sessionDiagnostics,
        droppedDiagnostics,
        textureCountBefore,
        textureCountAfter,
        textureLeak,
        runtimeMode,
        liveObjectCounts: liveAfter,
      };
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
