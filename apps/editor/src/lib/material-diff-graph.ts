import type { GlobalParameterCatalog } from "@haptic/core";
import type { GraphDocument } from "@haptic/graph-ui";
import {
  hydrateMaterialGraphForEditor,
  materialGraphToSerialized,
  normalizeMaterialDocument,
  normalizeMaterialFunctionDocument,
} from "@haptic/shader-graph";

/**
 * One stored version of a Material or Material Function as its graph editor
 * draws it, for the Diff window: pins, types and titles hydrated as the
 * Material Graph window does. A Function Call node draws the pins of the
 * functions it is given; the diff gives none, so it draws its title alone.
 */
export function materialDiffGraph(stored: unknown, assetType: string, globalParameters?: Readonly<GlobalParameterCatalog>): GraphDocument {
  const context = globalParameters ? { globalParameters } : {};
  if (assetType === "MaterialFunction") {
    const document = normalizeMaterialFunctionDocument(stored);
    return hydrateMaterialGraphForEditor(materialGraphToSerialized(document), { ...context, functionInterface: document });
  }
  return hydrateMaterialGraphForEditor(materialGraphToSerialized(normalizeMaterialDocument(stored)), context);
}
