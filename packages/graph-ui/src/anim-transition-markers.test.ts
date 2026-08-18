import { MarkerType } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { animTransitionEdgeMarkers } from "./anim-transition-markers";

describe("animTransitionEdgeMarkers", () => {
  it("puts a closed arrow on the target of a one-way transition", () => {
    expect(animTransitionEdgeMarkers("animTransition")).toEqual({
      markerEnd: { type: MarkerType.ArrowClosed },
    });
  });

  it("puts closed arrows on both ends of a both-ways transition", () => {
    expect(animTransitionEdgeMarkers("animTransitionBoth")).toEqual({
      markerEnd: { type: MarkerType.ArrowClosed },
      markerStart: { type: MarkerType.ArrowClosed },
    });
  });

  it("does not mark a non-anim edge", () => {
    expect(animTransitionEdgeMarkers("default")).toEqual({});
  });
});
