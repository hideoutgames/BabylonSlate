import { diagnostic, type Diagnostic } from "@haptic/scripting";
import { normalizeModelPayload, type AssetRegistry } from "@haptic/assets";
import {
  physicsActorsDiagnostics,
  type PhysicsActorLike,
  type PhysicsDiagnosticsContext,
} from "@haptic/physics";

/** Document kinds whose unsaved content decides a Model's simple collision shapes. */
export const MODEL_DOCUMENT_KINDS = ["model"] as const;

/**
 * Simple collision shape count of a Model by asset GUID, from its open (possibly unsaved)
 * document before its saved header. Anything that is not a known Model answers undefined,
 * so a missing asset is never reported as a Model without shapes.
 */
export function modelSimpleColliderCounter(
  registry: Pick<AssetRegistry, "getByGuid"> | null | undefined,
  openModels: readonly { ref: { path: string }; content: unknown }[] = [],
): (assetGuid: string) => number | undefined {
  return (assetGuid) => {
    const asset = registry?.getByGuid(assetGuid);
    if (!asset || asset.placeholder || asset.header.type !== "Model") return undefined;
    const open = openModels.find((doc) => doc.ref.path === asset.path);
    return normalizeModelPayload(open?.content ?? asset.header.payload ?? {}).simpleColliders.length;
  };
}

/**
 * Pairing warnings for `actors` as Compiler Results rows. Pass `physicsWorld` for a Scene; a Class
 * prefab can be placed in either world, so it omits it and the 2D Mesh collision check is skipped.
 */
export function physicsPairingDiagnostics(
  actors: readonly PhysicsActorLike[],
  options: { assetGuid: string; graphId: string } & PhysicsDiagnosticsContext,
): Diagnostic[] {
  const { assetGuid, graphId, ...context } = options;
  return physicsActorsDiagnostics(actors, context).map((warning) =>
    diagnostic({
      severity: warning.severity,
      code: warning.code,
      message: warning.message,
      assetGuid,
      graphId,
      actorId: warning.actorId,
      componentId: warning.componentId,
    }),
  );
}
