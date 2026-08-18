import { useEffect, useRef, useState } from "react";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import type { Engine } from "@babylonjs/core";
import type { SkeletonKind } from "@babylonslate/assets";
import {
  attachMaterialPreviewGestures,
  attachSkeletonPreview,
  createMaterialPreviewPresenter,
  createModelPreviewScene,
  loadModelPreviewSource,
  retargetAnimationGroupWithMeshProxy,
  type MaterialPreviewPresenter,
  type MaterialPreviewScene,
} from "@babylonslate/render";
import { useOptionalPlay } from "../context/play-context";

export function AnimationPreviewCanvas({
  sourceBytes,
  clipName,
  skeletonKind = null,
  showBones = false,
  sourceClipBytes = null,
}: {
  sourceBytes: Uint8Array;
  clipName: string;
  skeletonKind?: SkeletonKind | null;
  showBones?: boolean;
  sourceClipBytes?: Uint8Array | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const play = useOptionalPlay();
  const [engine, setEngine] = useState<Engine | null>(null);
  const [previewGeneration, setPreviewGeneration] = useState(0);
  const hostRef = useRef<MaterialPreviewScene | null>(null);
  const presenterRef = useRef<MaterialPreviewPresenter | null>(null);
  const bonesRef = useRef<{ dispose: () => void } | null>(null);
  const playingRef = useRef<AnimationGroup | null>(null);

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
    let loaded: { dispose: () => void; animationGroups: AnimationGroup[] } | null =
      null;
    let sourceLoaded: { dispose: () => void; animationGroups: AnimationGroup[] } | null =
      null;
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
        let group =
          loaded.animationGroups.find((entry) => entry.name === clipName) ??
          null;
        if (!group && sourceClipBytes && sourceClipBytes.byteLength > 0) {
          const sourceHost = createModelPreviewScene(engine);
          sourceLoaded = await loadModelPreviewSource(
            sourceHost,
            sourceClipBytes,
          );
          const sourceGroup = sourceLoaded?.animationGroups.find(
            (entry) => entry.name === clipName,
          );
          if (sourceGroup) {
            group = retargetAnimationGroupWithMeshProxy(sourceGroup, host.mesh);
          }
          sourceLoaded?.dispose();
          sourceLoaded = null;
          sourceHost.dispose();
        }
        group?.play(true);
        playingRef.current = group;
        presenter = createMaterialPreviewPresenter(host, canvas, { maxFps: 30 });
        gestures = attachMaterialPreviewGestures(canvas, host.camera, {
          onChange: () => presenter?.present({ force: true }),
        });
        hostRef.current = host;
        presenterRef.current = presenter;
        presenter.present({ force: true });
        if (cancelled) {
          group?.stop();
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
        playingRef.current?.stop();
        presenter?.dispose();
        gestures?.dispose();
        loaded?.dispose();
        sourceLoaded?.dispose();
        host?.dispose();
        hostRef.current = null;
        presenterRef.current = null;
      }
    })();
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf.id);
      playingRef.current?.stop();
      playingRef.current = null;
      bonesRef.current?.dispose();
      bonesRef.current = null;
      gestures?.dispose();
      presenter?.dispose();
      loaded?.dispose();
      sourceLoaded?.dispose();
      host?.dispose();
      hostRef.current = null;
      presenterRef.current = null;
    };
  }, [clipName, engine, sourceBytes, sourceClipBytes]);

  useEffect(() => {
    const host = hostRef.current;
    bonesRef.current?.dispose();
    bonesRef.current = null;
    if (!host || !showBones || !skeletonKind) {
      presenterRef.current?.present({ force: true });
      return;
    }
    bonesRef.current = attachSkeletonPreview(
      host.mesh,
      host.scene,
      skeletonKind,
    );
    presenterRef.current?.present({ force: true });
  }, [previewGeneration, showBones, skeletonKind]);

  return (
    <canvas
      ref={canvasRef}
      className="h-full w-full touch-none"
      data-testid="animation-preview-canvas"
    />
  );
}
