import { useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { PlayIcon, SquareIcon } from "lucide-react";
import { AssetPicker, PanelFrame, PropertyGrid } from "@haptic/editor-kit";
import {
  cameraShakeFinished,
  normalizeCameraShakePayload,
  sampleCameraShake,
  type CameraShakeClock,
  type CameraShakeCurves,
  type CameraShakePayload,
} from "@haptic/core";
import { createCameraShakePreviewScene, createMaterialPreviewPresenter } from "@haptic/render";
import { useDocumentActions, useOpenDocument, useRegistryState } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useOptionalPlay } from "../context/play-context";
import { asRecord } from "../lib/as-record";
import { CAMERA_SHAKE_CURVE_FIELDS, cameraShakeDetailRows, type CameraShakeCurveField } from "../lib/camera-shake-rows";
import { watchBlockingEditorOverlay } from "../lib/viewport-render-gate";
import { IconActionButton } from "./icon-action-button";

type RegistryEntry = { header: { guid: string; name: string; type: string; payload?: Record<string, unknown> }; path: string };

/** The open Camera Shake document's payload and a commit that records one undo step per edit (a scrub merges). */
function useCameraShakeDocument() {
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const doc = useOpenDocument(documentId);
  const shake = normalizeCameraShakePayload(asRecord(doc?.content));
  const commit = (next: CameraShakePayload, field?: string) => {
    void applyAssetDocumentChange(
      documentId,
      normalizeCameraShakePayload(next) as unknown as Record<string, unknown>,
      field ? `camera-shake:${field}` : undefined,
    );
  };
  return { shake, commit, path: doc?.ref.path };
}

/** The curve values a shake names, from the curve assets' saved header snapshots. */
function shakeCurves(shake: CameraShakePayload, entries: readonly RegistryEntry[]): CameraShakeCurves {
  const curve = (guid: string | null) => {
    const entry = guid ? entries.find((asset) => asset.header.guid === guid) : undefined;
    return (entry?.header.payload?.curve ?? null) as never;
  };
  return {
    intensity: curve(shake.intensityCurveGuid),
    location: curve(shake.locationCurveGuid),
    rotation: curve(shake.rotationCurveGuid),
    fov: curve(shake.fovCurveGuid),
  };
}

export function CameraShakeDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { shake, commit } = useCameraShakeDocument();
  const { assetRegistry } = useRegistryState();
  const [pickField, setPickField] = useState<CameraShakeCurveField | null>(null);
  const entries = (assetRegistry?.list() ?? []) as readonly RegistryEntry[];
  const curveType = pickField ? CAMERA_SHAKE_CURVE_FIELDS[pickField] : null;
  const rows = cameraShakeDetailRows(shake, commit, setPickField,
    (guid) => entries.find((asset) => asset.header.guid === guid)?.header.name);
  return (
    <PanelFrame data-testid="camera-shake-details-panel">
      <div className="flex flex-col gap-3 p-2">
        <PropertyGrid rows={rows} />
      </div>
      <AssetPicker
        open={pickField !== null}
        onOpenChange={(open) => {
          if (!open) setPickField(null);
        }}
        assets={entries.filter((asset) => asset.header.type === curveType).map((asset) => ({
          guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path,
        }))}
        allowedTypes={curveType ? [curveType] : []}
        title={curveType === "FloatCurve" ? "Pick Float Curve" : "Pick Vector Curve"}
        allowNone
        onPick={(guid) => {
          if (pickField) commit({ ...shake, [pickField]: guid });
          setPickField(null);
        }}
        data-testid="camera-shake-curve-picker"
      />
    </PanelFrame>
  );
}

/**
 * Plays the open shake on a small built-in set, on the shared Engine. Play starts it; Stop blends it out as Stop
 * Camera Shake does, and a second Stop (or the end of its Duration) ends it. Edits apply to the playing shake.
 */
export function CameraShakePreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { shake } = useCameraShakeDocument();
  const { assetRegistry } = useRegistryState();
  const entries = (assetRegistry?.list() ?? []) as readonly RegistryEntry[];
  const latest = useRef({ shake, curves: shakeCurves(shake, entries) });
  latest.current = { shake, curves: shakeCurves(shake, entries) };
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const play = useOptionalPlay();
  const [engine, setEngine] = useState<AbstractEngine | null>(null);
  const clock = useRef<(CameraShakeClock & { last: number }) | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    setEngine(play?.ensureSharedEngine() ?? null);
  }, [play]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !engine) return;
    const overlay = watchBlockingEditorOverlay();
    let host: ReturnType<typeof createCameraShakePreviewScene> | null = null;
    let presenter: ReturnType<typeof createMaterialPreviewPresenter> | null = null;
    try {
      host = createCameraShakePreviewScene(engine);
      presenter = createMaterialPreviewPresenter(host, canvas, {
        staticContent: true,
        animating: () => clock.current !== null,
        suspended: overlay.isOpen,
      });
    } catch {
      presenter?.dispose();
      host?.dispose();
      overlay.dispose();
      return;
    }
    if (!presenter) {
      host.dispose();
      overlay.dispose();
      return;
    }
    const scene = host;
    const view = presenter;
    let frame = 0;
    const tick = () => {
      const running = clock.current;
      if (!running) scene.setOffset(null);
      else {
        // Wall time: the preview Scene renders outside the Engine's own loop.
        const now = performance.now();
        running.time += Math.max(0, now - running.last) / 1000;
        running.last = now;
        const { shake: current, curves } = latest.current;
        if (cameraShakeFinished(current, running)) {
          clock.current = null;
          scene.setOffset(null);
          setPlaying(false);
        } else scene.setOffset(sampleCameraShake(current, running, 1, curves));
      }
      view.present({ force: running !== null });
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
      overlay.dispose();
      view.dispose();
      scene.dispose();
    };
  }, [engine]);

  const start = () => {
    clock.current = { time: 0, stoppingAt: null, seed: Math.floor(Math.random() * 0x7fffffff), last: performance.now() };
    setPlaying(true);
  };
  const stop = () => {
    const running = clock.current;
    if (!running) return;
    if (running.stoppingAt === null && latest.current.shake.blendOutTime > 0) running.stoppingAt = running.time;
    else {
      clock.current = null;
      setPlaying(false);
    }
  };

  return (
    <PanelFrame data-testid="camera-shake-preview-panel">
      <div className="relative h-full min-h-0 w-full">
        <canvas ref={canvasRef} className="h-full w-full touch-none" data-testid="camera-shake-preview-canvas" />
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-2">
          <div className="pointer-events-auto toolbar-island toolbar-island-touch" data-testid="camera-shake-preview-controls">
            <IconActionButton label="Play" variant="ghost" onClick={start} data-testid="camera-shake-preview-play">
              <PlayIcon />
            </IconActionButton>
            <IconActionButton label="Stop" variant="ghost" disabled={!playing} onClick={stop} data-testid="camera-shake-preview-stop">
              <SquareIcon />
            </IconActionButton>
          </div>
        </div>
      </div>
    </PanelFrame>
  );
}
