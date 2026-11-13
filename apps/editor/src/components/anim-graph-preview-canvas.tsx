import { useEffect, useRef, useState } from "react";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { AnimEvalState } from "@haptic/anim-graph";
import type { ModelMaterialSlot, SkeletonKind } from "@haptic/assets";
import {
  applyAnimStateToScene,
  attachMaterialPreviewGestures,
  attachSkeletonPreview,
  bindAnimationGroupByName,
  createEditorGrid,
  createMaterialPreviewPresenter,
  createModelPreviewScene,
  installPreviewEnvironment,
  loadModelPreviewSource,
  previewRigRoot,
  retargetAnimationGroupWithMeshProxy,
  setSceneRenderSettings,
  wrapGameplayAnimationGroup,
  type EditorGrid,
  type MaterialPreviewPresenter,
  type MaterialPreviewScene,
  type NamedSeekableGroup,
} from "@haptic/render";
import { useOptionalPlay } from "../context/play-context";
import { useProjectState } from "../context/document-context";
import { useModelSlotMaterials } from "../lib/use-model-slot-materials";
import { watchBlockingEditorOverlay } from "../lib/viewport-render-gate";

/**
 * Where an Animation the graph plays comes from on the preview Model: one of its own clips, a clip of another Model
 * on the same Skeleton (bound by bone name), or a retargeted clip of a Model on another Skeleton.
 */
export type AnimPreviewClip = {
  animationGuid: string;
  clipName: string;
  source: { kind: "own" } | { kind: "bind" | "retarget"; modelGuid: string };
};

/** A stable key for a clip list, so the canvas reloads only when the clips it binds change. */
export function animPreviewClipsKey(clips: readonly AnimPreviewClip[]): string {
  return clips
    .map((clip) => [clip.animationGuid, clip.clipName, clip.source.kind, "modelGuid" in clip.source ? clip.source.modelGuid : ""].join(":"))
    .join("|");
}

/** The evaluation as Play's `animState` command, which `applyAnimStateToScene` seeks the clips from. */
function animStateCommand(state: AnimEvalState) {
  const heaviest = state.layers.reduce<AnimEvalState["layers"][number] | undefined>(
    (best, layer) => (!best || layer.weight > best.weight ? layer : best),
    undefined,
  );
  return {
    type: "animState" as const,
    slotId: 0,
    stateId: state.stateId,
    normalisedTime: state.normalisedTime,
    blendWeights: state.blendWeights,
    clipName: heaviest?.clipName ?? "",
    clipKind: heaviest?.clipKind ?? "animation",
    clipAssetGuid: heaviest?.clipAssetGuid ?? "",
    justFinished: state.facts.justFinished,
    justLooped: state.facts.justLooped,
    layers: state.layers,
  };
}

/**
 * The Animation Graph Preview's 3D view: the preview Model on a floor grid, playing the clip layers of each evaluation
 * the way Play seeks them, drawn on the project's shared Engine. Bones replace the mesh while `showBones` is on.
 */
