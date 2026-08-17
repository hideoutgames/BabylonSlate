import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  applyUiControlsIfUnfrozen,
  createUiSurface,
  isHardUiPresentFailure,
  type UiSurface,
} from "@babylonslate/render";
import {
  collectImageGuidsFromUiDocuments,
  describeUiControls,
  layoutUserInterface,
} from "@babylonslate/ui-runtime";
import { PanelFrame } from "@babylonslate/editor-kit";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import { useDocuments } from "../context/document-context";
import { useOptionalPlay } from "../context/play-context";
import { asUiDocument } from "../lib/play-content";
import {
  collectUiImageUrls,
  revokeUiImageUrls,
} from "../lib/play-ui-images";
import {
  freezeLiveUiSurface,
  presentLiveUiIfVisible,
} from "../lib/live-ui-present";
import { loadLatest } from "../lib/load-latest";
import { createUiFrameScheduler } from "../lib/schedule-ui-frame";
import {
  bindEditorUtilityWidgetEvent,
  compileEditorUtilityInterfaceLogic,
  createEditorUtilityInterfaceHost,
} from "../lib/editor-utility-interface-runtime";
import { editorUtilityGuidFromWindowId } from "../shell/editor-utility-windows";

export function EditorUtilityPanel(props: IDockviewPanelProps) {
  const guid = editorUtilityGuidFromWindowId(props.api.id);
  const { assetRegistry, openDocuments, loadAssetDocument, readAssetChunk } =
    useDocuments();
  const play = useOptionalPlay();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<UiSurface | null>(null);
  const paintSchedulerRef = useRef(createUiFrameScheduler());
  const hostRef = useRef<ReturnType<typeof createEditorUtilityInterfaceHost> | null>(
    null,
  );
  const [payload, setPayload] = useState<unknown>(null);
  const [panelVisible, setPanelVisible] = useState(props.api.isVisible);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [imageUrls, setImageUrls] = useState<Map<string, string>>(
    () => new Map(),
  );
  const imageUrlsRef = useRef(imageUrls);
  imageUrlsRef.current = imageUrls;
  const resolveImageUrl = useCallback(
    (guid: string) => imageUrlsRef.current.get(guid) ?? null,
    [],
  );

  useEffect(() => {
    const api = props.api as IDockviewPanelProps["api"] & {
      onDidVisibilityChange?: (cb: (event: { isVisible: boolean }) => void) => {
        dispose: () => void;
      };
    };
    const sub = api.onDidVisibilityChange?.((event) => {
      setPanelVisible(event.isVisible);
    });
    return () => sub?.dispose();
  }, [props.api]);

  const asset = assetRegistry
    ?.list()
    .find((entry) => entry.header.guid === guid);
  const open = openDocuments.find((doc) => doc.ref.path === asset?.path);

  useEffect(() => {
    if (open?.content) {
      setPayload(open.content);
      return;
    }
    if (!asset) {
      setPayload(null);
      return;
    }
    const headerPayload = asset.header.payload;
    if (headerPayload && typeof headerPayload.widgets === "object") {
      setPayload(headerPayload);
    }
    return loadLatest(
      () => loadAssetDocument("ui", asset.path),
      (loaded) => {
        if (loaded) setPayload(loaded);
      },
    );
  }, [asset, loadAssetDocument, open?.content]);

  const ui = useMemo(
    () => (payload ? asUiDocument(payload) : null),
    [payload],
  );

  useEffect(() => {
    if (!ui) {
      revokeUiImageUrls(imageUrlsRef.current);
      imageUrlsRef.current = new Map();
      setImageUrls(new Map());
      return;
    }
    let cancelled = false;
    const assets = (assetRegistry?.list() ?? []).map((asset) => ({
      guid: asset.header.guid,
      path: asset.path,
      type: asset.header.type,
      chunks: asset.header.chunks,
    }));
    void collectUiImageUrls(
      collectImageGuidsFromUiDocuments([ui]),
      assets,
      readAssetChunk ?? (async () => null),
    ).then((urls) => {
      if (cancelled) {
        revokeUiImageUrls(urls);
        return;
      }
      revokeUiImageUrls(imageUrlsRef.current);
      imageUrlsRef.current = urls;
      setImageUrls(urls);
    });
    return () => {
      cancelled = true;
    };
  }, [assetRegistry, readAssetChunk, ui]);

  useEffect(
    () => () => {
      revokeUiImageUrls(imageUrlsRef.current);
    },
    [],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const engine = play?.ensureSharedEngine() ?? null;
    if (!canvas || !engine || !ui) return;
    let surface: UiSurface | null = null;
    try {
      surface = createUiSurface(canvas, engine, {
        name: `eui-${guid ?? "panel"}`,
        interactive: true,
        designResolution: ui.designResolution,
        scaleRule: ui.scaleRule,
        onWidgetEvent: (event) => {
          const runtime = hostRef.current;
          if (!runtime) return;
          bindEditorUtilityWidgetEvent(runtime.host, event);
        },
        resolveImageUrl,
      });
    } catch (error) {
      console.error("Editor utility surface failed", error);
      setPreviewError(
        error instanceof Error ? error.message : "Failed to create GUI surface",
      );
      return;
    }
    surfaceRef.current = surface;
    setPreviewError(null);
    freezeLiveUiSurface(surface, {
      panelVisible,
      documentActive: true,
      requireDocumentActive: false,
    });
    const paintScheduler = paintSchedulerRef.current;
    return () => {
      paintScheduler.cancel();
      surface?.dispose();
      surfaceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- freeze on create; next effect tracks visibility
  }, [
    guid,
    play,
    play?.sharedEngineGeneration,
    ui?.designResolution.height,
    ui?.designResolution.width,
    ui?.scaleRule,
  ]);

  useEffect(() => {
    freezeLiveUiSurface(surfaceRef.current, {
      panelVisible,
      documentActive: true,
      requireDocumentActive: false,
    });
  }, [panelVisible]);

  useEffect(() => {
    const surface = surfaceRef.current;
    const canvas = canvasRef.current;
    if (!surface || !ui || !canvas) return;
    const paint = () => {
      const frozen = !panelVisible;
      const width = Math.max(1, canvas.clientWidth || ui.designResolution.width);
      const height = Math.max(
        1,
        canvas.clientHeight || ui.designResolution.height,
      );
      const layout = layoutUserInterface(ui, { width, height });
      applyUiControlsIfUnfrozen(frozen, surface.host, describeUiControls(ui, layout));
      surface.resizeDesign(width, height, ui.scaleRule);
      presentLiveUiIfVisible({
        panelVisible,
        documentActive: true,
        requireDocumentActive: false,
        present: () => {
          try {
            surface.present();
            setPreviewError(null);
          } catch (error) {
            if (!isHardUiPresentFailure(error)) return;
            console.error("Editor utility present failed", error);
            setPreviewError(
              error instanceof Error ? error.message : "Failed to present GUI",
            );
          }
        },
      });
    };
    paintSchedulerRef.current.schedule(paint);
    const paintScheduler = paintSchedulerRef.current;
    if (typeof ResizeObserver === "undefined") {
      return () => paintScheduler.cancel();
    }
    const observer = new ResizeObserver(() => {
      paintScheduler.schedule(paint);
    });
    observer.observe(canvas);
    return () => {
      paintScheduler.cancel();
      observer.disconnect();
    };
  }, [imageUrls, panelVisible, ui]);

  useEffect(() => {
    if (!asset?.path || !payload) return;
    const runtime = createEditorUtilityInterfaceHost({
      setWidgetVisible: (widgetId, visible) => {
        surfaceRef.current?.host.setVisible(widgetId, visible);
        surfaceRef.current?.host.markAsDirty();
      },
    });
    hostRef.current = runtime;
    let cancelled = false;
    const scripts = compileEditorUtilityInterfaceLogic(asset.path, payload);
    void runtime.loadAll(scripts).then(() => {
      if (cancelled) return;
      runtime.beginPlay();
    });
    let frame = 0;
    const tick = () => {
      runtime.tick();
      frame = window.requestAnimationFrame(tick);
    };
    if (panelVisible) frame = window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (frame) window.cancelAnimationFrame(frame);
      runtime.dispose();
      if (hostRef.current === runtime) hostRef.current = null;
    };
  }, [asset?.path, payload, panelVisible]);

  return (
    <PanelFrame data-testid="editor-utility-panel">
      <div className="relative h-full min-h-0">
        <canvas
          ref={canvasRef}
          className="h-full w-full touch-none"
          data-testid="editor-utility-canvas"
          onPointerDown={(event) => event.stopPropagation()}
          onPointerMove={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
        />
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
    </PanelFrame>
  );
}
