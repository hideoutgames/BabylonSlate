/** React Flow zoom-out floor. Wheel, pinch, and Controls all stop here. */
export const GRAPH_MIN_ZOOM = 0.1;
/** React Flow zoom-in ceiling. */
export const GRAPH_MAX_ZOOM = 1.5;
export const GRAPH_DEFAULT_ZOOM = 0.5;
/** XYFlow defaults this on; empty-pane double-tap opens Add Node instead. */
export const GRAPH_ZOOM_ON_DOUBLE_CLICK = false;

export type GraphViewport = {
  minZoom: number;
  maxZoom: number;
  zoomOnDoubleClick: boolean;
  defaultViewport: { x: number; y: number; zoom: number };
  fitViewOptions: { maxZoom: number; padding: number };
  focusedFitViewOptions: {
    padding: number;
    duration: number;
    maxZoom: number;
  };
};

export type GraphSessionViewport = { x: number; y: number; zoom: number };

export function resolveGraphMountViewport(
  session: GraphSessionViewport | null | undefined,
  graphViewport: GraphViewport,
): { fitView: boolean; defaultViewport: GraphSessionViewport } {
  if (session) {
    return { fitView: false, defaultViewport: session };
  }
  return { fitView: true, defaultViewport: graphViewport.defaultViewport };
}

export function resolveGraphViewport(
  defaultZoom = GRAPH_DEFAULT_ZOOM,
): GraphViewport {
  const raw = Number.isFinite(defaultZoom) ? defaultZoom : GRAPH_DEFAULT_ZOOM;
  const zoom = Math.min(GRAPH_MAX_ZOOM, Math.max(GRAPH_MIN_ZOOM, raw));
  return {
    minZoom: GRAPH_MIN_ZOOM,
    maxZoom: GRAPH_MAX_ZOOM,
    zoomOnDoubleClick: GRAPH_ZOOM_ON_DOUBLE_CLICK,
    defaultViewport: { x: 0, y: 0, zoom },
    fitViewOptions: { maxZoom: zoom, padding: 0.2 },
    focusedFitViewOptions: {
      padding: 0.35,
      duration: 250,
      maxZoom: zoom,
    },
  };
}