export function AnimGraphPreviewCanvas({
  modelBytes,
  materialSlots,
  importScale,
  clips,
  readModelBytes,
  skeletonKind,
  showBones,
  getState,
  subscribe,
}: {
  modelBytes: Uint8Array;
  materialSlots: readonly ModelMaterialSlot[];
  importScale: number;
  clips: readonly AnimPreviewClip[];
  /** Another Model's file, for clips the preview Model does not hold itself. */
  readModelBytes: (modelGuid: string) => Promise<Uint8Array>;
  skeletonKind: SkeletonKind | null;
  showBones: boolean;
  getState: () => AnimEvalState | null;
  subscribe: (listener: () => void) => () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const play = useOptionalPlay();
  const { projectDocument } = useProjectState();
  const [engine, setEngine] = useState<AbstractEngine | null>(null);
  const [generation, setGeneration] = useState(0);
  const [bonesAttached, setBonesAttached] = useState(false);
  const [boundClips, setBoundClips] = useState(0);
  const hostRef = useRef<MaterialPreviewScene | null>(null);
  const presenterRef = useRef<MaterialPreviewPresenter | null>(null);
  const bonesRef = useRef<{ dispose: () => void } | null>(null);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const readRef = useRef(readModelBytes);
  readRef.current = readModelBytes;
  const stateRef = useRef({ getState, subscribe });
  stateRef.current = { getState, subscribe };
  const clipsKey = animPreviewClipsKey(clips);
  const { release: releaseMaterials } = useModelSlotMaterials({
    hostRef,
    engine,
    slots: materialSlots,
    generation,
    onApplied: () => presenterRef.current?.present({ force: true }),
  });

  useEffect(() => {
    setEngine(play?.ensureSharedEngine() ?? null);
  }, [play]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setSceneRenderSettings(host.scene, projectDocument?.settings.render ?? {});
    presenterRef.current?.present({ force: true });
  }, [projectDocument?.settings.render, generation]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !engine) return;
    let cancelled = false;
    let host: MaterialPreviewScene | null = null;
    let presenter: MaterialPreviewPresenter | null = null;
    let gestures: { dispose: () => void } | null = null;
    let grid: EditorGrid | null = null;
    let loaded: Awaited<ReturnType<typeof loadModelPreviewSource>> = null;
    let unsubscribe: (() => void) | null = null;
    const groups: Array<NamedSeekableGroup & { dispose(): void; retire(): void }> = [];
    // The Model's own clips go with the Model; clips bound from other files are this preview's to dispose.
    const ownGroups = new Set<NamedSeekableGroup>();
    const raf = { id: 0 };
    const overlay = watchBlockingEditorOverlay();
    const dispose = () => {
      window.cancelAnimationFrame(raf.id);
      unsubscribe?.();
      for (const group of groups) {
        if (ownGroups.has(group)) group.retire();
        else group.dispose();
      }
      groups.length = 0;
      ownGroups.clear();
      gestures?.dispose();
      presenter?.dispose();
      grid?.dispose();
      loaded?.dispose();
      host?.dispose();
      hostRef.current = null;
      presenterRef.current = null;
    };
    void (async () => {
      try {
        host = createModelPreviewScene(engine);
        installPreviewEnvironment(host.scene);
        grid = createEditorGrid(host.scene, { camera: host.camera });
        loaded = await loadModelPreviewSource(host, modelBytes, importScale);
        if (cancelled || !loaded) {
          dispose();
          return;
        }
        const rig = previewRigRoot(host);
        // Clips from other files load in a throwaway scene, bound onto this rig, then the source goes.
        const sources = new Map<string, { scene: MaterialPreviewScene; loaded: { dispose(): void; animationGroups: AnimationGroup[] } }>();
        for (const clip of clipsRef.current) {
          let group: AnimationGroup | null = null;
          if (clip.source.kind === "own") {
            group = loaded.animationGroups.find((entry) => entry.name === clip.clipName) ?? null;
          } else {
            let source = sources.get(clip.source.modelGuid);
            if (!source) {
              const scene = createModelPreviewScene(engine);
              const bytes = await readRef.current(clip.source.modelGuid).catch(() => null);
              const sourceLoaded = bytes ? await loadModelPreviewSource(scene, bytes) : null;
              if (!sourceLoaded) {
                scene.dispose();
                continue;
              }
              source = { scene, loaded: sourceLoaded };
              sources.set(clip.source.modelGuid, source);
            }
            if (cancelled) break;
            const sourceGroup = source.loaded.animationGroups.find((entry) => entry.name === clip.clipName);
            if (sourceGroup) {
              group = clip.source.kind === "bind"
                ? bindAnimationGroupByName(sourceGroup, rig)
                : retargetAnimationGroupWithMeshProxy(sourceGroup, rig);
            }
          }
          if (!group) continue;
          const wrapped = wrapGameplayAnimationGroup(group, clip.animationGuid);
          if (clip.source.kind === "own") ownGroups.add(wrapped);
          groups.push(wrapped);
        }
        for (const source of sources.values()) {
          source.loaded.dispose();
          source.scene.dispose();
        }
        if (cancelled) {
          dispose();
          return;
        }
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
        setBoundClips(groups.length);
        setGeneration((value) => value + 1);
        // Each evaluation seeks the clips as Play does; the frame is redrawn once it lands.
        const animHost = { getAnimationGroups: () => groups };
        let applied: AnimEvalState | null = null;
        let pending = true;
        unsubscribe = stateRef.current.subscribe(() => {
          pending = true;
        });
        const tick = () => {
          if (cancelled) return;
          const state = stateRef.current.getState();
          if (pending && state && state !== applied) {
            applied = state;
            applyAnimStateToScene(animHost, animStateCommand(state));
            presenter?.present({ force: true });
          } else {
            grid?.sync();
            presenter?.present();
          }
          pending = false;
          raf.id = window.requestAnimationFrame(tick);
        };
        raf.id = window.requestAnimationFrame(tick);
      } catch (error) {
        console.warn("[render] Animation Graph preview failed", error);
        dispose();
      }
    })();
    return () => {
      cancelled = true;
      overlay.dispose();
      bonesRef.current?.dispose();
      bonesRef.current = null;
      releaseMaterials();
      dispose();
    };
    // `clips` and `readModelBytes` are read through refs; the key says when the clip set changed.
  }, [clipsKey, engine, importScale, modelBytes, releaseMaterials]);

  useEffect(() => {
    const host = hostRef.current;
    bonesRef.current?.dispose();
    bonesRef.current = null;
    setBonesAttached(false);
    if (!host || !showBones || !skeletonKind) {
      presenterRef.current?.present({ force: true });
      return;
    }
    bonesRef.current = attachSkeletonPreview(previewRigRoot(host), host.scene, skeletonKind);
    setBonesAttached(true);
    presenterRef.current?.present({ force: true });
  }, [generation, showBones, skeletonKind]);

  return (
    <canvas
      ref={canvasRef}
      className="h-full w-full touch-none"
      data-testid="anim-preview-canvas"
      data-bones={bonesAttached ? "true" : "false"}
      data-clips={String(boundClips)}
    />
  );
}
