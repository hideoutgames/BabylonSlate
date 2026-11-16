import type { GlobalParameterCatalog } from "@haptic/core";
import type { GraphDocument } from "@haptic/graph-ui";
import { hydrateParticleGraphForEditor, normalizeParticleGraphDocument, particleGraphToSerialized } from "@haptic/particle-graph";

/**
 * One stored version of a Particle Graph as its graph editor draws it, for
 * the Diff window: Parameter nodes titled by that version's Parameters.
 */
export function particleDiffGraph(stored: unknown, globalParameters?: Readonly<GlobalParameterCatalog>): GraphDocument {
  const document = normalizeParticleGraphDocument(stored);
  return hydrateParticleGraphForEditor(particleGraphToSerialized(document), document.parameters, globalParameters);
}
