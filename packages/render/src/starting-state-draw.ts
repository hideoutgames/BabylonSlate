import type { Effect, Scene } from "@babylonjs/core";
import { DriverCompileWatch } from "./driver-compile";

/**
 * The starting state's draw times out after this long without drawing everything, unless a shader finished meanwhile:
 * compile progress grants another budget (as loading waits renew), within `STARTING_STATE_CEILING_MS`.
 */
export const STARTING_STATE_DRAW_MS = 10_000;
/**
 * The draw ends this long after its first frame, whatever remains, and the loading frames then present: it leaves room
 * inside the first presentation's own compile watch (`SCENE_PREPARATION_CEILING_MS`, 300 s).
 */
export const STARTING_STATE_CEILING_MS = 120_000;

export interface StartingStateDraw {
  /** It has drawn everything (or ended), and a loading frame has followed. */
  readonly done: boolean;
  /**
   * A loading frame in which the view is ready to draw: draws with `draw` (true once it drew) while the meshes hold an
   * Effect no frame of this draw drew, and, after its first draw, waits for `settled`.
   */
  frame(draw: () => boolean): void;
  /** Ends a draw that has waited `STARTING_STATE_DRAW_MS` without compile progress, or reached its ceiling. */
  check(): void;
  /** Ends it (a superseded load). */
  cancel(): void;
  /** Releases the Effects it keeps compiled (a new world load: Play keeps one Scene across its loads). */
  release(): void;
}

/** Draws with every enabled, visible mesh selected, as Babylon's cull task does under `skipFrustumClipping`. */
function withoutViewCulling(scene: Scene, draw: () => boolean): boolean {
  const skipped = scene.skipFrustumClipping;
  scene.skipFrustumClipping = true;
  try {
    return draw();
  } finally {
    scene.skipFrustumClipping = skipped;
  }
}

/**
 * Keeps every Effect the meshes of `scene` draw with, in any pass, compiled until it is released (one reference each;
 * also released when the scene is disposed). Babylon releases an Effect, its program and its WebGPU pipelines, once the
 * last draw wrapper using it is disposed: a shadow map that stops disposes its casters' depth wrappers, so starting it
 * again would compile them anew mid-game. `hold` retains the Effects the meshes hold now and returns them.
 */
function effectRetainer(scene: Scene): { hold(): Set<Effect>; release(): void } {
  const retained = new Set<Effect>();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    scene.onDisposeObservable.remove(disposed);
    for (const effect of retained) effect.dispose();
    retained.clear();
  };
  const disposed = scene.onDisposeObservable.addOnce(release);
  return {
    hold() {
      const held = new Set<Effect>();
      if (scene.isDisposed) return held;
      // Instances share their source's submeshes.
      const seen = new Set<object>();
      for (const mesh of scene.meshes) {
        for (const subMesh of mesh.subMeshes ?? []) {
          if (seen.has(subMesh)) continue;
          seen.add(subMesh);
          for (const wrapper of subMesh._drawWrappers) {
            const effect = wrapper?.effect;
            if (!effect || effect.isDisposed) continue;
            held.add(effect);
            if (released || retained.has(effect)) continue;
            effect._refCount += 1;
            retained.add(effect);
          }
        }
      }
      return held;
    },
    release,
  };
}

/**
 * Draws a loaded Play scene's starting state behind its loading screen, before the first presented frame, without view
 * culling (Play's world Scene culls by view: `play-view-culling.ts`): every enabled, visible mesh, a mesh outside the
 * starting view included, has its program's first use (WebGL2) or its render pipelines (WebGPU) here rather than when
 * gameplay first shows it. Frames draw while the meshes hold an Effect no frame of this draw drew (a draw's post-draw
 * probe can ask for more, which the next ready frame draws); after the first, they wait for `settled` (the views it
 * created, such as a Full Quality capture's, have prepared). Its Effects stay compiled until `release`.
 *
 * `draws` says whether there is a reason to draw: the caller passes true when the Scene holds a light or Play may spawn
 * one, when a particle component is to play (its unstarted systems draw their programs in these frames), or when the
 * spawn warm-up staged meshes for it (shown only until it has drawn, `onDrawn`; on WebGL2 a program's
 * first draw holds iPad WebKit and no probe sees it). Without one it draws no frame: an extra loading frame steps GPU
 * particles once more, which a paused Simulation's redraw shows. `onDrawn` runs once it has drawn, or when it ends
 * first, for the caller to remove the staged meshes.
 */
export function createStartingStateDraw(
  scene: Scene, settled: () => boolean, options: { draws: boolean; onDrawn?: () => void },
): StartingStateDraw {
  const engine = scene.getEngine();
  const effects = effectRetainer(scene);
  /** Effects the meshes held when a frame of this draw drew. */
  const drawnEffects = new WeakSet<Effect>();
  let onDrawn = options.onDrawn;
  const drawn = () => {
    const done = onDrawn;
    onDrawn = undefined;
    done?.();
  };
  let drawing = options.draws;
  let drew = false;
  let since = 0;
  let watch: DriverCompileWatch | undefined;
  let startedAt: number | undefined;
  let ended = !drawing;
  const end = () => {
    drawing = false;
    drawn();
    ended = true;
  };
  /** Draws when the meshes hold an Effect no frame of this draw drew (or `force`). */
  const drawUndrawn = (draw: () => boolean, force: boolean): "none" | "drew" | "waiting" => {
    const held = effects.hold();
    let undrawn = force;
    for (const effect of held) if (!drawnEffects.has(effect)) undrawn = true;
    if (!undrawn) return "none";
    if (!draw()) return "waiting";
    // Only what the meshes held as it drew, and was ready to: Effects its post-draw probe requested, or still
    // compiling (a capture's new override Material), draw in the next ready frame. A failed one never will.
    for (const effect of held) if (effect.isReady() || effect.getCompilationError()) drawnEffects.add(effect);
    return "drew";
  };
  return {
    get done() {
      return ended;
    },
    frame(viewDraw) {
      if (ended) return;
      if (startedAt === undefined) {
        startedAt = since = performance.now();
        watch = new DriverCompileWatch(engine, startedAt, STARTING_STATE_CEILING_MS);
      }
      if (drawing) {
        // Views the first draw created prepare on their own; wait for them without drawing.
        if (drew && !settled()) return;
        const result = drawUndrawn(() => withoutViewCulling(scene, viewDraw), !drew);
        if (result === "drew") drew = true;
        if (result !== "none") return;
      }
      end();
    },
    check() {
      if (ended || startedAt === undefined) return;
      const now = performance.now();
      if (now - startedAt >= STARTING_STATE_CEILING_MS) {
        end();
        return;
      }
      if (!drawing || now - since < STARTING_STATE_DRAW_MS) return;
      if (watch!.renew(now)) since = now;
      else {
        // It never settled: the next loading frame ends it as it is.
        drawing = false;
        drawn();
      }
    },
    cancel() {
      if (!ended) end();
    },
    release: effects.release,
  };
}
