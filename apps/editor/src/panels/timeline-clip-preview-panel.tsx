import type { AbstractEngine } from "@babylonjs/core";
import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AssetLoadError } from "@haptic/assets";
import { applyTimelineClipToScene, type SerializedScene } from "@haptic/core";
import { createEngine, EDITOR_CANVAS_COLOR_SCHEME, syncEditorPlayState, type EngineHandle } from "@haptic/render";
import { isTestModeEnabled } from "@haptic/vfs";
import { ViewportToolbar } from "../components/viewport-toolbar";
import { selectProxy, TimelineClipAssetSource, useSelectedProxy, useTimelineClipAsset } from "../components/timeline-clip-asset-editor";
import { usePlay } from "../context/play-context";
import { useDocumentActions, useProjectState } from "../context/document-context";
import { SceneEditingProvider, useSceneEditing } from "../context/scene-editing-context";
import { useTimelineClip } from "../context/use-timeline-clip";
import { editorViewportPausedForSession } from "../lib/preview-build-handoff";
import { attachViewportRenderGate } from "../lib/viewport-render-gate";
import { useEditorViewportPrefs } from "../lib/viewport-engine-prefs";
import { editorDracoPublicBase, editorKtx2PublicBase, editorMeshoptPublicBase } from "../lib/public-engine-assets";
import { createCanvasResizeGuard } from "../lib/canvas-resize-guard";
import { modelSlotMaterialGuidsFromPayloads, overlayTextureGuidsFromScene } from "../lib/play-content";
import { composeTimelineProxyPreview, timelineProxyGizmoEdit, timelineProxyPreviewScene } from "../lib/timeline-proxy-scene";

/**
 * Viewport window of a 2D or 3D Timeline Clip asset: an editor-only preview
 * of its proxies, each drawn by its Editor Preview representation and
 * animated by the clip at the Timeline playhead. It renders to a texture on
 * the shared Engine like the Prefab viewport. Tapping a proxy selects it in
 * Proxies and the Inspector; its gizmo keys the proxy's transform tracks
 * (Auto Key) or sets unkeyed values, and moves its preview placement where it
 * has no track (`timelineProxyGizmoEdit`).
 */
export function TimelineClipPreviewPanel(props: IDockviewPanelProps) {
  const { id, twoD } = useTimelineClipAsset();
  return <SceneEditingProvider
    documentId={id}
    initialViewportMode={twoD ? "2d" : "3d"}
    documentViewportMode={twoD ? "2d" : "3d"}
    initialViewportShadingMode={twoD ? "unlit" : "pbr"}
  >
    <TimelineClipAssetSource><ClipPreview {...props} /></TimelineClipAssetSource>
  </SceneEditingProvider>;
}

/** The scene the viewport loads: every asset a representation draws, so a scrub never re-collects them. */
function previewLoadKey(scene: SerializedScene): string {
  return JSON.stringify(scene.actors.map((actor) => [actor.id, actor.components.map((component) => [component.id, component.classId, component.properties])]));
}

