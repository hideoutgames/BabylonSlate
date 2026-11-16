import type { Scene } from "@babylonjs/core/scene";
import { enterDrawPass, leaveDrawPass } from "./draw-passes";

type Animatable = { animate(preWarm?: boolean): void };

/** Systems whose `animate` already runs as the `particles` pass; a system is wrapped once, whichever view found it. */
const timed = new WeakSet<object>();

/**
 * Makes each particle system of `scene` that has not been seen run its `animate` as the `particles` pass
 * (`draw-passes.ts`). Babylon animates CPU particles inside `Scene.render`, between the world matrices and the graph's
 * first task, with no observable around them, so each system's own call is the only place to bracket them. The wrapper
 * is made once per system and allocates nothing per frame; outside a view's attributed frame it only calls through.
 * A sweep per frame is a `WeakSet` lookup per system, and finds a system added after the Scene's own (deferred)
 * announcement.
 */
export function timeParticleAnimation(scene: Scene): void {
  const systems = scene.particleSystems;
  for (let index = 0; index < systems.length; index += 1) {
    const system = systems[index]! as unknown as Animatable;
    if (timed.has(system)) continue;
    timed.add(system);
    const animate = system.animate;
    const engine = scene.getEngine();
    system.animate = function (this: Animatable, preWarm?: boolean) {
      enterDrawPass(engine, "particles");
      try {
        animate.call(this, preWarm);
      } finally {
        leaveDrawPass(engine);
      }
    };
  }
}
