import type { MaterialBuildPlan, MaterialDocument } from "@babylonslate/shader-graph";
import type { MaterialLibrary } from "./material-library";
import { normalizePostProcessStack, type PostProcessStackDiagnostic, type PostProcessStackEntry } from "./post-process-material";

export interface PreparedScenePostProcessEntry {
  entry: PostProcessStackEntry;
  document: MaterialDocument;
  plan: MaterialBuildPlan;
}

/** Immutable input snapshot for one owner-controlled graph preparation. */
export interface ScenePostProcessPlan {
  entries: PreparedScenePostProcessEntry[];
  buffers: { sceneDepth: boolean; sceneNormal: boolean };
  diagnostics: PostProcessStackDiagnostic[];
}

/**
 * Resolve enabled consumers before allocating scene color or geometry targets.
 * Rejected passes are isolated; they cannot request resources for a valid sibling.
 */
export function prepareScenePostProcessPlan(
  library: MaterialLibrary,
  stack: readonly PostProcessStackEntry[],
  documentFor: (guid: string) => MaterialDocument | null,
): ScenePostProcessPlan {
  const result: ScenePostProcessPlan = {
    entries: [], buffers: { sceneDepth: false, sceneNormal: false }, diagnostics: [],
  };
  for (const entry of normalizePostProcessStack(stack)) {
    if (!entry.enabled) continue;
    const source = documentFor(entry.materialGuid);
    if (!source || source.domain !== "postProcess") {
      result.diagnostics.push({ materialGuid: entry.materialGuid, code: "material.framegraph.domain",
        message: source ? "Material is not a Post Process material" : "Post-process material is missing" });
      continue;
    }
    const document = structuredClone(source);
    const lowered = library.planFor(document);
    if (lowered.ok === false) {
      result.diagnostics.push(...lowered.diagnostics.map((diagnostic) => ({
        ...diagnostic, materialGuid: entry.materialGuid,
      })));
      continue;
    }
    result.entries.push({ entry, document, plan: lowered.plan });
    result.buffers.sceneDepth ||= lowered.plan.bufferRequirements.sceneDepth;
    result.buffers.sceneNormal ||= lowered.plan.bufferRequirements.sceneNormal;
  }
  return result;
}