function ClipPreview(_props: IDockviewPanelProps) {
  void _props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<EngineHandle | null>(null);
  const viewportId = useId();
  const { id: documentId, payload, twoD, commit } = useTimelineClipAsset();
  const { scene, clip, tools } = useTimelineClip();
  const selectedProxy = useSelectedProxy(documentId);
  const {
    viewportMode, gridVisible, saveEditorCameraPose, loadEditorCameraPose, viewportShadingMode, pivotAroundCenter,
    gizmoTool, gizmoSpace, snapEnabled,
  } = useSceneEditing();
  const { flySpeed, gridSize, snapTranslate, snapRotateDeg, snapScale } = useEditorViewportPrefs();
  const flySpeedRef = useRef(flySpeed);
  flySpeedRef.current = flySpeed;
  const { registerScheduler, playing, preparing, ensureSharedEngine, sharedEngineGeneration } = usePlay();
  const { projectDocument } = useProjectState();
  const {
    collectPlayModelBytes,
    collectPlayModelPayloads,
    collectPlayMaterialLibrary,
    collectPlayTextureBytes,
    collectPlayTexturePixelSizes,
  } = useDocumentActions();
  const [sharedEngine, setSharedEngine] = useState<AbstractEngine | null>(null);
  const [engineEpoch, setEngineEpoch] = useState(0);

  // The proxies as drawn, before the clip moves them.
  const base = useMemo(() => (scene ? timelineProxyPreviewScene(scene, payload, twoD) : null), [payload, scene, twoD]);
  const loadKey = useMemo(() => (base ? previewLoadKey(base) : ""), [base]);
  const shown = (time: number) => (base && clip
    ? composeTimelineProxyPreview(applyTimelineClipToScene(base, clip, Math.min(clip.length, Math.max(0, time)), tools.timelineUnkeyed), payload)
    : base);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  // A released gizmo: keys, unkeyed values or a moved placement, in one undo step.
  const commitGizmo = () => {
    const handle = engineRef.current;
    const lives = handle?.editor?.selectedActorTransforms() ?? [];
    if (!handle || !scene || !clip || lives.length === 0) return;
    const time = Math.min(clip.length, Math.max(0, tools.timelinePlayhead.get()));
    const edit = timelineProxyGizmoEdit(payload, scene, time, lives, {
      autoKey: tools.timelineAutoKey, unkeyed: tools.timelineUnkeyed, newId: () => crypto.randomUUID(),
    });
    if (edit.unkeyed.size) tools.setTimelineUnkeyed(new Map([...tools.timelineUnkeyed, ...edit.unkeyed]));
    if (edit.payload !== payload) {
      commit(edit.payload, `timeline-clip-asset:gizmo:${crypto.randomUUID()}`);
      return;
    }
    if (edit.unkeyed.size) return;
    // Nothing holds the change: the proxy returns to where the clip puts it.
    // The engine re-poses only actors whose loaded pose changed, so it first learns where the gizmo left them.
    const current = shownRef.current(time);
    if (!current) return;
    const live = new Map(lives.map((entry) => [entry.actorId, entry]));
    handle.loadScene({ ...current, actors: current.actors.map((actor) => {
      const moved = live.get(actor.id);
      return moved ? { ...actor, transform: { position: moved.position, rotation: moved.rotation, scale: moved.scale } } : actor;
    }) });
    handle.loadScene(current);
  };
  const commitGizmoRef = useRef(commitGizmo);
  commitGizmoRef.current = commitGizmo;

  useEffect(() => {
    setSharedEngine(ensureSharedEngine());
  }, [ensureSharedEngine, sharedEngineGeneration]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !sharedEngine) return;
    const handle = createEngine(canvas, {
      editor: true,
      editorViewportId: viewportId,
      previewLighting: !twoD,
      sharedEngine,
      present: "rtt",
      viewportMode: twoD ? "2d" : "3d",
      overlayTransformBox: twoD,
      colorScheme: EDITOR_CANVAS_COLOR_SCHEME,
      ktx2BasePath: editorKtx2PublicBase(),
      dracoBasePath: editorDracoPublicBase(),
      meshoptBasePath: editorMeshoptPublicBase(),
      onPickActor: (actorId) => selectProxy(documentId, actorId),
      onGizmoDragEnd: () => commitGizmoRef.current(),
      editorFlySpeed: () => flySpeedRef.current,
    });
    engineRef.current = handle;
    setEngineEpoch((epoch) => epoch + 1);
    handle.editor?.camera.importSessionState(loadEditorCameraPose());
    const unregisterScheduler = registerScheduler({
      setAlwaysRender: (value) => handle.scheduler.setAlwaysRender(value),
      setPaused: (value) => handle.setPaused(value),
      holdFrames: () => handle.scheduler.acquireObstruction(),
    });
    const detachRenderGate = attachViewportRenderGate({
      canvas,
      scheduler: handle.scheduler,
      scaling: handle.scaling,
      setLocalQualityOverrides: (overrides) => handle.setLocalQualityOverrides(overrides),
      setPostProcessingEnabled: (enabled) => handle.setPostProcessingEnabled(enabled),
      setTextureBudget: (bytes, enabled) => handle.setTextureBudget(bytes, enabled),
      setAudioBudget: (bytes, enabled) => handle.setAudioBudget(bytes, enabled),
      setMaxVoices: (maxVoices) => handle.setMaxVoices(maxVoices),
    });
    const resizeIfSized = createCanvasResizeGuard(() => handle.resize(), {
      onHoldChange: (holding) => handle.scheduler.setResizing(holding),
    });
    resizeIfSized(canvas);
    const resizeObserver = new ResizeObserver(() => resizeIfSized(canvas));
    resizeObserver.observe(canvas);
    return () => {
      resizeIfSized.dispose();
      resizeObserver.disconnect();
      detachRenderGate();
      unregisterScheduler();
      if (handle.editor) saveEditorCameraPose(handle.editor.camera.exportSessionState());
      handle.dispose();
      engineRef.current = null;
    };
    // Mode, grid and selection are pushed below; remount when the app Engine swaps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedEngine, twoD, viewportId, documentId]);

  useEffect(() => {
    if (engineRef.current) syncEditorPlayState(engineRef.current, editorViewportPausedForSession({ playing, preparing }));
  }, [playing, preparing, engineEpoch]);

  useEffect(() => {
    engineRef.current?.setRenderSettings(projectDocument?.settings.render ?? {});
  }, [projectDocument?.settings.render, engineEpoch]);

  // The document or an unkeyed change: the proxies at the playhead.
  useEffect(() => {
    const next = shownRef.current(tools.timelinePlayhead.get());
    if (next) engineRef.current?.loadScene(next);
  }, [base, clip, tools.timelinePlayhead, tools.timelineUnkeyed, engineEpoch]);

  // Scrubbing and playback move the proxies without React state.
  useEffect(() => tools.timelinePlayhead.subscribe(() => {
    const next = shownRef.current(tools.timelinePlayhead.get());
    if (next) engineRef.current?.loadScene(next);
  }), [tools.timelinePlayhead]);

  // The Models, Materials and Textures the representations draw.
  useEffect(() => {
    const handle = engineRef.current;
    if (!handle || !base) return;
    let cancelled = false;
    void (async () => {
      try {
        const modelBytes = await collectPlayModelBytes(base);
        const modelPayloads = await collectPlayModelPayloads(base);
        const materials = await collectPlayMaterialLibrary(base, [], modelSlotMaterialGuidsFromPayloads(modelPayloads));
        const textureGuids = [...materials.textureGuids, ...overlayTextureGuidsFromScene(base)];
        const textureBytes = await collectPlayTextureBytes(new Map(), new Map(), textureGuids);
        const texturePixelSizes = collectPlayTexturePixelSizes(new Map(), new Map(), textureGuids);
        if (cancelled || engineRef.current !== handle) return;
        handle.setMaterialDocuments(materials.documents, materials.functions);
        handle.setMeshAssets({
          resourceCache: handle.resourceCache,
          textureBytes,
          texturePixelSizes,
          modelBytes,
          modelPayloads,
          pixelsPerUnit: projectDocument?.settings.twoD.pixelsPerUnit,
          sortingLayers: projectDocument?.settings.twoD.sortingLayers,
        });
      } catch (error) {
        if (cancelled || engineRef.current !== handle) return;
        if (error instanceof AssetLoadError && error.code === "cancelled") return;
        console.error("[timeline clip] failed to load preview assets", error);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Keyed on what the representations draw, not on the scene's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey, engineEpoch, projectDocument?.settings.twoD.pixelsPerUnit, projectDocument?.settings.twoD.sortingLayers]);

  useEffect(() => {
    engineRef.current?.editor?.setSelectedActors(selectedProxy ? [selectedProxy] : []);
  }, [selectedProxy, engineEpoch, loadKey]);

  // Test builds: where each proxy is drawn, and the playhead, for browser specs.
  useEffect(() => {
    if (import.meta.env.VITE_TEST_MODE !== "true" || !isTestModeEnabled()) return;
    const host = globalThis as unknown as { __hapticClipPreviewTest?: unknown };
    host.__hapticClipPreviewTest = {
      proxyPositions: () => {
        const sync = engineRef.current?.editor?.sync;
        const out: Record<string, { root: [number, number, number] | null; visual: [number, number, number] | null }> = {};
        for (const actor of base?.actors ?? []) {
          const root = sync?.meshForActor(actor.id) ?? null;
          const visual = sync?.visualMeshesForActor(actor.id)[0] ?? null;
          visual?.computeWorldMatrix(true);
          const at = visual?.getAbsolutePosition();
          out[actor.id] = {
            root: root ? [root.position.x, root.position.y, root.position.z] : null,
            visual: at ? [at.x, at.y, at.z] : null,
          };
        }
        return out;
      },
      setPlayhead: (time: number) => tools.timelinePlayhead.set(time),
      // A gizmo drag of one proxy by (dx, dy, dz), scaled by `scale`, released.
      nudgeProxy: (actorId: string, dx: number, dy: number, dz: number, scale = 1) => {
        const handle = engineRef.current;
        const mesh = handle?.editor?.sync.meshForActor(actorId);
        if (!handle?.editor || !mesh) return false;
        selectProxy(documentId, actorId);
        handle.editor.setSelectedActors([actorId]);
        mesh.position.x += dx;
        mesh.position.y += dy;
        mesh.position.z += dz;
        mesh.scaling.scaleInPlace(scale);
        commitGizmoRef.current();
        return true;
      },
      // The 2D transform box's centre and size, as laid out now.
      overlayBox: () => {
        const util = engineRef.current?.editor?.gizmos.layer.utilityLayerScene;
        const root = util?.getTransformNodeByName("overlay-box-root");
        const size = util?.getTransformNodeByName("overlay-box-scale");
        if (!root || !size || !root.isEnabled()) return null;
        return { center: [root.position.x, root.position.y], size: [size.scaling.x, size.scaling.y] };
      },
      // A proxy's drawn bounds, centre and size.
      proxyBounds: (actorId: string) => {
        const meshes = engineRef.current?.editor?.sync.visualMeshesForActor(actorId) ?? [];
        if (meshes.length === 0) return null;
        let min = [Infinity, Infinity];
        let max = [-Infinity, -Infinity];
        for (const mesh of meshes) {
          mesh.computeWorldMatrix(true);
          const box = mesh.getBoundingInfo().boundingBox;
          min = [Math.min(min[0]!, box.minimumWorld.x), Math.min(min[1]!, box.minimumWorld.y)];
          max = [Math.max(max[0]!, box.maximumWorld.x), Math.max(max[1]!, box.maximumWorld.y)];
        }
        return { center: [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2], size: [max[0]! - min[0]!, max[1]! - min[1]!] };
      },
    };
    return () => { delete host.__hapticClipPreviewTest; };
  }, [base, documentId, engineEpoch, tools.timelinePlayhead]);

  useEffect(() => {
    engineRef.current?.editor?.setViewportMode(viewportMode);
  }, [viewportMode, engineEpoch]);

  useEffect(() => {
    engineRef.current?.editor?.gizmos.setTool(gizmoTool);
  }, [gizmoTool, engineEpoch]);

  useEffect(() => {
    engineRef.current?.editor?.gizmos.setSpace(gizmoSpace);
  }, [gizmoSpace, engineEpoch]);

  useEffect(() => {
    engineRef.current?.editor?.gizmos.setSnap({ enabled: snapEnabled, translate: snapTranslate, rotateDeg: snapRotateDeg, scale: snapScale });
  }, [snapEnabled, snapTranslate, snapRotateDeg, snapScale, engineEpoch]);

  useEffect(() => {
    engineRef.current?.editor?.setViewportShadingMode(viewportShadingMode);
  }, [viewportShadingMode, engineEpoch]);

  useEffect(() => {
    engineRef.current?.editor?.camera.setPivotAroundCenter(pivotAroundCenter);
  }, [pivotAroundCenter, engineEpoch]);

  useEffect(() => {
    engineRef.current?.editor?.setGridSettings({
      tileSize: gridSize,
      tileSubdivisions: 4,
      cameraBounds2D: base?.settings.cameraBounds2D ?? { width: 16, height: 9 },
      showGrid: gridVisible,
    });
    if (!twoD) engineRef.current?.editor?.grid.setCameraBounds(null);
  }, [base?.settings.cameraBounds2D, gridSize, gridVisible, twoD, engineEpoch]);

  return (
    <div className="relative flex h-full min-h-0 min-w-0 w-full flex-col bg-background" data-testid="timeline-clip-preview-panel">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-2">
        <div className="pointer-events-auto toolbar-island">
          {/* The proxies move with the clip; the gizmo keys them or moves their preview placement. */}
          <ViewportToolbar testIdPrefix="timeline-clip-" showDragSelect={false} showViewportModeToggle={false} showGameCamera={false} />
        </div>
      </div>
      <canvas ref={canvasRef} className="h-full min-h-0 min-w-0 w-full flex-1 touch-none" data-testid="timeline-clip-preview-canvas" />
    </div>
  );
}
