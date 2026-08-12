import {
  createInProcessRuntime,
  SessionDiagnosticAggregator,
  type RuntimeDiagnostic,
  type RuntimeDriver,
  type SessionReportEntry,
} from "@babylonslate/runtime";
import {
  createEngine,
  type EngineHandle,
} from "@babylonslate/render";
import { encodeInputEvents } from "@babylonslate/input";
import { snapshotFloatCount, type CommandMessage } from "@babylonslate/bridge";
import { attachInputCapture, type InputCaptureHandle } from "./input-capture";
import { createGameWorkerHost, type GameWorkerHost } from "./game-worker-host";

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
  stop: () => PlaySessionResult;
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
  onStats?: (stats: {
    fps: number;
    scriptMs: number;
    physicsMs: number;
    frameId: number;
  }) => void;
  onLog?: (message: string, severity: string) => void;
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
  });
  handle.scheduler.invalidate("play");
  liveBefore.meshes = handle.liveObjectCounts().meshes;

  let worker: GameWorkerHost | null = null;
  let runtime: RuntimeDriver | null = null;
  let runtimeMode: "worker" | "in-process" = "in-process";
  // Aggregates diagnostics received over the command channel (Worker mode).
  // The in-process path already aggregates via `runtime.getDiagnostics()`.
  const workerDiagnostics = new SessionDiagnosticAggregator();

  const onCommand = (command: CommandMessage) => {
    if (command.type === "log") {
      options.onLog?.(command.message, command.severity ?? "log");
    }
    if (command.type === "stats") {
      options.onStats?.({
        fps: command.fps ?? 0,
        scriptMs: command.scriptMs ?? 0,
        physicsMs: command.physicsMs ?? 0,
        frameId: command.frameId ?? 0,
      });
    }
    if (command.type === "diagnostic") {
      options.onLog?.(command.message, command.severity ?? "error");
      const diagnostic = diagnosticFromCommand(command);
      if (diagnostic) workerDiagnostics.push(diagnostic);
    }
  };

  try {
    worker = createGameWorkerHost();
    runtimeMode = "worker";
    worker.onCommand((cmd) => onCommand(cmd));
    worker.onSnapshot((buffer) => handle.pushSnapshot(buffer));
    worker.postControl({ type: "load", sceneAssetGuid: "play-scene" });
    worker.postControl({ type: "play" });
  } catch (err) {
    worker = null;
    runtimeMode = "in-process";
    runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 256,
      onCommand: (command) => onCommand(command),
    });
    runtime.registerAnchors(FIXTURE_ASSET, [
      {
        line: 1,
        column: 0,
        assetGuid: FIXTURE_ASSET,
        graphId: "event-graph",
        nodeId: FIXTURE_NODE,
      },
    ]);
    runtime.start();
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

  const pump = () => {
    const now = performance.now();
    const elapsed = (now - last) / 1000;
    last = now;
    const tick =
      runtime?.getWorld().clock.tickIndex ?? Math.floor(now / (1000 / 60));
    input.setTick(tick);
    input.pollGamepads();
    const drained = input.ring.drain();
    if (drained.length > 0) {
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
      options.onStats?.({
        fps: frames,
        scriptMs: 0,
        physicsMs: 0,
        frameId: frames,
      });
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

export const PREVIEW_FIXTURE_NODE_ID = FIXTURE_NODE;
export const PREVIEW_FIXTURE_ASSET_GUID = FIXTURE_ASSET;
