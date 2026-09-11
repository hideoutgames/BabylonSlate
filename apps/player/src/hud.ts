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
  /** Real JS heap (Chromium/Electron); absent on WKWebView. */
  jsHeapBytes?: number;
  /** Host app-process footprint on iOS; excludes the WebContent process. */
  appFootprintBytes?: number;
  /** Bytes until jetsam would kill the app process (iOS). */
  appAvailableBytes?: number;
  /** Device-wide free + inactive + purgeable memory (iOS). */
  systemAvailableBytes?: number;
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
    fps: previous?.fps ?? 0,
    scriptMs: command.scriptMs,
    physicsMs: command.physicsMs,
    draws: previous?.draws ?? 0,
    geometryBytes: previous?.geometryBytes,
    liveActors: command.liveActors ?? previous?.liveActors ?? 0,
    snapshotCapacity:
      command.snapshotCapacity ?? previous?.snapshotCapacity ?? 0,
    jsHeapBytes: previous?.jsHeapBytes,
    appFootprintBytes: previous?.appFootprintBytes,
    appAvailableBytes: previous?.appAvailableBytes,
    systemAvailableBytes: previous?.systemAvailableBytes,
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
    jsHeapBytes: previous?.jsHeapBytes,
    appFootprintBytes: previous?.appFootprintBytes,
    appAvailableBytes: previous?.appAvailableBytes,
    systemAvailableBytes: previous?.systemAvailableBytes,
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
  applyCommand: (command: { type: string; enabled?: unknown; name?: unknown }) => boolean;
} {
  if (!options.bundleDebugger) {
    element.hidden = true;
    return { setStats: () => {}, applyCommand: () => false };
  }
  element.hidden = false;
  type Highlight = "unit" | "memory" | "draws" | "threads";
  let highlight: Highlight | null = null;
  const fields = new Map<string, HTMLSpanElement>();
  element.replaceChildren();
  for (const name of ["threads", "unit", "actors", "draws", "memory", "ticks", "warnings"]) {
    const field = element.ownerDocument.createElement("span");
    field.dataset.stat = name;
    fields.set(name, field);
    element.append(field, element.ownerDocument.createTextNode("  "));
  }
  const applyHighlight = () => {
    element.dataset.highlight = highlight ?? "";
    for (const [name, field] of fields) {
      const active = name === highlight || (highlight === "threads" && name === "unit");
      field.dataset.highlighted = String(active);
      field.style.fontWeight = active ? "700" : "";
      field.style.textDecoration = active ? "underline" : "";
    }
  };
  const setStats = (stats: PlayerHudStats) => {
    const warn = drawCallCeilingWarning(stats.draws);
    const geoWarn =
      stats.geometryBytes != null
        ? geometryByteCeilingWarning(stats.geometryBytes)
        : null;
    element.dataset.fps = String(Math.round(stats.fps));
    element.dataset.ticks = String(stats.ticks);
    fields.get("threads")!.textContent = `fps ${stats.fps.toFixed(0)}`;
    fields.get("unit")!.textContent = `script ${stats.scriptMs.toFixed(2)}ms  phys ${stats.physicsMs.toFixed(2)}ms`;
    fields.get("actors")!.textContent = `actors ${stats.liveActors ?? 0}/${stats.snapshotCapacity ?? 0}`;
    fields.get("draws")!.textContent = `draws ${stats.draws}`;
    const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    fields.get("memory")!.textContent = [
      stats.geometryBytes != null ? `geo ${mb(stats.geometryBytes)}` : null,
      stats.jsHeapBytes != null ? `js ${mb(stats.jsHeapBytes)}` : null,
      stats.appFootprintBytes != null ? `app ${mb(stats.appFootprintBytes)}` : null,
      stats.appAvailableBytes != null ? `headroom ${mb(stats.appAvailableBytes)}` : null,
      stats.systemAvailableBytes != null ? `free ${mb(stats.systemAvailableBytes)}` : null,
    ]
      .filter((segment) => segment !== null)
      .join("  ");
    fields.get("ticks")!.textContent = `ticks ${stats.ticks}`;
    fields.get("warnings")!.textContent = `${warn ? "DRAWS HIGH" : ""}${geoWarn ? "  GEO HIGH" : ""}`;
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
  applyHighlight();
  return {
    setStats,
    applyCommand(command) {
      if (command.type === "setShowFps") {
        element.hidden = command.enabled !== true;
        return true;
      }
      if (command.type === "setStat" && typeof command.name === "string" &&
        ["unit", "memory", "draws", "threads"].includes(command.name)) {
        if (command.enabled === true) {
          element.hidden = false;
          highlight = command.name as Highlight;
        } else if (highlight === command.name) {
          highlight = null;
        }
        applyHighlight();
        return true;
      }
      return false;
    },
  };
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
