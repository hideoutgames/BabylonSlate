import { shearedActorIds, type SerializedActor } from "@babylonslate/core";
import { diagnostic, type Diagnostic } from "@babylonslate/scripting";

const SHEARED_TRANSFORM =
  "Sheared world transform: nonuniform parent scale with an oblique rotation. " +
  "Play shows the nearest rotation and scale, and physics rejects sheared actors.";

/** Non-blocking warnings for attached actors whose authored world transform is sheared. */
export function actorTransformDiagnostics(
  actors: readonly SerializedActor[],
  options: { assetGuid: string; graphId: string },
): Diagnostic[] {
  return shearedActorIds(actors).map((actorId) =>
    diagnostic({
      severity: "warning",
      code: "scene.sheared_actor_transform",
      message: SHEARED_TRANSFORM,
      assetGuid: options.assetGuid,
      graphId: options.graphId,
      actorId,
    }),
  );
}
