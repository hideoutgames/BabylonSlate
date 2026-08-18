import { useEffect, useRef, useState } from "react";
import type { Engine } from "@babylonjs/core";
import type { SkeletonKind } from "@babylonslate/assets";
import {
  attachMaterialPreviewGestures,
  attachSkeletonPreview,
  createMaterialPreviewPresenter,
  createModelPreviewScene,
  loadModelPreviewSource,
  type MaterialPreviewPresenter,
  type MaterialPreviewScene,
} from "@babylonslate/render";
import { useOptionalPlay } from "../context/play-context";

export function SkeletonPreviewCanvas({
  sourceBytes,
  kind,
  showBones = true,
}: {
  sourceBytes: Uint8Array;
  kind: SkeletonKind;
  showBones?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const play = useOptionalPlay();
  const [engine, setEngine] = useState<Engine | null>(null);
  const [previewGeneration, setPreviewGeneration] = useState(0);
  const [bonesAttached, setBonesAttached] = useState(false);
  const hostRef = useRef<MaterialPreviewScene | null>(null);
  const presenterRef = useRef<MaterialPreviewPresenter | null>(null);
  const bonesRef = useRef<{ dispose: () => void } | null>(null);

  useEffect(() => {
    setEngine(play?.ensureSharedEngine() ?? null);
  }, [play]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !engine) return;
    let cancelled = false;
    let host: MaterialPreviewScene | null = null;
    let presenter: MaterialPreviewPresenter | null = null;
    let gestures: { dispose: () => void } | null = null;
    let loaded: { dispose: () => void } | null = null;
    const raf = { id: 0 };
    void (async () => {
      try {
        host = createModelPreviewScene(engine);
        loaded = await loadModelPreviewSource(host, sourceBytes);
        if (cancelled || !host || !loaded) {
          host?.dispose();
          loaded?.dispose();
          return;
        }
        presenter = createMaterialPreviewPresenter(host, canvas, { maxFps: 30 });
        gestures = attachMaterialPreviewGestures(canvas, host.camera, {
          onChange: () => presenter?.present({ force: true }),
        });
        hostRef.current = host;
        presenterRef.current = presenter;
        presenter.present({ force: true });
        if (cancelled) {
          presenter.dispose();
          gestures.dispose();
          loaded.dispose();
          host.dispose();
          hostRef.current = null;
          presenterRef.current = null;
          return;
        }
        setPreviewGeneration((value) => value + 1);
        const tick = () => {
          if (cancelled) return;
          presenter?.present();
          raf.id = window.requestAnimationFrame(tick);
        };
        raf.id = window.requestAnimationFrame(tick);
      } catch {
        presenter?.dispose();
        gestures?.dispose();
        loaded?.dispose();
        host?.dispose();
        hostRef.current = null;
        presenterRef.current = null;
      }
    })();
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf.id);
      bonesRef.current?.dispose();
      bonesRef.current = null;
      gestures?.dispose();
      presenter?.dispose();
      loaded?.dispose();
      host?.dispose();
      hostRef.current = null;
      presenterRef.current = null;
    };
  }, [engine, sourceBytes]);

  useEffect(() => {
    const host = hostRef.current;
    bonesRef.current?.dispose();
    bonesRef.current = null;
    setBonesAttached(false);
    if (!host || !showBones) {
      presenterRef.current?.present({ force: true });
      return;
    }
    bonesRef.current = attachSkeletonPreview(host.mesh, host.scene, kind);
    setBonesAttached(true);
    presenterRef.current?.present({ force: true });
  }, [kind, showBones, previewGeneration]);

  return (
    <canvas
      ref={canvasRef}
      className="h-full w-full touch-none"
      data-testid="skeleton-preview-canvas"
      data-bones={bonesAttached ? "true" : "false"}
    />
  );
}
