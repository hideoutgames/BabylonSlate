import { describe, expect, it } from "vitest";
import {
  resolveGraphMountViewport,
  resolveGraphViewport,
} from "./graph-viewport";

describe("resolveGraphViewport", () => {
  it("uses a provided default zoom for the viewport and fitView cap", () => {
    const viewport = resolveGraphViewport(0.8);
    expect(viewport.defaultViewport.zoom).toBe(0.8);
    expect(viewport.fitViewOptions.maxZoom).toBe(0.8);
  });

  it("caps focused-node fitView at the default zoom, not 1.2", () => {
    const viewport = resolveGraphViewport();
    expect(viewport.focusedFitViewOptions).toEqual({
      padding: 0.35,
      duration: 250,
      maxZoom: 0.5,
    });
    expect(viewport.focusedFitViewOptions.maxZoom).not.toBe(1.2);
  });

  it("uses a provided default zoom for focused-node fitView", () => {
    const viewport = resolveGraphViewport(0.8);
    expect(viewport.focusedFitViewOptions.maxZoom).toBe(0.8);
    expect(viewport.focusedFitViewOptions.padding).toBe(0.35);
    expect(viewport.focusedFitViewOptions.duration).toBe(250);
  });
});

describe("resolveGraphMountViewport", () => {
  it("fits the graph on mount when no session pose exists", () => {
    const graphViewport = resolveGraphViewport();
    expect(resolveGraphMountViewport(null, graphViewport)).toEqual({
      fitView: true,
      defaultViewport: graphViewport.defaultViewport,
    });
  });

  it("skips mount fitView when a session pose exists", () => {
    const graphViewport = resolveGraphViewport();
    const session = { x: 40, y: -12, zoom: 0.8 };
    expect(resolveGraphMountViewport(session, graphViewport)).toEqual({
      fitView: false,
      defaultViewport: session,
    });
  });
});
