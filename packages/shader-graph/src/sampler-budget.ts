import type { MaterialBuildPlan } from "./lower";
import type { MaterialDiagnostic } from "./validate";

/** Samplers a lit surface binds for scene environment lighting: the reflection cube and the BRDF lookup. */
const LIT_ENVIRONMENT_SAMPLERS = 2;

/** Nodes that bind a sampler of their own each time they appear. */
const SAMPLER_NODES = new Set([
  "param.texture",
  "input.sceneColor",
  "input.sceneDepth",
  "input.sceneNormal",
  "input.environmentSample",
]);

/**
 * Samplers the water nodes bind, shared by every water node that reads them: the spectrum and its turbulence, the
 * terrain and contact fields, the view's scene copy and the environment cube.
 */
const WATER_NODE_SAMPLERS: Readonly<Record<string, readonly string[]>> = {
  "input.waterWaves": ["spectrum", "turbulence"],
  "input.waterFoam": ["terrain", "contacts"],
  "input.waterDepthFade": ["terrain", "contacts", "sceneCopy"],
  "input.waterSceneColor": ["sceneCopy"],
  "input.waterReflection": ["sceneCopy", "environment"],
};

/** Whether the plan's surface takes scene lights, so a fixed light layout shares its samplers. */
export function materialPlanIsLit(plan: MaterialBuildPlan): boolean {
  return (plan.domain === "surface" || plan.domain === "landscape") && plan.shadingModel !== "unlit";
}

/**
 * Texture samplers a lowered Material binds itself, each with the graph node
 * to focus (null for the lighting plumbing): one per Texture parameter, per
 * Sample Texture with its own Texture (a sample fed by a parameter shares the
 * parameter's), per scene buffer or environment sample node, each water
 * texture the water nodes share and, on a lit surface, the scene environment's
 * reflection cube and BRDF lookup.
 */
export function materialSamplerSources(plan: MaterialBuildPlan): (string | null)[] {
  const sources: (string | null)[] = [];
  if (materialPlanIsLit(plan)) for (let index = 0; index < LIT_ENVIRONMENT_SAMPLERS; index++) sources.push(null);
  const water = new Set<string>();
  for (const operation of plan.operations) {
    for (const sampler of WATER_NODE_SAMPLERS[operation.nodeType] ?? []) {
      if (water.has(sampler)) continue;
      water.add(sampler);
      sources.push(operation.source.callPath[0] ?? operation.source.nodeId);
    }
    const own =
      SAMPLER_NODES.has(operation.nodeType) ||
      ((operation.nodeType === "texture.sample" || operation.nodeType === "texture.sampleLod") && !operation.inputs.texture);
    if (own) sources.push(operation.source.callPath[0] ?? operation.source.nodeId);
  }
  return sources;
}

/**
 * A warning when a lit Material binds more samplers than `samplerBudget`, the
 * samplers fixed-shape lighting leaves a Material next to the shadow and area
 * light samplers every lit draw binds. Anchored to the first sampler over the
 * budget.
 */
export function materialSamplerBudgetDiagnostics(plan: MaterialBuildPlan, samplerBudget: number): MaterialDiagnostic[] {
  if (!materialPlanIsLit(plan)) return [];
  const sources = materialSamplerSources(plan);
  if (sources.length <= samplerBudget) return [];
  const nodeId = sources.slice(samplerBudget).find((source) => source !== null) ?? undefined;
  return [
    {
      code: "material.samplerBudget",
      message: `This lit Material binds ${sources.length} texture samplers (${LIT_ENVIRONMENT_SAMPLERS} for the scene environment); fixed-shape lighting leaves a lit Material ${samplerBudget} next to its shadow and area light samplers.`,
      severity: "warning",
      ...(nodeId ? { nodeId } : {}),
    },
  ];
}
