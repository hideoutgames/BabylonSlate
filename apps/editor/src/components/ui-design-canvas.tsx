import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type WheelEvent,
} from "react";
import type { Engine } from "@babylonjs/core";
import {
  applyFontRegistryToHost,
  applyUiControlsIfUnfrozen,
  createUiSurface,
  FontRegistry,
  isHardUiPresentFailure,
  uiHostStats,
  type DesignerGizmoState,
  type UiSurface,
} from "@babylonslate/render";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import {
  applyWidgetResize,
  describeUiControls,
  laidOutParentRect,
  layoutUserInterface,
  widgetAllowsDesignerTransform,
  type LayoutResult,
  type UiControlDescriptor,
  type UserInterfaceDocument,
  type WidgetLayout,
} from "@babylonslate/ui-runtime";
import {
  UI_DESIGN_HANDLE_HIT_SIZE_PX,
  UI_DESIGN_HANDLE_VISUAL_SIZE_PX,
  applyWidgetDragOffset,
  designerControlHitRect,
  designerGestureAt,
  canvasDeltaToLayoutDelta,
  clampDesignZoom,
  designRectToScreen,
  handleEdges,
  passedDragThreshold,
  pivotToScreen,
  pointerCentroid,
  pointerSpan,
  resizeHandleRects,
  zoomAtPoint,
  type DesignView,
  type HandleEdge,
  type PointerPoint,
  type ScreenRect,
} from "./ui-design-gestures";
import {
  freezeLiveUiSurface,
  presentLiveUiIfVisible,
} from "../lib/live-ui-present";
import { createUiFrameScheduler } from "../lib/schedule-ui-frame";
import { UiImageIssueAlert } from "./ui-image-issue";
import type { UiImageIssue } from "../lib/play-ui-images";

