import { collisionPairResponse, type CollisionResponse } from "@haptic/core";
import type { ColliderDesc } from "./types";

/**
 * What two colliders do: the weaker of their responses to each other's
 * layer (`mask` blocks, `overlapMask` overlaps). A trigger on either side
 * turns Block into Overlap.
 */
export function colliderPairResponse(
  a: Pick<ColliderDesc, "layer" | "mask" | "overlapMask" | "isTrigger">,
  b: Pick<ColliderDesc, "layer" | "mask" | "overlapMask" | "isTrigger">,
): CollisionResponse {
  const response = collisionPairResponse(
    { layer: a.layer, mask: a.mask, overlapMask: a.overlapMask ?? 0 },
    { layer: b.layer, mask: b.mask, overlapMask: b.overlapMask ?? 0 },
  );
  return response === "block" && (a.isTrigger || b.isTrigger) ? "overlap" : response;
}
