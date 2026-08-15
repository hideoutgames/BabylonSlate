import { drawCallCeilingWarning } from "@babylonslate/render";

export function mountPlayerHud(
  element: HTMLElement,
  options: { bundleDebugger: boolean },
): {
  setStats: (stats: {
    ticks: number;
    fps: number;
    scriptMs: number;
    physicsMs: number;
    draws: number;
  }) => void;
} {
  if (!options.bundleDebugger) {
    element.hidden = true;
    return { setStats: () => {} };
  }
  element.hidden = false;
  const setStats = (stats: {
    ticks: number;
    fps: number;
    scriptMs: number;
    physicsMs: number;
    draws: number;
  }) => {
    const warn = drawCallCeilingWarning(stats.draws);
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
