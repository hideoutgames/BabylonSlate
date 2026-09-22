import { componentCount, convertMaterialValue } from "./types";
import {
  lowerMaterialDocument,
  type MaterialBuildPlan,
  type MaterialOperand,
} from "./lower";
import type { MaterialDocument } from "./document";
import type { MaterialValidationContext } from "./validate";

export interface BakeDiffuseClosure {
  kind: "diffuse";
  albedo: [number, number, number];
  emission: [number, number, number];
  /** Fully lowered semantic graph identity, including nested function bodies. */
  planHash: string;
  /** Owned semantic inputs for collision-resistant bake hashing, beyond the renderer's short cache key. */
  resolvedPlan: MaterialBuildPlan;
  dependencies: string[];
}

/** Restricted diffuse transport closure; unsupported authored behavior is never silently approximated. */
export function resolveBakeDiffuseClosure(
  document: MaterialDocument,
  context: MaterialValidationContext = {},
): BakeDiffuseClosure {
  if (document.nodes.length > 1024)
    throw new Error("Bake Material exceeds 1024 nodes.");
  const functions = Object.values(context.functions ?? {});
  if (
    functions.length > 128 ||
    functions.reduce((count, fn) => count + fn.nodes.length, 0) > 4096
  )
    throw new Error(
      "Bake Material Function closure exceeds its admitted size.",
    );
  const lowered = lowerMaterialDocument(document, context);
  if (!lowered.ok)
    throw new Error(
      `Bake Material is invalid: ${lowered.diagnostics.map((entry) => entry.message).join("; ")}`,
    );
  const plan = lowered.plan;
  if (
    plan.domain !== "surface" ||
    plan.shadingModel !== "pbr" ||
    plan.blendMode !== "opaque" ||
    !plan.twoSided
  )
    throw new Error(
      "Bake Material currently requires an opaque, two-sided PBR diffuse surface.",
    );
  if (plan.outputs.normal || (plan.boundsPadding ?? 0) !== 0)
    throw new Error(
      "Bake Material cannot currently evaluate authored normals or deformation.",
    );
  const values = new Map<string, number[]>();
  for (const operation of plan.operations) {
    if (!/^const\.(float|vec2|vec3|vec4|color)$/.test(operation.nodeType))
      throw new Error(
        `Bake Material node ${operation.source.nodeId} (${operation.nodeType}) needs a supported transport closure.`,
      );
    const value = operation.properties.value;
    const size = componentCount(operation.resolvedType);
    if (
      !Array.isArray(value) ||
      value.length !== size ||
      value.some(
        (entry) => typeof entry !== "number" || !Number.isFinite(entry),
      )
    )
      throw new Error(
        `Bake Material constant ${operation.source.nodeId} is invalid.`,
      );
    values.set(operation.id, [...value]);
  }
  const evaluate = (
    operand: MaterialOperand | null | undefined,
    fallback: number[],
  ): number[] => {
    if (!operand) return fallback;
    if (operand.kind === "constant") return [...operand.value];
    const value = values.get(operand.operationId);
    if (!value) throw new Error("Bake Material has an unresolved constant.");
    return (operand.conversions ?? []).reduce(convertMaterialValue, [...value]);
  };
  const equal = (name: string, value: number[]) => {
    const actual = evaluate(plan.outputs[name], value);
    if (
      actual.length !== value.length ||
      actual.some((entry, index) => entry !== value[index])
    )
      throw new Error(
        `Bake Material ${name} is outside the supported diffuse closure.`,
      );
  };
  equal("metallic", [0]);
  equal("opacity", [1]);
  equal("worldPositionOffset", [0, 0, 0]);
  if (plan.outputs.alphaClip)
    throw new Error("Bake Material cannot currently evaluate Alpha Clip.");
  const rgb = (name: string, maximum: number): [number, number, number] => {
    const value = evaluate(plan.outputs[name], [0, 0, 0]);
    if (
      value.length !== 3 ||
      value.some(
        (entry) => !Number.isFinite(entry) || entry < 0 || entry > maximum,
      )
    )
      throw new Error(
        `Bake Material ${name} must be a constant RGB value in 0..${maximum}.`,
      );
    return value as [number, number, number];
  };
  return {
    kind: "diffuse",
    albedo: rgb("baseColor", 1),
    emission: rgb("emissive", 100),
    planHash: plan.hash,
    resolvedPlan: structuredClone(plan),
    dependencies: [
      ...plan.dependencies.functions,
      ...plan.dependencies.textures,
    ].sort(),
  };
}
