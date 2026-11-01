import type { AbstractEngine } from "@babylonjs/core";
import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AssetLoadError } from "@haptic/assets";
import { applyTimelineClipToScene, type SerializedScene } from "@haptic/core";
import { createEngine, EDITOR_CANVAS_COLOR_SCHEME, syncEditorPlayState, type EngineHandle } from "@haptic/render";
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
import { composeTimelineProxyPreview, timelineProxyPreviewScene } from "../lib/timeline-proxy-scene";

/**
 * Viewport window of a 2D or 3D Timeline Clip asset: an editor-only preview
 * of its proxies, each drawn by its Editor Preview representation and
 * animated by the clip at the Timeline playhead. It renders to a texture on
 * the shared Engine like the Prefab viewport, and edits nothing: tapping a
 * proxy selects it in Proxies and the Inspector.
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
  const { id: documentId, payload, twoD } = useTimelineClipAsset();
  const { scene, clip, tools } = useTimelineClip();
  const selectedProxy = useSelectedProxy(documentId);
  const { viewportMode, gridVisible, saveEditorCameraPose, loadEditorCameraPose, viewportShadingMode, pivotAroundCenter } = useSceneEditing();
  const { flySpeed, gridSize } = useEditorViewportPrefs();
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

  useEffect(() => {
    engineRef.current?.editor?.setViewportMode(viewportMode);
  }, [viewportMode, engineEpoch]);

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
          {/* A preview: the proxies move with the clip, and are placed in the Inspector. */}
          <ViewportToolbar testIdPrefix="timeline-clip-" showDragSelect={false} showViewportModeToggle={false} showGameCamera={false} showGizmoTools={false} />
        </div>
      </div>
      <canvas ref={canvasRef} className="h-full min-h-0 min-w-0 w-full flex-1 touch-none" data-testid="timeline-clip-preview-canvas" />
    </div>
  );
}
