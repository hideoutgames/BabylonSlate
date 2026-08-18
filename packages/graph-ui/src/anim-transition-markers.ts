import { MarkerType } from "@xyflow/react";

export const ANIM_TRANSITION_ARROW = { type: MarkerType.ArrowClosed } as const;

export function animTransitionEdgeMarkers(edgeType: string | undefined): {
  markerEnd?: typeof ANIM_TRANSITION_ARROW;
  markerStart?: typeof ANIM_TRANSITION_ARROW;
} {
  const both = edgeType === "animTransitionBoth";
  const directed = both || edgeType === "animTransition";
  return {
    ...(directed ? { markerEnd: ANIM_TRANSITION_ARROW } : {}),
    ...(both ? { markerStart: ANIM_TRANSITION_ARROW } : {}),
  };
}
