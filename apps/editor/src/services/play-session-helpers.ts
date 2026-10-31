import { DEFAULT_PLAY_FRAME_CAP, printHudCssColor } from "@haptic/core";
import type { RuntimeDiagnostic } from "@haptic/runtime";
import type { DebugInspectSnapshot } from "@haptic/object-model";
import {
  describeEngineTexture,
  internalTexturesHeldByScene,
  type EngineHandle,
} from "@haptic/render";
import {
  isPlayEngineCommandType,
  snapshotTickIndex,
  type CommandMessage,
  type ControlMessage,
  type DebugObserveTarget,
  type SessionPauseCause,
  type Breakpoint,
} from "@haptic/bridge";
import { INFINITE_LOOP_DIAGNOSTIC_CODE } from "@haptic/debugger";
import type { PlayHudStats, PlayPrintEntry } from "./play-session-types";

/** The diagnostic code of a game worker that failed to load, evaluate or keep running (`createGameWorkerHost`). */
export const PLAY_WORKER_FAILED_CODE = "play.worker.failed";

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
  // A failed game worker answers nothing more: no tick, load progress or boundary would ever come.
  return code === INFINITE_LOOP_DIAGNOSTIC_CODE || code === PLAY_WORKER_FAILED_CODE;
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
