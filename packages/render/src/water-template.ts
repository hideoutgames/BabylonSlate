import type { NodeMaterial, Scene } from "@babylonjs/core";
import { createWaterMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { compileMaterialPlan } from "./material-compiler";
import { markBuiltInWaterMaterial } from "./water-mesh";

const templates = new WeakMap<Scene, NodeMaterial>();

/**
 * The graph Material built-in water draws with, on the lighting plan's block. It is the water starter
 * (`createWaterMaterialDocument`, what Edit As Material creates), compiled once per Scene and shared by every water
 * mesh without a Custom Material: each mesh's asset, terrain, contacts and blend reach the water nodes through its own
 * `WaterNodeSurface`, and its variants through its own draw wrappers. Disposed with the Scene.
 */
export function builtInWaterMaterial(scene: Scene): NodeMaterial {
  let material = templates.get(scene);
  if (material) return material;
  const lowered = lowerMaterialDocument(createWaterMaterialDocument("Water"));
  if (!lowered.ok) throw new Error("The built-in water Material did not lower.");
  const compiled = compileMaterialPlan(lowered.plan, { scene, name: "Built-in Water" });
  if (!compiled.ok) throw new Error("The built-in water Material did not compile.");
  material = compiled.material;
  markBuiltInWaterMaterial(material);
  templates.set(scene, material);
  scene.onDisposeObservable.addOnce(() => compiled.dispose());
  return material;
}
