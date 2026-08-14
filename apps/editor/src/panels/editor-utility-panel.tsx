import { useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  applyUiControls,
  createUiSurface,
  isHardUiPresentFailure,
  type UiSurface,
} from "@babylonslate/render";
import {
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
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useOptionalPlay } from "../context/play-context";
import { asUiDocument } from "../lib/play-content";
import {
  freezeLiveUiSurface,
  presentLiveUiIfVisible,
} from "../lib/live-ui-present";
import {
  editorUtilityGuidFromWindowId,
} from "../shell/editor-utility-windows";

export function EditorUtilityPanel(props: IDockviewPanelProps) {
  const guid = editorUtilityGuidFromWindowId(props.api.id);
  const { documentId } = useDocumentWorkspace();
  const {
    activeDocumentId,
    assetRegistry,
    openDocuments,
    loadAssetDocument,
  } = useDocuments();
  const play = useOptionalPlay();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<UiSurface | null>(null);
  const [payload, setPayload] = useState<unknown>(null);
  const [panelVisible, setPanelVisible] = useState(props.api.isVisible);
  const [previewError, setPreviewError] = useState<string | null>(null);

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
    void loadAssetDocument("ui", asset.path).then((loaded) => {
      if (loaded) setPayload(loaded);
    });
  }, [asset, loadAssetDocument, open?.content]);

  const documentActive = activeDocumentId === documentId;
  const ui = useMemo(
    () => (payload ? asUiDocument(payload) : null),
    [payload],
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
    freezeLiveUiSurface(surface, { panelVisible, documentActive });
    return () => {
      surface?.dispose();
      surfaceRef.current = null;
    };
    // panelVisible / documentActive: freeze the new surface this frame; the
    // next effect updates freeze when those flags change.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [guid, play, ui?.designResolution.width, ui?.designResolution.height, ui?.scaleRule]);

  useEffect(() => {
    freezeLiveUiSurface(surfaceRef.current, { panelVisible, documentActive });
  }, [documentActive, panelVisible]);

  useEffect(() => {
    const surface = surfaceRef.current;
    const canvas = canvasRef.current;
    if (!surface || !ui || !canvas) return;
    const paint = () => {
      const width = Math.max(1, canvas.clientWidth || ui.designResolution.width);
      const height = Math.max(
        1,
        canvas.clientHeight || ui.designResolution.height,
      );
      const layout = layoutUserInterface(ui, { width, height });
      applyUiControls(surface.host, describeUiControls(ui, layout));
      surface.resizeDesign(width, height, ui.scaleRule);
      presentLiveUiIfVisible({
        panelVisible,
        documentActive,
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
    paint();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(paint);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [documentActive, panelVisible, ui]);

  return (
    <PanelFrame data-testid="editor-utility-panel">
      <div className="relative h-full min-h-0">
        <canvas
          ref={canvasRef}
          className="h-full w-full touch-none"
          data-testid="editor-utility-canvas"
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
