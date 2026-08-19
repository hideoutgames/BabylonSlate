import { diagnostic, type Diagnostic } from "@babylonslate/scripting";
import {
  physicsActorsDiagnostics,
  type PhysicsActorLike,
} from "@babylonslate/physics";

export function physicsPairingDiagnostics(
  actors: readonly PhysicsActorLike[],
  options: { assetGuid: string; graphId: string },
): Diagnostic[] {
  return physicsActorsDiagnostics(actors).map((warning) =>
    diagnostic({
      severity: warning.severity,
      code: warning.code,
      message: warning.message,
      assetGuid: options.assetGuid,
      graphId: options.graphId,
      actorId: warning.actorId,
      componentId: warning.componentId,
    }),
  );
}
