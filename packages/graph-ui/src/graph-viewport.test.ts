import { describe, expect, it } from "vitest";
import {
  GRAPH_DEFAULT_ZOOM,
  GRAPH_MAX_ZOOM,
  GRAPH_MIN_ZOOM,
  resolveGraphViewport,
} from "./graph-viewport";

describe("resolveGraphViewport", () => {
  it("defaults to zoom 0.5 with fitView capped at that zoom", () => {
    const viewport = resolveGraphViewport();
    expect(GRAPH_DEFAULT_ZOOM).toBe(0.5);
    expect(GRAPH_MIN_ZOOM).toBe(0.1);
    expect(GRAPH_MAX_ZOOM).toBe(1.5);
    expect(viewport.minZoom).toBe(0.1);
    expect(viewport.maxZoom).toBe(1.5);
    expect(viewport.defaultViewport).toEqual({ x: 0, y: 0, zoom: 0.5 });
    expect(viewport.fitViewOptions).toEqual({ maxZoom: 0.5, padding: 0.2 });
  });

  it("uses a provided default zoom for the viewport and fitView cap", () => {
    const viewport = resolveGraphViewport(0.8);
    expect(viewport.defaultViewport.zoom).toBe(0.8);
    expect(viewport.fitViewOptions.maxZoom).toBe(0.8);
  });

  it("clamps below min zoom to 0.1", () => {
    const viewport = resolveGraphViewport(0.05);
    expect(viewport.defaultViewport.zoom).toBe(0.1);
    expect(viewport.fitViewOptions.maxZoom).toBe(0.1);
  });

  it("clamps above max zoom to 1.5", () => {
    const viewport = resolveGraphViewport(3);
    expect(viewport.defaultViewport.zoom).toBe(1.5);
    expect(viewport.fitViewOptions.maxZoom).toBe(1.5);
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