const defaultResolveImageUrl = (): string | null => null;

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
  resolveImageUrl = defaultResolveImageUrl,
  imageIssues = [],
  bitmapScale,
  onSelect,
  onViewChange,
  onLayoutChange,
  panelVisible = true,
  documentActive = true,
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
  resolveImageUrl?: (guid: string) => string | null;
  imageIssues?: readonly UiImageIssue[];
  onSelect: (id: string) => void;
  onViewChange: (view: DesignView) => void;
  onLayoutChange: (id: string, next: WidgetLayout, mergeKey?: string) => void;
  panelVisible?: boolean;
  documentActive?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gizmoCanvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<UiSurface | null>(null);
  const [guiLive, setGuiLive] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
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
    previewLayout?: WidgetLayout;
  } | null>(null);
  const [previewLayouts, setPreviewLayouts] = useState<Record<string, WidgetLayout>>(
    {},
  );
  const previewLayoutsRef = useRef(previewLayouts);
  previewLayoutsRef.current = previewLayouts;
  const paintSchedulerRef = useRef(createUiFrameScheduler());
  const gizmoSchedulerRef = useRef(createUiFrameScheduler());
  const resolveImageUrlRef = useRef(resolveImageUrl);
  resolveImageUrlRef.current = resolveImageUrl;
  const boundResolveImageUrl = useCallback(
    (guid: string) => resolveImageUrlRef.current(guid),
    [],
  );
  latestUiRef.current = ui;
  viewRef.current = view;
  const viewScale = previewScale * view.zoom * bitmapScale;
  const previewUi = useMemo(() => {
    const ids = Object.keys(previewLayouts);
    if (ids.length === 0) return ui;
    const widgets = { ...ui.widgets };
    for (const id of ids) {
      const widget = widgets[id];
      const layout = previewLayouts[id];
      if (!widget || !layout) continue;
      widgets[id] = { ...widget, layout };
    }
    return { ...ui, widgets };
  }, [previewLayouts, ui]);
  const displayLayout = useMemo(() => {
    if (Object.keys(previewLayouts).length === 0) return layout;
    return layoutUserInterface(
      previewUi,
      { width: viewport.width, height: viewport.height },
      { safeArea: viewport.safeArea, designSpace: true },
    );
  }, [layout, previewLayouts, previewUi, viewport.height, viewport.safeArea, viewport.width]);
  const displayControls = useMemo(() => {
    if (Object.keys(previewLayouts).length === 0) return controls;
    return describeUiControls(previewUi, displayLayout);
  }, [controls, displayLayout, previewLayouts, previewUi]);

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
        designResolution: {
          width: viewport.width,
          height: viewport.height,
        },
        scaleRule: "shortestSide",
        gizmoCanvas: gizmoCanvas ?? undefined,
        safeArea: viewport.safeArea,
        resolveImageUrl: boundResolveImageUrl,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create GUI surface";
      console.error("UI designer surface failed", error);
      setPreviewError(message);
      setGuiLive(false);
      return;
    }
    surfaceRef.current = surface;
    freezeLiveUiSurface(surface, { panelVisible, documentActive });
    setPreviewError(null);
    setGuiLive(true);
    const paintScheduler = paintSchedulerRef.current;
    const gizmoScheduler = gizmoSchedulerRef.current;
    return () => {
      surface?.dispose();
      surfaceRef.current = null;
      setGuiLive(false);
      setLiveRects({});
      paintScheduler.cancel();
      gizmoScheduler.cancel();
    };
    // Recreate only when the shared Engine identity changes. Viewport, scale
    // rule, and design resolution go through resizeDesign on the paint path.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [sharedEngine]);

  useEffect(() => {
    freezeLiveUiSurface(surfaceRef.current, { panelVisible, documentActive });
  }, [documentActive, guiLive, panelVisible]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || fontEntries.length === 0) return;
    const registry = new FontRegistry();
    void applyFontRegistryToHost(registry, fontEntries, () => {
      surface.designAdt.markAsDirty();
      presentLiveUiIfVisible({
        panelVisible,
        documentActive,
        present: () => {
          try {
            surface.present();
          } catch (error) {
            if (isHardUiPresentFailure(error)) {
              console.error("UI designer font present failed", error);
            }
          }
        },
      });
    });
  }, [documentActive, fontEntries, guiLive, panelVisible]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    paintSchedulerRef.current.schedule(() => {
      const live = surfaceRef.current;
      if (!live) return;
      try {
        const frozen = !panelVisible || !documentActive;
        live.resizeDesign(
          viewport.width,
          viewport.height,
          "shortestSide",
          { width: viewport.width, height: viewport.height },
        );
        applyUiControlsIfUnfrozen(frozen, live.host, displayControls);
        presentLiveUiIfVisible({
          panelVisible,
          documentActive,
          present: () => {
            live.present();
            setPreviewError(null);
            setLiveRects(live.host.measureControls());
          },
        });
      } catch (error) {
        if (!isHardUiPresentFailure(error)) return;
        const message =
          error instanceof Error ? error.message : "Failed to present GUI";
        console.error("UI designer present failed", error);
        setPreviewError(message);
        setGuiLive(false);
      }
    });
  }, [
    displayControls,
    documentActive,
    guiLive,
    panelVisible,
    viewport.height,
    viewport.width,
  ]);

  const selected = previewUi.widgets[selectedId];
  const selectedControl = displayControls.find((row) => row.id === selectedId);
  const canTransform = selected
    ? widgetAllowsDesignerTransform(ui, selected.id)
    : false;
  const selectedHit = selectedControl
    ? designerControlHitRect(
        selectedControl,
        liveRects[selectedControl.id],
        viewport,
        bitmapScale,
        ui.rootId,
      )
    : null;
  const selectedScreen = selectedHit
    ? designRectToScreen(selectedHit, view, previewScale)
    : null;
  const handles =
    canTransform && selectedScreen
      ? resizeHandleRects(selectedScreen, UI_DESIGN_HANDLE_HIT_SIZE_PX)
      : null;
  const visualHandles =
    canTransform && selectedScreen
      ? resizeHandleRects(selectedScreen, UI_DESIGN_HANDLE_VISUAL_SIZE_PX)
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
      handles: visualHandles,
      safeArea: hasSafeArea ? safeScreen : null,
      pivot: canTransform ? pivotScreen : null,
    };
    gizmoSchedulerRef.current.schedule(() => {
      try {
        presentLiveUiIfVisible({
          panelVisible,
          documentActive,
          present: () => surface.presentGizmos(state),
        });
      } catch (error) {
        if (isHardUiPresentFailure(error)) {
          console.error("UI designer gizmos failed", error);
        }
      }
    });
  }, [
    canTransform,
    documentActive,
    guiLive,
    hasSafeArea,
    panelVisible,
    pivotScreen,
    safeScreen,
    selectedScreen,
    visualHandles,
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
    const gizmoScheduler = gizmoSchedulerRef.current;
    const observer = new ResizeObserver(() => {
      gizmoScheduler.schedule(apply);
    });
    observer.observe(host);
    return () => {
      gizmoScheduler.cancel();
      observer.disconnect();
    };
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
    const hitBounds = viewportRef.current?.getBoundingClientRect();
    const point = {
      x: event.clientX - (hitBounds?.left ?? 0),
      y: event.clientY - (hitBounds?.top ?? 0),
    };
    const interior = [...displayControls].reverse().find((control) => {
      if (control.id === ui.rootId) return false;
      if (!widgetAllowsDesignerTransform(ui, control.id)) return false;
      const hit = designerControlHitRect(
        control,
        liveRects[control.id],
        viewport,
        bitmapScale,
        ui.rootId,
      );
      return (
        designerGestureAt(point, designRectToScreen(hit, view, previewScale)) ===
        "move"
      );
    });
    if (interior) {
      onSelect(interior.id);
      dragRef.current = {
        mode: "move",
        id: interior.id,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        armed: false,
        strokeId: newStrokeId(),
      };
      return;
    }
    if (selected && canTransform && selectedScreen) {
      const gesture = designerGestureAt(point, selectedScreen);
      if (gesture && gesture !== "move") {
        dragRef.current = {
          mode: "resize",
          id: selected.id,
          handle: gesture,
          startX: event.clientX,
          startY: event.clientY,
          lastX: event.clientX,
          lastY: event.clientY,
          armed: true,
          strokeId: newStrokeId(),
        };
        return;
      }
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
    const baseLayout =
      previewLayoutsRef.current[drag.id] ?? current.widgets[drag.id]?.layout;
    if (!baseLayout) return;
    const delta = canvasDeltaToLayoutDelta(screenDelta, viewScale);
    const parentRect = laidOutParentRect(displayLayout, drag.id);
    const nextLayout =
      drag.mode === "resize" && drag.handle
        ? applyWidgetResize(baseLayout, parentRect, delta, handleEdges(drag.handle))
        : applyWidgetDragOffset(baseLayout, delta);
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    drag.previewLayout = nextLayout;
    previewLayoutsRef.current = {
      ...previewLayoutsRef.current,
      [drag.id]: nextLayout,
    };
    setPreviewLayouts(previewLayoutsRef.current);
  };

  const onViewportPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(eventPointerId(event));
    const drag = dragRef.current;
    if (pointersRef.current.size < 2 && drag?.armed && (drag.mode === "move" || drag.mode === "resize")) {
      const nextLayout = drag.previewLayout ?? previewLayoutsRef.current[drag.id];
      if (nextLayout) {
        onLayoutChange(drag.id, nextLayout);
        uiHostStats.commit += 1;
      }
      previewLayoutsRef.current = {};
      setPreviewLayouts({});
    }
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
        className="absolute shadow-sm"
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
          backgroundImage:
            "repeating-conic-gradient(var(--muted) 0% 25%, var(--background) 0% 50%)",
          backgroundSize: "16px 16px",
        }}
      >
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute inset-0 size-full"
          width={viewport.width}
          height={viewport.height}
        />
        {displayControls.map((control) => {
          const hit = designerControlHitRect(
            control,
            liveRects[control.id],
            viewport,
            bitmapScale,
            ui.rootId,
          );
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
      <UiImageIssueAlert issues={imageIssues} />
      {previewError ? (
        <Empty
          data-testid="ui-gui-preview-error"
          className="pointer-events-none absolute inset-0 border-0"
        >
          <EmptyHeader>
            <EmptyTitle>Babylon GUI Preview Unavailable</EmptyTitle>
            <EmptyDescription>{previewError}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
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
