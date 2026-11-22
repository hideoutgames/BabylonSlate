import type { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import type { Scene } from "@babylonjs/core/scene";
import { createWaterMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { compileMaterialPlan, type CompiledMaterial } from "./material-compiler";
import { replaceSceneMaterial } from "./material-library";
import { markBuiltInWaterMaterial } from "./water-mesh";

const templates = new WeakMap<Scene, CompiledMaterial>();

function compileBuiltInWater(scene: Scene): CompiledMaterial {
  const lowered = lowerMaterialDocument(createWaterMaterialDocument("Water"));
  if (!lowered.ok) throw new Error("The built-in water Material did not lower.");
  const compiled = compileMaterialPlan(lowered.plan, { scene, name: "Built-in Water" });
  if (!compiled.ok) throw new Error("The built-in water Material did not compile.");
  markBuiltInWaterMaterial(compiled.material);
  return compiled;
}

/**
 * The graph Material built-in water draws with, on the light block. It is the water starter
 * (`createWaterMaterialDocument`, what Edit As Material creates), compiled once per Scene and shared by every water
 * mesh without a Custom Material: each mesh's asset, terrain, contacts and blend reach the water nodes through its own
 * `WaterNodeSurface`, and its variants through its own draw wrappers. Disposed with the Scene.
 */
export function builtInWaterMaterial(scene: Scene): NodeMaterial {
  const existing = templates.get(scene);
  if (existing) return existing.material;
  const compiled = compileBuiltInWater(scene);
  templates.set(scene, compiled);
  scene.onDisposeObservable.addOnce(() => templates.get(scene)?.dispose());
  return compiled.material;
}

/**
 * Compiles `scene`'s built-in water Material again after a change to how the Scene compiles Materials (`worlddebug
 * materialrecords`): once the new build is ready its water meshes move to it (each draws its water variant, built on
 * its first draw) and the old one is disposed.
 */
export function recompileBuiltInWaterMaterial(scene: Scene): Promise<void> {
  // One at a time, so the last switch decides the build that stays.
  const run = (recompiles.get(scene) ?? Promise.resolve()).then(async () => {
    const previous = templates.get(scene);
    if (!previous || scene.isDisposed) return;
    const next = compileBuiltInWater(scene);
    if (!await replaceSceneMaterial(scene, previous.material, next.material, () => false)) {
      next.dispose();
      return;
    }
    templates.set(scene, next);
    previous.dispose();
  });
  recompiles.set(scene, run);
  return run;
}

const recompiles = new WeakMap<Scene, Promise<void>>();
