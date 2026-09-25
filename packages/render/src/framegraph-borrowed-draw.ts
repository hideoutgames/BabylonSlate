import type { RenderTargetTexture, Scene } from "@babylonjs/core";

/** Per-owner restoration and failure policy for one borrowed RTT draw. */
export type BorrowedDrawPolicy = {
  /** Also restore the caller's alpha mode and equation. */
  restoreAlpha: boolean;
  /** Wrap a draw failure even when every restoration step succeeded. */
  wrapDrawFailure: boolean;
  message: string;
};

/** Run one restoration step, collecting its failure without masking others. */
function attempt(errors: unknown[], action: () => void): void {
  try {
    action();
  } catch (error) {
    errors.push(error);
  }
}

/**
 * Draws an RTT the graph borrows but does not own. Babylon 9.20's
 * renderUnmanaged lacks finally, so restore the caller's target, scene and
 * depth state even when `draw` throws; never mask the original failure.
 */
export function drawBorrowedTarget(
  scene: Scene,
  map: RenderTargetTexture,
  draw: () => void,
  policy: BorrowedDrawPolicy,
): void {
  const engine = scene.getEngine();
  const target = engine._currentRenderTarget;
  const intermediate = scene._intermediateRendering;
  const stages = map._disableEngineStages;
  const depthTest = engine.getDepthBuffer();
  const depthWrite = engine.getDepthWrite();
  // Babylon uses -1 after a cache reset while alphaState is disabled.
  // Passing that sentinel back to setAlphaMode enables stale additive blend.
  const alpha = policy.restoreAlpha ? Math.max(0, engine.getAlphaMode()) : 0;
  const equation = policy.restoreAlpha ? engine.getAlphaEquation() : -1;
  let failed = false;
  let failure: unknown;
  const errors: unknown[] = [];
  try {
    // Same pinned RTT stage switch as the official shadow task, borrowed
    // only for this draw so classic rendering retains its original state.
    map._disableEngineStages = true;
    draw();
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    attempt(errors, () => {
      map._disableEngineStages = stages;
    });
    attempt(errors, () => {
      scene._intermediateRendering = intermediate;
    });
    if (policy.restoreAlpha) {
      attempt(errors, () => engine.setAlphaMode(alpha, true));
      if (equation >= 0) attempt(errors, () => engine.setAlphaEquation(equation));
    }
    attempt(errors, () => engine.setDepthBuffer(depthTest));
    attempt(errors, () => engine.setDepthWrite(depthWrite));
    attempt(errors, () => {
      if (engine._currentRenderTarget !== target) {
        if (target) engine.bindFramebuffer(target);
        else engine.restoreDefaultFramebuffer(true);
      }
    });
  }
  if (errors.length || (failed && policy.wrapDrawFailure))
    throw new AggregateError(
      failed ? [failure, ...errors] : errors,
      policy.message,
    );
  if (failed) throw failure;
}
