import { snapshotTickIndex } from "@babylonslate/bridge";
import { isStatGroup, isTickOverBudget, nextStatGroups, STAT_GROUP_LABELS, TICK_BUDGET_MS, type StatGroup } from "@babylonslate/debugger";
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
} {
  if (!options.bundleDebugger) {
    element.hidden = true;
    return { setStats: () => {}, applyCommand: () => false };
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
  const metric = (label: string | null, value: string, warn = false) => {
    const span = doc.createElement("span");
    span.style.whiteSpace = "nowrap";
    if (label) {
      const name = doc.createElement("span");
      name.style.cssText = MUTED;
      name.textContent = `${label} `;
      span.append(name);
    }
    const text = doc.createElement("span");
    if (warn) text.style.cssText = WARN;
    text.textContent = value;
    span.append(text);
    return span;
  };
  const row = (group: StatGroup | null, parts: (HTMLElement | null)[]) => {
    const line = doc.createElement("div");
    line.style.cssText = "display:flex;flex-wrap:wrap;align-items:baseline;column-gap:12px;";
    if (group) {
      line.dataset.stat = group;
      const name = doc.createElement("span");
      name.style.cssText = `${MUTED}width:56px;flex-shrink:0;`;
      name.textContent = STAT_GROUP_LABELS[group];
      line.append(name);
    }
    line.append(...parts.filter((part): part is HTMLElement => part !== null));
    return line;
  };
  const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  const render = () => {
    const stats = latest;
    const over = isTickOverBudget(stats.scriptMs, stats.physicsMs);
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
    const lines = [row(null, [
      fps,
      metric(null, stats.fps > 0 ? `${(1000 / stats.fps).toFixed(1)} ms` : "— ms"),
      metric("script", `${stats.scriptMs.toFixed(2)} ms`, over),
      metric("physics", `${stats.physicsMs.toFixed(2)} ms`, over),
      over ? metric(null, `over ${TICK_BUDGET_MS} ms budget`, true) : null,
    ])];
    if (groups.includes("unit")) {
      const graph = doc.createElement("span");
      graph.style.cssText = "display:flex;align-items:flex-end;gap:1px;height:20px;padding-left:68px;";
      for (const total of history) {
        const bar = doc.createElement("span");
        bar.style.cssText = `width:2px;height:${Math.max(8, Math.min(100, (total / TICK_BUDGET_MS) * 100))}%;background:${total > TICK_BUDGET_MS ? "#f87171" : "rgba(238,238,238,0.55)"};`;
        graph.append(bar);
      }
      lines.push(row("unit", [
        metric("tick", `${(stats.scriptMs + stats.physicsMs).toFixed(2)} / ${TICK_BUDGET_MS} ms`, over),
        metric("publish", `${(stats.publishMs ?? 0).toFixed(2)} ms`),
      ]));
      lines.push(graph);
    }
    if (groups.includes("memory")) {
      const parts = [
        stats.jsHeapBytes != null ? metric("js", mb(stats.jsHeapBytes)) : null,
        stats.appFootprintBytes != null ? metric("app", mb(stats.appFootprintBytes)) : null,
        stats.appAvailableBytes != null ? metric("headroom", mb(stats.appAvailableBytes)) : null,
        stats.systemAvailableBytes != null ? metric("free", mb(stats.systemAvailableBytes)) : null,
        stats.geometryBytes != null ? metric("geo", mb(stats.geometryBytes), geometryByteCeilingWarning(stats.geometryBytes) !== null) : null,
      ].filter((part) => part !== null);
      lines.push(row("memory", parts.length ? parts : [metric(null, "unavailable")]));
    }
    if (groups.includes("draws")) {
      const drawsHigh = drawCallCeilingWarning(stats.draws) !== null;
      lines.push(row("draws", [
        metric("draws", String(stats.draws), drawsHigh),
        drawsHigh ? metric(null, "draws high", true) : null,
        stats.geometryBytes != null && geometryByteCeilingWarning(stats.geometryBytes) !== null ? metric(null, "geo high", true) : null,
      ]));
    }
    if (groups.includes("threads")) {
      lines.push(row("threads", [
        metric("actors", `${stats.liveActors ?? 0}/${stats.snapshotCapacity ?? 0}`),
        metric("ticks", String(stats.ticks)),
      ]));
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
    applyCommand(command) {
      if (command.type === "setShowFps") {
        element.hidden = command.enabled !== true;
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
  const tick = () => {
    const lightText = options.lightsDebugText?.() ?? null;
    if (lightText === null) lightsEl.remove();
    else { lightsEl.textContent = lightText; if (!lightsEl.parentNode) parent.appendChild(lightsEl); }
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
