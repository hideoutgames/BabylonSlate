import { memo } from "react";
import type { SerializedActor } from "@haptic/core";
import { TypeVisualIcon, resolveActorTypeVisual, walkAncestry } from "@haptic/editor-kit";

/**
 * Type glyph of an actor row. The row carries the actor's data and the glyph
 * resolves when the row renders, so only the mounted window of a long
 * Outliner pays for ancestry walks, and an unchanged actor skips rendering.
 */
export const OutlinerActorIcon = memo(function OutlinerActorIcon({
  actorId,
  classId,
  components,
  parentOf,
}: {
  actorId: string;
  classId: string;
  components: SerializedActor["components"];
  parentOf: (id: string) => string | null;
}) {
  return (
    <TypeVisualIcon
      visual={resolveActorTypeVisual({
        classId,
        components,
        ancestry: walkAncestry(classId, parentOf),
      })}
      data-testid={`outliner-type-icon-${actorId}`}
    />
  );
});
