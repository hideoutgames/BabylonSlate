import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { ModelMaterialSlot, SkeletonKind } from "@haptic/assets";
import {
  attachMaterialPreviewGestures,
  attachSkeletonPreview,
  createMaterialPreviewPresenter,
  createModelPreviewScene,
  installPreviewEnvironment,
  setSceneRenderSettings,
  loadModelPreviewSource,
  previewRigRoot,
  retargetAnimationGroupWithMeshProxy,
  type MaterialPreviewPresenter,
  type MaterialPreviewScene,
} from "@haptic/render";
import { useOptionalPlay } from "../context/play-context";
import { useProjectState } from "../context/document-context";
import type { AnimationPreviewClock } from "../lib/animation-preview-clock";
import { useModelSlotMaterials } from "../lib/use-model-slot-materials";
import { watchBlockingEditorOverlay } from "../lib/viewport-render-gate";

/** The loaded clip: its length in its file's frames and, at the file's frame rate, in ms. */
export type AnimationPreviewClip = { frames: number; durationMs: number };

function previewClipOf(group: AnimationGroup): AnimationPreviewClip {
  const span = Math.max(0, group.to - group.from);
  const fps = group.targetedAnimations[0]?.animation.framePerSecond ?? 60;
  return { frames: Math.max(1, Math.round(span)), durationMs: fps > 0 ? (span / fps) * 1000 : 0 };
}

/**
 * The Animation preview's 3D view: the clip on its Model, held paused and seeked to the clock's playhead on each
 * frame, so playing, pausing, stepping and scrubbing all go through the clock.
 */
