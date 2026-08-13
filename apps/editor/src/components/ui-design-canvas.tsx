import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type WheelEvent,
} from "react";
import type { Engine } from "@babylonjs/core";
import {
  applyFontRegistryToHost,
  applyUiControls,
  createUiSurface,
  FontRegistry,
  type DesignerGizmoState,
  type UiSurface,
} from "@babylonslate/render";
import {
  applyWidgetResize,
  laidOutParentRect,
  widgetAllowsDesignerTransform,
  type LayoutResult,
  type UiControlDescriptor,
  type UserInterfaceDocument,
  type WidgetLayout,
} from "@babylonslate/ui-runtime";
import {
  UI_DESIGN_HANDLE_SIZE_PX,
  applyWidgetDragOffset,
  canvasDeltaToLayoutDelta,
  clampDesignZoom,
  designRectToBitmap,
  designRectToScreen,
  handleEdges,
  passedDragThreshold,
  pivotToScreen,
  pointerCentroid,
  pointerSpan,
  resizeHandleRects,
  uiDesignStrokeMergeKey,
  zoomAtPoint,
  type DesignView,
  type HandleEdge,
  type PointerPoint,
  type ScreenRect,
} from "./ui-design-gestures";

export function UiDesignCanvas({
  ui,
  viewport,
  layout,
  controls,
  selectedId,
  view,
  previewScale,
  sharedEngine,
  fontEntries = [],
  bitmapScale,
  onSelect,
  onViewChange,
  onLayoutChange,
}: {
  ui: UserInterfaceDocument;
  viewport: {
    id: string;
    width: number;
    height: number;
    safeArea: { left: number; right: number; top: number; bottom: number };
  };
  layout: LayoutResult;
  controls: readonly UiControlDescriptor[];
  selectedId: string;
  view: DesignView;
  previewScale: number;
  bitmapScale: number;
  sharedEngine: Engine | null;
  fontEntries?: readonly import("@babylonslate/render").FontAssetEntry[];
  onSelect: (id: string) => void;
  onViewChange: (view: DesignView) => void;
  onLayoutChange: (id: string, next: WidgetLayout, mergeKey: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gizmoCanvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<UiSurface | null>(null);
  const [guiLive, setGuiLive] = useState(false);
  const [liveRects, setLiveRects] = useState<Record<string, ScreenRect>>({});
  const latestUiRef = useRef(ui);
  const viewRef = useRef(view);
  const pointersRef = useRef(new Map<number, PointerPoint>());
  const panStartRef = useRef({
    panX: 0,
    panY: 0,
    zoom: 1,
    cx: 0,
    cy: 0,
    span: 0,
  });
  const dragRef = useRef<{
    mode: "move" | "resize" | "pan";
    id: string;
    handle?: HandleEdge;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    armed: boolean;
    strokeId: string;
  } | null>(null);
  latestUiRef.current = ui;
  viewRef.current = view;
  const viewScale = previewScale * view.zoom * bitmapScale;

  useEffect(() => {
    const canvas = canvasRef.current;
    const gizmoCanvas = gizmoCanvasRef.current;
    const engine = sharedEngine;
    if (!canvas || !engine) return;
    let surface: UiSurface | null = null;
    try {
      surface = createUiSurface(canvas, engine, {
        name: "ui-designer",
        interactive: false,
        designResolution: ui.designResolution,
        scaleRule: ui.scaleRule,
        gizmoCanvas: gizmoCanvas ?? undefined,
        safeArea: viewport.safeArea,
      });
    } catch {
      return;
    }
    surfaceRef.current = surface;
    setGuiLive(true);
    return () => {
      surface?.dispose();
      surfaceRef.current = null;
      setGuiLive(false);
      setLiveRects({});
    };
  }, [sharedEngine, ui.designResolution, ui.scaleRule, viewport.height, viewport.safeArea, viewport.width]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || fontEntries.length === 0) return;
    const registry = new FontRegistry();
    void applyFontRegistryToHost(registry, fontEntries, () => {
      surface.designAdt.markAsDirty();
      surface.present();
    });
  }, [fontEntries, guiLive]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    surface.resizeDesign(viewport.width, viewport.height, ui.scaleRule);
    applyUiControls(surface.host, controls);
    surface.present();
    setLiveRects(surface.host.measureControls());
  }, [controls, guiLive, ui.scaleRule, viewport.height, viewport.width]);

  const selected = ui.widgets[selectedId];
  const selectedControl = controls.find((row) => row.id === selectedId);
  const canTransform = selected
    ? widgetAllowsDesignerTransform(ui, selected.id)
    : false;
  const selectedHit = selectedControl
    ? (liveRects[selectedControl.id] ??
      designRectToBitmap(selectedControl.guiRect, bitmapScale))
    : null;
  const selectedScreen = selectedHit
    ? designRectToScreen(selectedHit, view, previewScale)
    : null;
  const handles =
    canTransform && selectedScreen
      ? resizeHandleRects(selectedScreen, UI_DESIGN_HANDLE_SIZE_PX)
      : null;
  const pivotScreen =
    selected && selectedHit
      ? pivotToScreen(
          selectedHit,
          selected.layout.transformCenter,
          view,
          previewScale,
        )
      : null;

  const safe = viewport.safeArea;
  const hasSafeArea = safe.top > 0 || safe.bottom > 0 || safe.left > 0 || safe.right > 0;
  const safeScreen = designRectToScreen(
    {
      x: safe.left,
      y: safe.top,
      width: viewport.width - safe.left - safe.right,
      height: viewport.height - safe.top - safe.bottom,
    },
    view,
    previewScale,
  );

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface?.gizmoAdt) return;
    const state: DesignerGizmoState = {
      selection: selectedScreen,
      handles,
      safeArea: hasSafeArea ? safeScreen : null,
      pivot: canTransform ? pivotScreen : null,
    };
    surface.presentGizmos(state);
  }, [
    canTransform,
    guiLive,
    handles,
    hasSafeArea,
    pivotScreen,
    safeScreen,
    selectedScreen,
  ]);

  useEffect(() => {
    const host = viewportRef.current;
    const canvas = gizmoCanvasRef.current;
    if (!host || !canvas || typeof ResizeObserver === "undefined") return;
    const apply = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      canvas.width = width;
      canvas.height = height;
      surfaceRef.current?.resizeGizmos(width, height);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(host);
    return () => observer.disconnect();
  }, [guiLive]);

  const capturePointer = (event: PointerEvent<HTMLDivElement>) => {
    if (typeof event.currentTarget.setPointerCapture !== "function") return;
    try {
      event.currentTarget.setPointerCapture(eventPointerId(event));
    } catch {
      /* jsdom */
    }
  };

  const beginTwoFinger = () => {
    dragRef.current = null;
    const centroid = pointerCentroid(pointersRef.current);
    panStartRef.current = {
      panX: viewRef.current.panX,
      panY: viewRef.current.panY,
      zoom: viewRef.current.zoom,
      cx: centroid.x,
      cy: centroid.y,
      span: pointerSpan(pointersRef.current),
    };
  };

  const onViewportPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    capturePointer(event);
    const pointerId = eventPointerId(event);
    pointersRef.current.set(pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size >= 2) {
      beginTwoFinger();
      return;
    }
    const handleHost = (event.target as Element | null)?.closest(
      "[data-resize-handle]",
    );
    const handle = handleHost?.getAttribute("data-resize-handle") as HandleEdge | null;
    if (handle && selected && canTransform) {
      dragRef.current = {
        mode: "resize",
        id: selected.id,
        handle,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        armed: true,
        strokeId: newStrokeId(),
      };
      return;
    }
    const host = (event.target as Element | null)?.closest("[data-widget-id]");
    const widgetId = host?.getAttribute("data-widget-id");
    if (widgetId && ui.widgets[widgetId]) {
      onSelect(widgetId);
      if (widgetAllowsDesignerTransform(ui, widgetId)) {
        dragRef.current = {
          mode: "move",
          id: widgetId,
          startX: event.clientX,
          startY: event.clientY,
          lastX: event.clientX,
          lastY: event.clientY,
          armed: false,
          strokeId: newStrokeId(),
        };
        return;
      }
      dragRef.current = {
        mode: "pan",
        id: ui.rootId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        armed: true,
        strokeId: newStrokeId(),
      };
      return;
    }
    if (widgetId) {
      onSelect(widgetId.split("/")[0] ?? ui.rootId);
      return;
    }
    onSelect(ui.rootId);
    dragRef.current = {
      mode: "pan",
      id: ui.rootId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      armed: true,
      strokeId: newStrokeId(),
    };
  };

  const onViewportPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const pointerId = eventPointerId(event);
    const tracked = pointersRef.current.get(pointerId);
    if (!tracked) return;
    pointersRef.current.set(pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size >= 2) {
      const centroid = pointerCentroid(pointersRef.current);
      const span = pointerSpan(pointersRef.current);
      const start = panStartRef.current;
      onViewChange({
        zoom: clampDesignZoom(
          start.span > 0 ? start.zoom * (span / start.span) : start.zoom,
        ),
        panX: start.panX + (centroid.x - start.cx),
        panY: start.panY + (centroid.y - start.cy),
      });
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.mode === "pan") {
      onViewChange({
        ...viewRef.current,
        panX: viewRef.current.panX + (event.clientX - drag.lastX),
        panY: viewRef.current.panY + (event.clientY - drag.lastY),
      });
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      return;
    }
    if (
      drag.mode === "move" &&
      !drag.armed &&
      !passedDragThreshold(
        { x: drag.startX, y: drag.startY },
        { x: event.clientX, y: event.clientY },
      )
    ) {
      return;
    }
    drag.armed = true;
    const screenDelta = {
      x: event.clientX - drag.lastX,
      y: event.clientY - drag.lastY,
    };
    if (screenDelta.x === 0 && screenDelta.y === 0) return;
    const current = latestUiRef.current;
    const widget = current.widgets[drag.id];
    if (!widget) return;
    const delta = canvasDeltaToLayoutDelta(screenDelta, viewScale);
    const parentRect = laidOutParentRect(layout, drag.id);
    const nextLayout =
      drag.mode === "resize" && drag.handle
        ? applyWidgetResize(widget.layout, parentRect, delta, handleEdges(drag.handle))
        : applyWidgetDragOffset(widget.layout, delta);
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    onLayoutChange(drag.id, nextLayout, uiDesignStrokeMergeKey(drag.strokeId));
  };

  const onViewportPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(eventPointerId(event));
    if (pointersRef.current.size < 2) {
      dragRef.current = null;
    }
    if (pointersRef.current.size >= 2) beginTwoFinger();
  };

  const onViewportWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    onViewChange(
      zoomAtPoint(viewRef.current, viewRef.current.zoom * factor, {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      }),
    );
  };

  return (
    <div
      ref={viewportRef}
      className="relative flex min-h-0 min-w-0 flex-1 touch-none overflow-hidden bg-muted/30"
      data-testid="ui-design-viewport"
      onPointerDown={onViewportPointerDown}
      onPointerMove={onViewportPointerMove}
      onPointerUp={onViewportPointerUp}
      onPointerCancel={onViewportPointerUp}
      onWheel={onViewportWheel}
    >
      <div
        className="absolute bg-background shadow-sm"
        data-testid="ui-design-canvas"
        data-preset={viewport.id}
        data-scale={String(layout.scale)}
        data-zoom={String(view.zoom)}
        data-pan-x={String(view.panX)}
        data-pan-y={String(view.panY)}
        style={{
          left: 0,
          top: 0,
          width: viewport.width * previewScale,
          height: viewport.height * previewScale,
          transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`,
          transformOrigin: "0 0",
        }}
      >
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute inset-0 size-full"
          width={viewport.width}
          height={viewport.height}
        />
        {controls.map((control) => {
          const hit =
            liveRects[control.id] ??
            designRectToBitmap(control.guiRect, bitmapScale);
          return (
          <div
            key={control.id}
            data-testid={`ui-widget-${control.id}`}
            data-widget-id={control.id}
            data-kind={control.kind}
            data-gui-x={String(Math.round(hit.x))}
            data-gui-y={String(Math.round(hit.y))}
            className="absolute"
            style={{
              left: `${(hit.x / viewport.width) * 100}%`,
              top: `${(hit.y / viewport.height) * 100}%`,
              width: `${(hit.width / viewport.width) * 100}%`,
              height: `${(hit.height / viewport.height) * 100}%`,
            }}
            onClick={() => {
              if (ui.widgets[control.id]) {
                onSelect(control.id);
                return;
              }
              onSelect(control.id.split("/")[0] ?? ui.rootId);
            }}
          />
          );
        })}
      </div>
      <canvas
        ref={gizmoCanvasRef}
        className="pointer-events-none absolute inset-0 size-full"
        data-testid="ui-gizmo-canvas"
      />
      <div className="pointer-events-none absolute inset-0">
        {hasSafeArea ? (
          <div
            className={
              guiLive
                ? "absolute"
                : "absolute border border-dashed border-primary/40"
            }
            data-testid="ui-safe-area"
            style={{
              left: safeScreen.x,
              top: safeScreen.y,
              width: safeScreen.width,
              height: safeScreen.height,
            }}
          />
        ) : null}
        {selectedScreen ? (
          <div
            className={guiLive ? "absolute" : "absolute border-2 border-primary"}
            data-testid="ui-selection-outline"
            style={{
              left: selectedScreen.x,
              top: selectedScreen.y,
              width: selectedScreen.width,
              height: selectedScreen.height,
            }}
          />
        ) : null}
        {handles
          ? (Object.entries(handles) as Array<[HandleEdge, (typeof handles)["n"]]>).map(
              ([edge, rect]) => (
                <button
                  key={edge}
                  type="button"
                  className={
                    guiLive
                      ? "pointer-events-auto absolute bg-transparent"
                      : "pointer-events-auto absolute border border-primary bg-background"
                  }
                  data-testid={`ui-resize-${edge}`}
                  data-resize-handle={edge}
                  aria-label={`Resize ${edge}`}
                  style={{
                    left: rect.x,
                    top: rect.y,
                    width: rect.width,
                    height: rect.height,
                  }}
                />
              ),
            )
          : null}
      </div>
    </div>
  );
}

function eventPointerId(event: PointerEvent<Element>): number {
  const native = event.nativeEvent as unknown as { pointerId?: number };
  if (typeof native.pointerId === "number") return native.pointerId;
  return event.pointerId;
}

function newStrokeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
