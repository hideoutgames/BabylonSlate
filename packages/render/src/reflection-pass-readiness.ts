import type { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";

/** The meshes a reflection pass is known to draw with ready variants, and the Scene's readiness revision that holds for. */
type Whole = { revision: number; meshes: WeakSet<AbstractMesh> };
const wholes = new WeakMap<RenderTargetTexture, Whole>();

/**
 * Whether the reflection pass that just drew into `texture` left no mesh out. A draw skips a mesh whose variant for the
 * pass is not ready, so its owner redraws until one draw has drawn them all. Asking the target
 * (`isReadyForRendering`) asks every listed mesh for its Material's readiness, which each draw of a moving view paid
 * again. Instead: the meshes a whole draw drew stay ready until something marks the Scene's readiness
 * (`sceneReadinessRevision`, read by the caller before the draw as `revision`), so a draw that lists only such meshes is
 * whole without asking. A mesh new to the pass, a marked Scene, or a target that lists every mesh of the Scene asks.
 * `drewWhole`: the caller already asked before this draw, and every mesh was ready.
 */
export function reflectionDrewWhole(texture: RenderTargetTexture, revision: number, drewWhole: boolean): boolean {
  const list = texture.renderList;
  let whole = wholes.get(texture);
  let complete = drewWhole;
  if (!complete && list && whole?.revision === revision) {
    complete = true;
    for (let index = 0; index < list.length; index += 1) {
      if (whole.meshes.has(list[index]!)) continue;
      complete = false;
      break;
    }
  }
  if (!complete) complete = texture.isReadyForRendering();
  if (complete && list) {
    if (!whole || whole.revision !== revision) wholes.set(texture, (whole = { revision, meshes: new WeakSet() }));
    for (let index = 0; index < list.length; index += 1) whole.meshes.add(list[index]!);
  }
  return complete;
}
