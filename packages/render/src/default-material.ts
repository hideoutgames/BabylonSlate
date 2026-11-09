import type { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import type { Material } from "@babylonjs/core/Materials/material";
import type { Scene } from "@babylonjs/core/scene";
import { GetEnvironmentBRDFTexture } from "@babylonjs/core/Misc/brdfTextureTools";
import {
  createDefaultMaterialDocument,
  lowerMaterialDocument,
  materialPinDefaultPropertyKey,
  type MaterialBuildPlan,
  type MaterialDocument,
  type MaterialGraphNode,
} from "@haptic/shader-graph";
import { compileMaterialPlan, type CompiledMaterial } from "./material-compiler";

const ENGINE_DEFAULT_MATERIAL_NAME = "engineDefaultMaterial";
/**
 * Checker cells per world unit. Quarter-unit cells fit the default primitives' sizes (1.5 box and plane, 10 ground)
 * at whole-unit positions, and the 2D grid's minor lines.
 */
export const ENGINE_DEFAULT_CHECKER_CELLS_PER_UNIT = 4;
/** The checker's greys in sRGB: a new surface Material's Base Color (0.8) and a slightly darker one. */
export const ENGINE_DEFAULT_CHECKER_GREYS = [204 / 255, 166 / 255] as const;
/** 0 in 3D; 1 in 2D, where the Material emits its checker. */
const ENGINE_DEFAULT_EMISSION_PARAMETER = "Emission";

/**
 * The Material that surfaces with no Material of their own draw with: a lit grey checker built from the same graph
 * nodes as an authored Material, so it lights, shades in CEL and Unlit viewport mode, and casts shadows as one does.
 *
 * The checker is world-aligned, not UV-mapped: square cells of a fixed world size, projected along each surface's
 * dominant world axis, so scaling a mesh never stretches them and neighbouring meshes' cells line up. A moving mesh
 * slides under its cells.
 */
export function engineDefaultMaterialDocument(): MaterialDocument {
  const doc = createDefaultMaterialDocument(ENGINE_DEFAULT_MATERIAL_NAME);
  const output = doc.nodes.find((node) => node.type === "output.surface")!;
  const nodes: MaterialGraphNode[] = [output];
  const edges: MaterialDocument["edges"] = [];
  const node = (id: string, type: string, properties: Record<string, unknown> = {}) =>
    nodes.push({ id, type, position: { x: nodes.length * 160 - 1600, y: 0 }, properties });
  const pin = (value: number) => [value];
  const wire = (source: string, sourcePin: string, target: string, targetPin: string) =>
    edges.push({ id: `e-${source}-${target}-${targetPin}`, sourceNodeId: source, sourcePinId: sourcePin, targetNodeId: target, targetPinId: targetPin });
  const [light, dark] = ENGINE_DEFAULT_CHECKER_GREYS;
  node("position", "input.worldPosition");
  node("cells", "math.multiply", { [materialPinDefaultPropertyKey("b")]: pin(ENGINE_DEFAULT_CHECKER_CELLS_PER_UNIT) });
  wire("position", "position", "cells", "a");
  node("cell", "math.floor");
  wire("cells", "out", "cell", "value");
  // One-hot dominant axis of the world normal (ties go to X, then Y). Dropping it leaves the two in-plane cell
  // indices, so a face lying on a cell boundary never flickers between cells.
  node("normal", "input.worldNormal");
  node("facing", "math.abs");
  wire("normal", "normal", "facing", "value");
  node("axes", "vector.split");
  wire("facing", "out", "axes", "value");
  node("acrossX", "math.max");
  wire("axes", "y", "acrossX", "a");
  wire("axes", "z", "acrossX", "b");
  node("alongX", "math.step");
  wire("acrossX", "out", "alongX", "edge");
  wire("axes", "x", "alongX", "value");
  node("yOverZ", "math.step");
  wire("axes", "z", "yOverZ", "edge");
  wire("axes", "y", "yOverZ", "value");
  node("notX", "math.subtract", { [materialPinDefaultPropertyKey("a")]: pin(1) });
  wire("alongX", "out", "notX", "b");
  node("alongY", "math.multiply");
  wire("yOverZ", "out", "alongY", "a");
  wire("notX", "out", "alongY", "b");
  node("alongZ", "math.subtract");
  wire("notX", "out", "alongZ", "a");
  wire("alongY", "out", "alongZ", "b");
  node("dominant", "vector.combine");
  wire("alongX", "out", "dominant", "x");
  wire("alongY", "out", "dominant", "y");
  wire("alongZ", "out", "dominant", "z");
  node("all", "const.vec3", { value: [1, 1, 1] });
  node("inPlane", "math.subtract");
  wire("all", "out", "inPlane", "a");
  wire("dominant", "xyz", "inPlane", "b");
  node("sum", "vector.dot");
  wire("cell", "out", "sum", "a");
  wire("inPlane", "out", "sum", "b");
  // fract(sum / 2) is 0 on even cells and 0.5 on odd ones, below zero too, in GLSL and WGSL alike.
  node("half", "math.multiply", { [materialPinDefaultPropertyKey("b")]: pin(0.5) });
  wire("sum", "out", "half", "a");
  node("fraction", "math.fract");
  wire("half", "out", "fraction", "value");
  node("odd", "math.step", { [materialPinDefaultPropertyKey("edge")]: pin(0.25) });
  wire("fraction", "out", "odd", "value");
  node("light", "const.color", { value: [light, light, light] });
  node("dark", "const.color", { value: [dark, dark, dark] });
  node("checker", "math.mix");
  wire("light", "out", "checker", "a");
  wire("dark", "out", "checker", "b");
  wire("odd", "out", "checker", "alpha");
  wire("checker", "out", "output", "baseColor");
  node("emission", "param.float", { name: ENGINE_DEFAULT_EMISSION_PARAMETER, value: [0] });
  node("glow", "math.multiply");
  wire("checker", "out", "glow", "a");
  wire("emission", "out", "glow", "b");
  wire("glow", "out", "output", "emissive");
  return { ...doc, nodes, edges };
}

let plan: MaterialBuildPlan | undefined;
const compiled = new WeakMap<Material, CompiledMaterial>();

function engineDefaultPlan(): MaterialBuildPlan {
  if (plan) return plan;
  const lowered = lowerMaterialDocument(engineDefaultMaterialDocument());
  if (!lowered.ok) throw new Error(`The engine default material does not lower: ${lowered.diagnostics.map((row) => row.message).join("; ")}`);
  return (plan = lowered.plan);
}

export function isEngineDefaultMaterial(material: Material | null | undefined): boolean {
  return !!material && compiled.has(material);
}

export function createEngineDefaultMaterial(scene: Scene): NodeMaterial {
  // The graph builds once its blocks' shader code has loaded, and only then creates the environment BRDF table every
  // lit Material samples. Creating the table now starts its decode with the Scene and keeps it out of later frames.
  GetEnvironmentBRDFTexture(scene);
  const result = compileMaterialPlan(engineDefaultPlan(), { scene, name: ENGINE_DEFAULT_MATERIAL_NAME });
  if (!result.ok) throw new Error(`The engine default material does not compile: ${result.diagnostics.map((row) => row.message).join("; ")}`);
  compiled.set(result.material, result);
  return result.material;
}

export function installEngineDefaultMaterial(scene: Scene): Material {
  const existing = scene.materials.find(isEngineDefaultMaterial);
  if (existing) {
    scene.defaultMaterial = existing;
    return existing;
  }
  const material = createEngineDefaultMaterial(scene);
  scene.defaultMaterial = material;
  return material;
}

/**
 * 2D scenes ship without lights, so a material-less primitive drawn with the lit default would be black. In 2D the
 * default also emits its checker, a uniform that keeps it visible without touching the Unlit viewport mode; 3D stays
 * purely lit.
 */
export function syncEngineDefaultMaterialEmission(scene: Scene, emit: boolean): void {
  const material = scene.materials.find(isEngineDefaultMaterial);
  if (material) compiled.get(material)!.setParameter(ENGINE_DEFAULT_EMISSION_PARAMETER, { kind: "float", value: emit ? 1 : 0 });
}
