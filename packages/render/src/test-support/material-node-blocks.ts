import { lowerMaterialDocument, type MaterialDocument, type MaterialFunctionDocument } from "@haptic/shader-graph";
import { materialOperationBlockName } from "../material-compiler";

/**
 * The name the compiler gives the block realizing `nodeId` of `doc` (`materialOperationBlockName`: its plan position,
 * never its id). `nodeId` is the operation id: a node of a called Material Function is `callId/innerId`.
 */
export function nodeBlockName(doc: MaterialDocument, nodeId: string, functions: Record<string, MaterialFunctionDocument> = {}): string {
  const lowered = lowerMaterialDocument(doc, { functions });
  if (!lowered.ok) throw new Error(`lowering failed: ${lowered.diagnostics.map((row) => row.code).join(", ")}`);
  const index = lowered.plan.operations.findIndex((operation) => operation.id === nodeId);
  if (index < 0) throw new Error(`No operation realizes node "${nodeId}"`);
  return materialOperationBlockName(index);
}
