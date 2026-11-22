import { Constants } from "@babylonjs/core/Engines/constants";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Material } from "@babylonjs/core/Materials/material";
import type { Scene } from "@babylonjs/core/scene";

/**
 * How a Scene Layer's Scene reaches the screen. A direct layer draws straight onto what is beneath it (the world and
 * lower layers). A targeted layer (an enabled post-process stack with post-processing on) draws into its own target
 * cleared to (0, 0, 0, 0), which its blit composites over what is beneath as premultiplied colour and coverage
 * (`ALPHA_PREMULTIPLIED`: colour + (1 − coverage) × beneath). Only the compositor sets it (`SceneLayerCompositor`);
 * every other Scene, the editor's Scene Layer tab included, is direct.
 */
const targetedScenes = new WeakSet<Scene>();

export function isTargetedLayerScene(scene: Scene | null | undefined): boolean {
  return !!scene && targetedScenes.has(scene);
}

export function setTargetedLayerScene(scene: Scene, targeted: boolean): void {
  if (targeted) targetedScenes.add(scene);
  else targetedScenes.delete(scene);
}

/**
 * A Multiply visual's blend on its Scene: on a direct layer destination × source (`ALPHA_MULTIPLY`; the source's alpha
 * is 0, so the destination's alpha is kept); on a targeted layer the premultiplied over of a source (0, 0, 0, 1 − g)
 * (`ALPHA_PREMULTIPLIED_PORTERDUFF`), which multiplies the target's colour and what shows through it by the grey g.
 * The source each writes is `LayerMultiplyBlock`'s.
 */
export function layerMultiplyAlphaMode(targeted: boolean): number {
  return targeted ? Constants.ALPHA_PREMULTIPLIED_PORTERDUFF : Constants.ALPHA_MULTIPLY;
}

/**
 * Makes a Multiply Material's alpha mode follow its Scene's layer kind at every draw, so a layer that changes between
 * direct and targeted (its stack, or the post-processing switch) blends it correctly without a recompile or a walk of
 * its Materials. A mesh draws with `alphaMode` (one render target); writes are ignored: the kind decides.
 */
export function followLayerMultiplyAlphaMode(material: Material): void {
  const scene = material.getScene();
  Object.defineProperty(material, "alphaMode", {
    configurable: true,
    enumerable: true,
    get: () => layerMultiplyAlphaMode(targetedScenes.has(scene)),
    set: () => {},
  });
}

/** Engines whose `setAlphaMode` premultiplies a targeted layer's ordinary blending, and whether it does now. */
const premultiplying = new WeakMap<AbstractEngine, { active: boolean }>();

/**
 * While a targeted layer draws its content, ordinary alpha blending (`ALPHA_COMBINE`: colour by source alpha, alpha
 * added) blends as `ALPHA_LAYER_ACCUMULATE` (the same colour, alpha = a + (1 − a) × beneath), so the target holds
 * premultiplied colour and its true coverage for the premultiplied blit. Additive (`ALPHA_ADD`) already adds colour and
 * keeps coverage; every other mode is left as it is. Bracket the draw with `endPremultipliedLayerContent`.
 */
export function beginPremultipliedLayerContent(engine: AbstractEngine): void {
  let state = premultiplying.get(engine);
  if (!state) {
    const current = { active: false };
    state = current;
    premultiplying.set(engine, current);
    const setAlphaMode = engine.setAlphaMode;
    engine.setAlphaMode = function (this: AbstractEngine, mode: number, noDepthWriteChange?: boolean, targetIndex?: number): void {
      setAlphaMode.call(this, current.active && mode === Constants.ALPHA_COMBINE ? Constants.ALPHA_LAYER_ACCUMULATE : mode, noDepthWriteChange, targetIndex);
    };
  }
  state.active = true;
}

export function endPremultipliedLayerContent(engine: AbstractEngine): void {
  const state = premultiplying.get(engine);
  if (state) state.active = false;
}
