import {
  createInProcessRuntime,
  type RuntimeDriver,
  type SessionReportEntry,
} from "@babylonslate/runtime";
import {
  createEngine,
  type EngineHandle,
} from "@babylonslate/render";
import { encodeInputEvents } from "@babylonslate/input";
import { snapshotFloatCount } from "@babylonslate/bridge";
import { attachInputCapture, type InputCaptureHandle } from "./input-capture";

export interface PlaySessionResult {
  diagnostics: SessionReportEntry[];
  droppedDiagnostics: number;
  textureCountBefore: number;
  textureCountAfter: number;
}

export interface PlaySession {
  canvas: HTMLCanvasElement;
  handle: EngineHandle;
  runtime: RuntimeDriver;
  stop: () => PlaySessionResult;
}

const FIXTURE_ASSET = "preview-fixture";
const FIXTURE_NODE = "throw-node";

/**
 * Start a fullscreen Play session: in-process runtime + Play Scene on the
 * shared app Engine via registerView (never a second Engine).
 */
export function startPlaySession(options: {
  canvas: HTMLCanvasElement;
  sharedEngine: EngineHandle["engine"];
  /** When true, schedule a fixture throw mapped to a graph node. */
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

  const handle = createEngine(canvas, {
    sharedEngine,
    playMode: true,
    maxActors: 256,
  });

  // Pause editor views: Play owns rendering on this engine's active view.
  handle.scheduler.invalidate("play");

  const runtime = createInProcessRuntime({
    seed: 1,
    maxActors: 256,
    onCommand: (command) => {
      if (command.type === "log") {
        options.onLog?.(command.message, command.severity);
      }
      if (command.type === "stats") {
        options.onStats?.({
          fps: command.fps ?? 0,
          scriptMs: command.scriptMs,
          physicsMs: command.physicsMs,
          frameId: command.frameId,
        });
      }
      if (command.type === "diagnostic") {
        options.onLog?.(command.message, command.severity);
      }
    },
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

  const input: InputCaptureHandle = attachInputCapture(canvas);
  runtime.start();

  // iOS audio unlock placeholder — first gesture.
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

  const pump = () => {
    const now = performance.now();
    const elapsed = (now - last) / 1000;
    last = now;
    input.setTick(runtime.getWorld().clock.tickIndex);
    input.pollGamepads();
    const drained = input.ring.drain();
    if (drained.length > 0) {
      runtime.pushInputBuffer(encodeInputEvents(drained));
    }
    runtime.advance(elapsed);
    if (runtime.copySnapshot(snapBuf)) {
      handle.pushSnapshot(snapBuf);
    }
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
    // Deliberate throw with a babylonslate sourceURL stack for session report.
    queueMicrotask(() => {
      const err = new Error("Preview fixture throw");
      err.stack = `Error: Preview fixture throw\n    at run (babylonslate:///${FIXTURE_ASSET}.js:1:1)`;
      runtime.reportError(err);
    });
  }

  return {
    canvas,
    handle,
    runtime,
    stop: () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", unlock);
      input.dispose();
      runtime.stop();
      const diagnostics = runtime.getDiagnostics().entries();
      const dropped = runtime.getDiagnostics().droppedCount();
      handle.dispose();
      const textureCountAfter = sharedEngine.getLoadedTexturesCache().length;
      return {
        diagnostics,
        droppedDiagnostics: dropped,
        textureCountBefore,
        textureCountAfter,
      };
    },
  };
}

export const PREVIEW_FIXTURE_NODE_ID = FIXTURE_NODE;
export const PREVIEW_FIXTURE_ASSET_GUID = FIXTURE_ASSET;