export function AnimationPreviewCanvas({
  sourceBytes,
  materialSlots,
  clipName,
  clock,
  skeletonKind = null,
  showBones = false,
  sourceClipBytes = null,
  onBonesOnlyChange,
  onClip,
}: {
  sourceBytes: Uint8Array;
  /** The Model's slots, drawn with their Materials. */
  materialSlots: readonly ModelMaterialSlot[];
  clipName: string;
  clock: AnimationPreviewClock;
  skeletonKind?: SkeletonKind | null;
  showBones?: boolean;
  sourceClipBytes?: Uint8Array | null;
  /** Reports a Model with nothing to draw (an animation library), whose bones show whatever Show Bones says. */
  onBonesOnlyChange?: (bonesOnly: boolean) => void;
  /** The loaded clip; null while none is loaded. */
  onClip?: (clip: AnimationPreviewClip | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const play = useOptionalPlay();
  const { projectDocument } = useProjectState();
  const [engine, setEngine] = useState<AbstractEngine | null>(null);
  const [previewGeneration, setPreviewGeneration] = useState(0);
  const [clipLoaded, setClipLoaded] = useState(false);
  const playback = useSyncExternalStore(clock.subscribe, clock.getPlayback, clock.getPlayback);
  const [bonesOnly, setBonesOnly] = useState(false);
  const [bonesAttached, setBonesAttached] = useState(false);
  const onBonesOnlyChangeRef = useRef(onBonesOnlyChange);
  onBonesOnlyChangeRef.current = onBonesOnlyChange;
  const onClipRef = useRef(onClip);
  onClipRef.current = onClip;
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const hostRef = useRef<MaterialPreviewScene | null>(null);
  const presenterRef = useRef<MaterialPreviewPresenter | null>(null);
  const bonesRef = useRef<{ dispose: () => void } | null>(null);
  const playingRef = useRef<AnimationGroup | null>(null);
  const { release: releaseMaterials } = useModelSlotMaterials({
    hostRef,
    engine,
    slots: materialSlots,
    generation: previewGeneration,
    onApplied: () => presenterRef.current?.present({ force: true }),
  });
  useEffect(() => {
    const host = hostRef.current;
    if (host) {
      setSceneRenderSettings(host.scene, projectDocument?.settings.render ?? {});
      presenterRef.current?.present({ force: true });
    }
  }, [projectDocument?.settings.render, previewGeneration]);

  useEffect(() => {
    setEngine(play?.ensureSharedEngine() ?? null);
  }, [play]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !engine) return;
    let cancelled = false;
    let host: MaterialPreviewScene | null = null;
    let sourceHost: MaterialPreviewScene | null = null;
    let presenter: MaterialPreviewPresenter | null = null;
    let gestures: { dispose: () => void } | null = null;
    let loaded: Awaited<ReturnType<typeof loadModelPreviewSource>> = null;
    let sourceLoaded: { dispose: () => void; animationGroups: AnimationGroup[] } | null =
      null;
    let stopRestoreWatch: (() => void) | null = null;
    const raf = { id: 0 };
    const overlay = watchBlockingEditorOverlay();
    void (async () => {
      try {
        host = createModelPreviewScene(engine);
        installPreviewEnvironment(host.scene);
        loaded = await loadModelPreviewSource(host, sourceBytes);
        if (cancelled || !host || !loaded) {
          host?.dispose();
          loaded?.dispose();
          return;
        }
        let group: AnimationGroup | null = null;
        if (sourceClipBytes && sourceClipBytes.byteLength > 0) {
          sourceHost = createModelPreviewScene(engine);
          sourceLoaded = await loadModelPreviewSource(
            sourceHost,
            sourceClipBytes,
          );
          if (cancelled) {
            sourceLoaded?.dispose();
            sourceHost.dispose();
            return;
          }
          const sourceGroup = sourceLoaded?.animationGroups.find(
            (entry) => entry.name === clipName,
          );
          if (sourceGroup) {
            group = retargetAnimationGroupWithMeshProxy(
              sourceGroup,
              previewRigRoot(host),
            );
          }
          sourceLoaded?.dispose();
          sourceLoaded = null;
          sourceHost.dispose();
          sourceHost = null;
        } else {
          group = loaded.animationGroups.find((entry) => entry.name === clipName) ?? null;
        }
        // Started and paused with live animatables, so seeking poses it; Babylon never advances it itself.
        group?.play(true);
        group?.pause();
        playingRef.current = group;
        presenter = createMaterialPreviewPresenter(host, canvas, {
          maxFps: 30,
          staticContent: true,
          suspended: overlay.isOpen,
        });
        gestures = attachMaterialPreviewGestures(canvas, host.camera, {
          onChange: () => presenter?.present({ force: true }),
        });
        hostRef.current = host;
        presenterRef.current = presenter;
        // A settled frame is not redrawn by itself, so a restored WebGL context needs a forced one.
        const restored = engine.onContextRestoredObservable;
        const restoreObserver = restored?.add(() => presenter?.present({ force: true })) ?? null;
        stopRestoreWatch = () => restored?.remove(restoreObserver);
        presenter.present({ force: true });
        setClipLoaded(Boolean(group));
        onClipRef.current?.(group ? previewClipOf(group) : null);
        setBonesOnly(!loaded.hasMesh);
        onBonesOnlyChangeRef.current?.(!loaded.hasMesh);
        setPreviewGeneration((value) => value + 1);
        // Each frame poses the clip at the clock's playhead when it moved, then redraws.
        let applied = Number.NaN;
        const tick = () => {
          if (cancelled) return;
          const at = clockRef.current.normalised();
          if (group && at !== applied) {
            applied = at;
            group.goToFrame(group.from + at * (group.to - group.from));
            presenter?.present({ force: true });
          } else {
            presenter?.present();
          }
          raf.id = window.requestAnimationFrame(tick);
        };
        raf.id = window.requestAnimationFrame(tick);
      } catch (error) {
        console.warn("[render] Animation preview failed", error);
        playingRef.current?.stop();
        stopRestoreWatch?.();
        stopRestoreWatch = null;
        presenter?.dispose();
        gestures?.dispose();
        loaded?.dispose();
        sourceLoaded?.dispose();
        sourceHost?.dispose();
        host?.dispose();
        hostRef.current = null;
        presenterRef.current = null;
        setClipLoaded(false);
        onClipRef.current?.(null);
      }
    })();
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf.id);
      overlay.dispose();
      playingRef.current?.stop();
      playingRef.current = null;
      setClipLoaded(false);
      bonesRef.current?.dispose();
      bonesRef.current = null;
      releaseMaterials();
      stopRestoreWatch?.();
      stopRestoreWatch = null;
      gestures?.dispose();
      presenter?.dispose();
      loaded?.dispose();
      sourceLoaded?.dispose();
      sourceHost?.dispose();
      host?.dispose();
      hostRef.current = null;
      presenterRef.current = null;
    };
  }, [clipName, engine, sourceBytes, sourceClipBytes, releaseMaterials]);

  useEffect(() => {
    const host = hostRef.current;
    bonesRef.current?.dispose();
    bonesRef.current = null;
    setBonesAttached(false);
    // A Model with no mesh has only its bones to show; its animated nodes are a hierarchy rig.
    const kind = skeletonKind ?? (bonesOnly ? "hierarchy" : null);
    if (!host || !(showBones || bonesOnly) || !kind) {
      presenterRef.current?.present({ force: true });
      return;
    }
    bonesRef.current = attachSkeletonPreview(
      previewRigRoot(host),
      host.scene,
      kind,
    );
    setBonesAttached(true);
    presenterRef.current?.present({ force: true });
  }, [bonesOnly, previewGeneration, showBones, skeletonKind]);

  return (
    <canvas
      ref={canvasRef}
      className="h-full w-full touch-none"
      data-testid="animation-preview-canvas"
      data-playing={clipLoaded && playback.playing ? "true" : "false"}
      data-bones-only={bonesOnly ? "true" : undefined}
      data-bones={bonesAttached ? "true" : "false"}
      data-looping={clipLoaded && playback.loop ? "true" : "false"}
    />
  );
}
