/** React Flow zoom-out floor. Wheel, pinch, and Controls all stop here. */
export const GRAPH_MIN_ZOOM = 0.1;
/** React Flow zoom-in ceiling. */
export const GRAPH_MAX_ZOOM = 1.5;
export const GRAPH_DEFAULT_ZOOM = 0.5;

export type GraphViewport = {
  minZoom: number;
  maxZoom: number;
  defaultViewport: { x: number; y: number; zoom: number };
  fitViewOptions: { maxZoom: number };
  focusedFitViewOptions: {
    padding: number;
    duration: number;
    maxZoom: number;
  };
};

export function resolveGraphViewport(
  defaultZoom = GRAPH_DEFAULT_ZOOM,
): GraphViewport {
  const raw = Number.isFinite(defaultZoom) ? defaultZoom : GRAPH_DEFAULT_ZOOM;
  const zoom = Math.min(GRAPH_MAX_ZOOM, Math.max(GRAPH_MIN_ZOOM, raw));
  return {
    minZoom: GRAPH_MIN_ZOOM,
    maxZoom: GRAPH_MAX_ZOOM,
    defaultViewport: { x: 0, y: 0, zoom },
    fitViewOptions: { maxZoom: zoom },
    focusedFitViewOptions: {
      padding: 0.35,
      duration: 250,
      maxZoom: zoom,
    },
  };
}
