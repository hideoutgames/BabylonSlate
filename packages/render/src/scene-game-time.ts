import { GPUParticleSystem, ParticleSystem, PrecisionDate, type Scene } from "@babylonjs/core";

interface SceneGameClock {
  pausedAt: number | null;
  pausedMilliseconds: number;
}
const clocks = new WeakMap<Scene, SceneGameClock>();

/** No observer or clock allocation until an owner actually pauses this Scene. */
export function setSceneGameTimePaused(scene: Scene, paused: boolean): void {
  let clock = clocks.get(scene);
  if (!clock) {
    if (!paused) return;
    clock = { pausedAt: PrecisionDate.Now, pausedMilliseconds: 0 };
    clocks.set(scene, clock);
    return;
  }
  if (paused === (clock.pausedAt !== null)) return;
  const now = PrecisionDate.Now;
  if (paused) clock.pausedAt = now;
  else {
    clock.pausedMilliseconds += Math.max(0, now - clock.pausedAt!);
    clock.pausedAt = null;
    // Babylon 9.20 Animatable uses wall time independently of Engine delta.
    // Reset its existing clock so resuming never consumes the paused interval.
    if (scene._animationTimeLast) scene._animationTimeLast = now;
  }
}

export function isSceneGameTimePaused(scene: Scene): boolean {
  const clock = clocks.get(scene);
  return clock !== undefined && clock.pausedAt !== null;
}

/** PrecisionDate domain, with paused intervals removed; compatible with Engine.startTime. */
export function sceneGameTimeNow(scene: Scene): number {
  const clock = clocks.get(scene);
  return clock ? (clock.pausedAt ?? PrecisionDate.Now) - clock.pausedMilliseconds : PrecisionDate.Now;
}

/** Capability validation runs only for an explicitly requested paused redraw. */
export function pausedSceneRedrawIssue(scene: Scene): string | undefined {
  if (!isSceneGameTimePaused(scene)) return;
  for (const system of scene.particleSystems) {
    if (!system.isStarted()) continue;
    if (!((system instanceof ParticleSystem || system instanceof GPUParticleSystem) && system.paused))
      return `Paused redraw is unavailable for particle system "${system.name}" (${system.getClassName()}).`;
  }
}

/** Internal draw boundary shared by FrameGraph and native fallback. */
export function renderSceneWithGameTime(scene: Scene, updateCameras = true): void {
  const issue = pausedSceneRedrawIssue(scene);
  if (issue) throw new Error(issue);
  const paused = isSceneGameTimePaused(scene);
  scene.render(updateCameras, paused, paused);
}
