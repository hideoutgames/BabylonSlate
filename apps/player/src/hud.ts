import { snapshotTickIndex } from "@babylonslate/bridge";
import {
  audioDebugOverlayText,
  audioStats,
  drawCallCeilingWarning,
  geometryByteCeilingWarning,
  PLAY_AUDIO_UNLOCK_HINT,
  shouldShowPlayAudioUnlockHint,
} from "@babylonslate/render";

export type PlayerHudStats = {
  ticks: number;
  fps: number;
  scriptMs: number;
  physicsMs: number;
  draws: number;
  geometryBytes?: number;
  liveActors?: number;
  snapshotCapacity?: number;
};

/** Worker `stats` commands are the source of truth for script/physics ms. */
export function applyWorkerPlayerStats(
  previous: PlayerHudStats | undefined,
  command: {
    ticks?: number;
    fps?: number;
    scriptMs: number;
    physicsMs: number;
    liveActors?: number;
    snapshotCapacity?: number;
  },
): PlayerHudStats {
  return {
    ticks: command.ticks ?? previous?.ticks ?? 0,
    fps: command.fps && command.fps > 0 ? command.fps : (previous?.fps ?? 0),
    scriptMs: command.scriptMs,
    physicsMs: command.physicsMs,
    draws: previous?.draws ?? 0,
    geometryBytes: previous?.geometryBytes,
    liveActors: command.liveActors ?? previous?.liveActors ?? 0,
    snapshotCapacity:
      command.snapshotCapacity ?? previous?.snapshotCapacity ?? 0,
  };
}

/** Main-thread FPS sample must not zero worker timings. */
export function applyPlayerFpsSample(
  previous: PlayerHudStats | undefined,
  fps: number,
): PlayerHudStats {
  return {
    ticks: previous?.ticks ?? 0,
    fps,
    scriptMs: previous?.scriptMs ?? 0,
    physicsMs: previous?.physicsMs ?? 0,
    draws: previous?.draws ?? 0,
    geometryBytes: previous?.geometryBytes,
    liveActors: previous?.liveActors ?? 0,
    snapshotCapacity: previous?.snapshotCapacity ?? 0,
  };
}

/** Worker hosts stamp input from snapshot tickIndex so throttled stats cannot drop sticks. */
export function applyPlayerSnapshotTick(
  previous: number,
  buffer: Float32Array,
): number {
  return snapshotTickIndex(buffer) ?? previous;
}

export function mountPlayerHud(
  element: HTMLElement,
  options: { bundleDebugger: boolean },
): {
  setStats: (stats: PlayerHudStats) => void;
} {
  if (!options.bundleDebugger) {
    element.hidden = true;
    return { setStats: () => {} };
  }
  element.hidden = false;
  const setStats = (stats: PlayerHudStats) => {
    const warn = drawCallCeilingWarning(stats.draws);
    const geoWarn =
      stats.geometryBytes != null
        ? geometryByteCeilingWarning(stats.geometryBytes)
        : null;
    element.dataset.fps = String(Math.round(stats.fps));
    element.dataset.ticks = String(stats.ticks);
    const geo =
      stats.geometryBytes != null
        ? `  geo ${(stats.geometryBytes / (1024 * 1024)).toFixed(1)}MB`
        : "";
    element.textContent = `fps ${stats.fps.toFixed(0)}  script ${stats.scriptMs.toFixed(2)}ms  phys ${stats.physicsMs.toFixed(2)}ms  actors ${stats.liveActors ?? 0}/${stats.snapshotCapacity ?? 0}  draws ${stats.draws}${geo}  ticks ${stats.ticks}${warn ? "  DRAWS HIGH" : ""}${geoWarn ? "  GEO HIGH" : ""}`;
  };
  setStats({
    ticks: 0,
    fps: 0,
    scriptMs: 0,
    physicsMs: 0,
    draws: 0,
    liveActors: 0,
    snapshotCapacity: 0,
  });
  return { setStats };
}

export function mountPlayerDebuggerOverlays(
  parent: HTMLElement,
  options: { bundleDebugger: boolean },
): () => void {
  if (!options.bundleDebugger) return () => {};
  const debugEl = document.createElement("pre");
  debugEl.dataset.testid = "audio-debug-overlay";
  debugEl.style.cssText =
    "position:fixed;bottom:8px;right:8px;margin:0;max-width:28rem;max-height:12rem;overflow:hidden;color:#fff;font:12px/1.4 ui-monospace,monospace;pointer-events:none;white-space:pre;background:rgba(0,0,0,0.55);padding:8px;border-radius:6px;";
  const hint = document.createElement("p");
  hint.dataset.testid = "play-audio-unlock-hint";
  hint.style.cssText =
    "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);margin:0;color:#fff;font:12px/1.4 ui-sans-serif,system-ui,sans-serif;pointer-events:none;display:none;";
  parent.appendChild(hint);
  let raf = 0;
  const tick = () => {
    const debugText = audioDebugOverlayText(audioStats);
    if (debugText === null) {
      debugEl.remove();
      debugEl.textContent = "";
    } else {
      debugEl.textContent = debugText;
      if (!debugEl.parentNode) parent.appendChild(debugEl);
    }
    const showHint = shouldShowPlayAudioUnlockHint(audioStats);
    hint.style.display = showHint ? "block" : "none";
    hint.textContent = showHint ? PLAY_AUDIO_UNLOCK_HINT : "";
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    debugEl.remove();
    hint.remove();
  };
}

export function unlockAudioOnFirstGesture(
  unlock: () => void,
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
): () => void {
  const handler = () => {
    unlock();
  };
  target.addEventListener("pointerdown", handler);
  target.addEventListener("touchstart", handler);
  return () => {
    target.removeEventListener("pointerdown", handler);
    target.removeEventListener("touchstart", handler);
  };
}
