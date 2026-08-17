import { drawCallCeilingWarning } from "@babylonslate/render";

export type PlayerHudStats = {
  ticks: number;
  fps: number;
  scriptMs: number;
  physicsMs: number;
  draws: number;
};

/** Worker `stats` commands are the source of truth for script/physics ms. */
export function applyWorkerPlayerStats(
  previous: PlayerHudStats | undefined,
  command: {
    ticks?: number;
    fps?: number;
    scriptMs: number;
    physicsMs: number;
  },
): PlayerHudStats {
  return {
    ticks: command.ticks ?? previous?.ticks ?? 0,
    fps: command.fps && command.fps > 0 ? command.fps : (previous?.fps ?? 0),
    scriptMs: command.scriptMs,
    physicsMs: command.physicsMs,
    draws: previous?.draws ?? 0,
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
  };
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
    element.dataset.fps = String(Math.round(stats.fps));
    element.dataset.ticks = String(stats.ticks);
    element.textContent = `fps ${stats.fps.toFixed(0)}  script ${stats.scriptMs.toFixed(2)}ms  phys ${stats.physicsMs.toFixed(2)}ms  draws ${stats.draws}  ticks ${stats.ticks}${warn ? "  DRAWS HIGH" : ""}`;
  };
  setStats({ ticks: 0, fps: 0, scriptMs: 0, physicsMs: 0, draws: 0 });
  return { setStats };
}

export function unlockAudioOnFirstGesture(): void {
  const AudioContextCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return;
  const context = new AudioContextCtor();
  const resume = () => {
    void context.resume();
  };
  window.addEventListener("pointerdown", resume, { once: true });
  window.addEventListener("touchstart", resume, { once: true });
}
