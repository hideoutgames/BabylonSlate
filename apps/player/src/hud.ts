import { snapshotTickIndex } from "@babylonslate/bridge";
import {
  isStatGroup,
  nextStatGroups,
  STAT_GROUP_LABELS,
  statsHudModel,
  TICK_BUDGET_MS,
  type StatGroup,
  type StatsHudMetric,
  type StatsHudRendering,
} from "@babylonslate/debugger";
import {
  audioDebugOverlayText,
  audioStats,
  drawCallCeilingWarning,
  geometryByteCeilingWarning,
  PLAY_AUDIO_UNLOCK_HINT,
  shouldShowPlayAudioUnlockHint,
} from "@babylonslate/render";

export type PlayerHudStats = {
  lightsDebugText?: string | null;
  ticks: number;
  fps: number;
  scriptMs: number;
  physicsMs: number;
  /** Snapshot publish ms from the worker, apart from the script/physics tick. */
  publishMs?: number;
  draws: number;
  geometryBytes?: number;
  /** Accounted texture bytes; sampled only while Stats shows. */
  memoryBytes?: number;
  meshCount?: number;
  textureCount?: number;
  /** Sampled only while Stats shows. */
  rendering?: StatsHudRendering;
  bridgeMessagesPerSec?: number;
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

/** Worker `stats` commands are the source of truth for script/physics/publish ms. */
export function applyWorkerPlayerStats(
  previous: PlayerHudStats | undefined,
  command: {
    ticks?: number;
    fps?: number;
    scriptMs: number;
    physicsMs: number;
    publishMs?: number;
    liveActors?: number;
    snapshotCapacity?: number;
  },
): PlayerHudStats {
  return {
    ticks: command.ticks ?? previous?.ticks ?? 0,
    fps: previous?.fps ?? 0,
    scriptMs: command.scriptMs,
    physicsMs: command.physicsMs,
    publishMs: command.publishMs ?? 0,
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
    publishMs: previous?.publishMs ?? 0,
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

const HUD_STYLE = "display:inline-flex;flex-direction:column;gap:2px;max-width:calc(100vw - 16px);padding:4px 8px;border-radius:2px;background:rgba(20,20,20,0.72);backdrop-filter:blur(4px);color:#eee;font:11px/16px ui-monospace,SFMono-Regular,Menlo,monospace;";
const MUTED = "color:rgba(238,238,238,0.6);";
const WARN = "color:#f87171;";

/** Preview/export Stats, matching Play: FPS and tick timings, plus `stat <group>` rows. */
export function mountPlayerHud(
  element: HTMLElement,
  options: { bundleDebugger: boolean; visible?: boolean },
): {
  setStats: (stats: PlayerHudStats) => void;
  applyCommand: (command: { type: string; enabled?: unknown; name?: unknown }) => boolean;
  /** Whether Stats shows, so the host samples its detail rows only then. */
  visible: () => boolean;
} {
  if (!options.bundleDebugger) {
    element.hidden = true;
    return { setStats: () => {}, applyCommand: () => false, visible: () => false };
  }
  element.hidden = options.visible === false;
  const doc = element.ownerDocument;
  // Panel styles live on a child so the host element's `hidden` still applies.
  const panel = doc.createElement("div");
  panel.style.cssText = HUD_STYLE;
  element.replaceChildren(panel);
  let groups: readonly StatGroup[] = [];
  let latest: PlayerHudStats = { ticks: 0, fps: 0, scriptMs: 0, physicsMs: 0, draws: 0, liveActors: 0, snapshotCapacity: 0 };
  const history: number[] = [];
  const metric = ({ id, label, text, warn }: StatsHudMetric) => {
    const span = doc.createElement("span");
    span.style.whiteSpace = "nowrap";
    span.dataset.metric = id;
    if (label) {
      const name = doc.createElement("span");
      name.style.cssText = MUTED;
      name.textContent = `${label} `;
      span.append(name);
    }
    const value = doc.createElement("span");
    if (warn) value.style.cssText = WARN;
    value.textContent = text;
    span.append(value);
    return span;
  };
  const row = (group: StatGroup | null, parts: HTMLElement[]) => {
    const line = doc.createElement("div");
    line.style.cssText = "display:flex;flex-wrap:wrap;align-items:baseline;column-gap:12px;";
    if (group) {
      line.dataset.stat = group;
      const name = doc.createElement("span");
      name.style.cssText = `${MUTED}width:56px;flex-shrink:0;`;
      name.textContent = STAT_GROUP_LABELS[group];
      line.append(name);
    }
    line.append(...parts);
    return line;
  };
  const unavailable = () => {
    const span = doc.createElement("span");
    span.style.cssText = MUTED;
    span.textContent = "unavailable";
    return span;
  };
  // A hidden panel keeps sampling but builds nothing until it is shown.
  const render = () => {
    if (element.hidden) return;
    const stats = latest;
    const model = statsHudModel({
      ...stats,
      geometryHigh: stats.geometryBytes != null && geometryByteCeilingWarning(stats.geometryBytes) !== null,
      drawsHigh: drawCallCeilingWarning(stats.draws) !== null,
    }, groups);
    element.dataset.fps = String(Math.round(stats.fps));
    element.dataset.ticks = String(stats.ticks);
    element.dataset.groups = groups.join(" ");
    const fps = doc.createElement("span");
    fps.style.whiteSpace = "nowrap";
    const fpsValue = doc.createElement("span");
    fpsValue.style.cssText = "font-size:12px;font-weight:600;";
    fpsValue.textContent = stats.fps.toFixed(0);
    fps.append(fpsValue, doc.createTextNode(" fps"));
    fps.dataset.stat = "fps";
    const lines: HTMLElement[] = [row(null, [fps, ...model.frame.map(metric)])];
    for (const { group, metrics } of model.rows) {
      if (group === "unit") {
        const graph = doc.createElement("span");
        graph.style.cssText = "display:flex;align-items:flex-end;gap:1px;height:20px;padding-left:68px;";
        for (const total of history) {
          const bar = doc.createElement("span");
          bar.style.cssText = `width:2px;height:${Math.max(8, Math.min(100, (total / TICK_BUDGET_MS) * 100))}%;background:${total > TICK_BUDGET_MS ? "#f87171" : "rgba(238,238,238,0.55)"};`;
          graph.append(bar);
        }
        lines.push(graph);
      }
      lines.push(row(group, metrics.length ? metrics.map(metric) : [unavailable()]));
    }
    panel.replaceChildren(...lines);
  };
  const setStats = (stats: PlayerHudStats) => {
    latest = stats;
    history.push(stats.scriptMs + stats.physicsMs);
    if (history.length > 40) history.shift();
    render();
  };
  render();
  return {
    setStats,
    visible: () => !element.hidden,
    applyCommand(command) {
      if (command.type === "setShowFps") {
        element.hidden = command.enabled !== true;
        render();
        return true;
      }
      if (command.type === "setStat" && isStatGroup(command.name)) {
        groups = nextStatGroups(groups, command.name, command.enabled === true);
        if (command.enabled === true) element.hidden = false;
        render();
        return true;
      }
      return false;
    },
  };
}

export function mountPlayerDebuggerOverlays(
  parent: HTMLElement,
  options: { bundleDebugger: boolean; lightsDebugText?: () => string | null },
): () => void {
  if (!options.bundleDebugger) return () => {};
  const debugEl = document.createElement("pre");
  debugEl.dataset.testid = "audio-debug-overlay";
  debugEl.style.cssText =
    "position:fixed;bottom:8px;right:8px;margin:0;max-width:28rem;max-height:12rem;overflow:hidden;color:#fff;font:12px/1.4 ui-monospace,monospace;pointer-events:none;white-space:pre;background:rgba(0,0,0,0.55);padding:8px;border-radius:6px;";
  const lightsEl = document.createElement("pre");
  lightsEl.dataset.testid = "lights-debug-overlay";
  lightsEl.style.cssText = debugEl.style.cssText + "top:48px;bottom:auto;white-space:pre-wrap;";
  const hint = document.createElement("p");
  hint.dataset.testid = "play-audio-unlock-hint";
  hint.style.cssText =
    "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);margin:0;color:#fff;font:12px/1.4 ui-sans-serif,system-ui,sans-serif;pointer-events:none;display:none;";
  parent.appendChild(hint);
  let raf = 0;
  // Sampling is cheap; the DOM changes only when an overlay's content does, so
  // empty overlays cost no layout work.
  let shownLightText: string | null = null;
  let shownDebugText: string | null = null;
  let shownHint = false;
  const tick = () => {
    const lightText = options.lightsDebugText?.() ?? null;
    if (lightText !== shownLightText) {
      shownLightText = lightText;
      if (lightText === null) lightsEl.remove();
      else { lightsEl.textContent = lightText; if (!lightsEl.parentNode) parent.appendChild(lightsEl); }
    }
    const debugText = audioDebugOverlayText(audioStats);
    if (debugText !== shownDebugText) {
      shownDebugText = debugText;
      if (debugText === null) {
        debugEl.remove();
        debugEl.textContent = "";
      } else {
        debugEl.textContent = debugText;
        if (!debugEl.parentNode) parent.appendChild(debugEl);
      }
    }
    const showHint = shouldShowPlayAudioUnlockHint(audioStats);
    if (showHint !== shownHint) {
      shownHint = showHint;
      hint.style.display = showHint ? "block" : "none";
      hint.textContent = showHint ? PLAY_AUDIO_UNLOCK_HINT : "";
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    debugEl.remove();
    lightsEl.remove();
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
