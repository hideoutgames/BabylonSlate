import type { Engine } from "@babylonjs/core";
import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createEngine,
  EDITOR_CANVAS_COLOR_SCHEME,
  applyViewportJoystickSteer,
  syncEditorPlayState,
  type EngineHandle,
} from "@babylonslate/render";
import { isTestModeEnabled } from "@babylonslate/vfs";
import { ViewportToolbar } from "../components/viewport-toolbar";
import { ViewportJoystick } from "../components/viewport-joystick";
import { usePrefabEditing } from "../context/prefab-editing-context";
import { usePlay } from "../context/play-context";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { walkAncestry } from "@babylonslate/editor-kit";
import {
  classIdFromClassAsset,
  classParentLookup,
} from "../lib/content-browser-helpers";
import { useSceneEditing } from "../context/scene-editing-context";
import { editorViewportPausedForSession } from "../lib/preview-build-handoff";
import { attachViewportRenderGate } from "../lib/viewport-render-gate";
import { useEditorViewportPrefs } from "../lib/viewport-engine-prefs";
import {
  previewSceneFor,
  PREFAB_ROOT_ID,
  prefabPreviewLoadKey,
  prefabSelectedActorIds,
  prefabSelectedIdFromPick,
} from "../lib/prefab-preview";
import { editorKtx2PublicBase } from "../lib/public-engine-assets";
import { createCanvasResizeGuard } from "../lib/canvas-resize-guard";
import {
  modelSlotMaterialGuidsFromPayloads,
  overlayTextureGuidsFromScene,
  skyboxFaceGuidsFromScene,
} from "../lib/play-content";
import { fontMsdfMapsFromPairs } from "../lib/play-fonts";

/**
 * Full-size Prefab viewport for class documents. Sibling of Graph in the
 * center Dockview group so selecting the tab fills the workspace.
 */
export function PrefabViewportPanel(_props: IDockviewPanelProps) {
  void _props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<EngineHandle | null>(null);
  const joystickLeaseRef = useRef<(() => void) | null>(null);
  const {
    components,
    selectedId,
    setSelectedId,
    updateComponentTransform,
    applyPivotTransform,
  } = usePrefabEditing();
  const {
    collectPlaySpritePayloads,
    collectPlayTilemapContent,
    collectPlayTextureBytes,
    collectPlayFontFacetypeBytes,
    collectPlayFontMsdfPair,
    collectPlayFontFaceEntries,
    collectPlayFontCssStacks,
    collectPlayModelBytes,
    collectPlayModelPayloads,
    collectPlayMaterialLibrary,
    projectDocument,
    openDocuments,
    assetRegistry,
  } = useDocuments();
  const { documentId } = useDocumentWorkspace();
  const overlayPrefab = useMemo(() => {
    const doc = openDocuments.find((entry) => entry.id === documentId);
    const listed = assetRegistry?.list() ?? [];
    const indexed = listed.find((asset) => asset.path === doc?.ref.path);
    if (!indexed) return false;
    return walkAncestry(
      classIdFromClassAsset(indexed),
      classParentLookup(listed),
    ).includes("SceneLayerActor");
  }, [assetRegistry, documentId, openDocuments]);
  const {
    gizmoTool,
    snapEnabled,
    viewportMode,
    joystickEnabled,
    gridVisible,
    saveEditorCameraPose,
    loadEditorCameraPose,
    pivotAroundCenter,
    viewportShadingMode,
    setFrameActorHandler,
  } = useSceneEditing();
  const { flySpeed, gridSize, editorTextureLodEnabled, editorTextureLodQuality } =
    useEditorViewportPrefs();
  const flySpeedRef = useRef(flySpeed);
  flySpeedRef.current = flySpeed;
  const { registerScheduler, playing, preparing, ensureSharedEngine, sharedEngineGeneration } =
    usePlay();
  const [sharedEngine, setSharedEngine] = useState<Engine | null>(null);
  const setSelectedIdRef = useRef(setSelectedId);
  setSelectedIdRef.current = setSelectedId;
  const componentsRef = useRef(components);
  componentsRef.current = components;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const updateComponentTransformRef = useRef(updateComponentTransform);
  updateComponentTransformRef.current = updateComponentTransform;
  const applyPivotTransformRef = useRef(applyPivotTransform);
  applyPivotTransformRef.current = applyPivotTransform;

  useEffect(() => {
    setSharedEngine(ensureSharedEngine());
  }, [ensureSharedEngine, sharedEngineGeneration]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !sharedEngine) return;
    const handle = createEngine(canvas, {
      editor: true,
      sharedEngine,
      present: "rtt",
      viewportMode,
      colorScheme: EDITOR_CANVAS_COLOR_SCHEME,
      ktx2BasePath: editorKtx2PublicBase(),
      onPickActor: (actorId) => {
        const ids = new Set(componentsRef.current.map((component) => component.id));
        setSelectedIdRef.current(prefabSelectedIdFromPick(actorId, ids));
      },
      onGizmoDragEnd: () => {
        const live = engineRef.current?.editor?.attachedActorTransform();
        const selected = selectedIdRef.current;
        if (!live || !selected) return;
        const transform = {
          position: live.position,
          rotation: live.rotation,
          scale: live.scale,
        };
        if (selected === PREFAB_ROOT_ID) {
          applyPivotTransformRef.current(transform);
          return;
        }
        updateComponentTransformRef.current(selected, transform);
      },
      editorFlySpeed: () => flySpeedRef.current,
    });
    engineRef.current = handle;
    handle.editor?.camera.importSessionState(loadEditorCameraPose());
    handle.editor?.setPreviewCanvas(previewCanvasRef.current);
    const unregisterScheduler = registerScheduler({
      setAlwaysRender: (v) => handle.scheduler.setAlwaysRender(v),
      setPaused: (v) => handle.setPaused(v),
    });
    const detachRenderGate = attachViewportRenderGate({
      canvas,
      scheduler: handle.scheduler,
      scaling: handle.scaling,
      setPostProcessingEnabled: (enabled) =>
        handle.setPostProcessingEnabled(enabled),
      setTextureBudget: (bytes, enabled) =>
        handle.setTextureBudget(bytes, enabled),
      setAudioBudget: (bytes, enabled) =>
        handle.setAudioBudget(bytes, enabled),
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
      joystickLeaseRef.current?.();
      joystickLeaseRef.current = null;
      if (handle.editor) {
        saveEditorCameraPose(handle.editor.camera.exportSessionState());
      }
      handle.dispose();
      engineRef.current = null;
    };
    // Mode/tool changes are pushed below; remount when the app Engine swaps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedEngine]);

  useEffect(() => {
    if (engineRef.current) {
      syncEditorPlayState(
        engineRef.current,
        editorViewportPausedForSession({ playing, preparing }),
      );
    }
  }, [playing, preparing]);

  const previewLoadKey = prefabPreviewLoadKey(components);

  useEffect(() => {
    const handle = engineRef.current;
    if (!handle) return;
    const scene = previewSceneFor(componentsRef.current);
    handle.loadScene(scene);
    let cancelled = false;
    void (async () => {
      try {
        const sprites = await collectPlaySpritePayloads(scene);
        const tileContent = await collectPlayTilemapContent(scene);
        const modelBytes = await collectPlayModelBytes(scene);
        const modelPayloads = await collectPlayModelPayloads(scene);
        const materials = await collectPlayMaterialLibrary(
          scene,
          [],
          modelSlotMaterialGuidsFromPayloads(modelPayloads),
        );
        const textureBytes = await collectPlayTextureBytes(
          sprites,
          tileContent.tilesets,
          [
            ...materials.textureGuids,
            ...skyboxFaceGuidsFromScene(scene),
            ...overlayTextureGuidsFromScene(scene),
          ],
        );
        const fontFacetypeBytes = await collectPlayFontFacetypeBytes(scene);
        const msdf = fontMsdfMapsFromPairs(await collectPlayFontMsdfPair(scene));
        const fontFaceEntries = await collectPlayFontFaceEntries();
        const fontCss = collectPlayFontCssStacks();
        if (cancelled || engineRef.current !== handle) return;
        handle.setMaterialDocuments(
          materials.documents,
          materials.functions,
        );
        await handle.registerFonts(fontFaceEntries);
        handle.setMeshAssets({
          resourceCache: handle.resourceCache,
          spritePayloads: sprites,
          tilemaps: tileContent.tilemaps,
          tilesets: tileContent.tilesets,
          textureBytes,
          fontFacetypeBytes,
          fontMsdfJson: msdf.json,
          fontMsdfPng: msdf.png,
          fontCssStack: fontCss.fontCssStack,
          fontCssStackByGuid: fontCss.fontCssStackByGuid,
          modelBytes,
          modelPayloads,
          pixelsPerUnit: projectDocument?.settings.twoD.pixelsPerUnit,
        });
      } catch (error) {
        console.error("[prefab] failed to load mesh assets", error);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Key on authored payload + Engine identity, not `components` array
    // identity. PrefabEditing rebuilds that list whenever `openDocuments`
    // bumps (compiler, Save All), which cancelled in-flight material binds.
  }, [
    previewLoadKey,
    sharedEngine,
    collectPlaySpritePayloads,
    collectPlayTilemapContent,
    collectPlayTextureBytes,
    collectPlayFontFacetypeBytes,
    collectPlayFontMsdfPair,
    collectPlayFontFaceEntries,
    collectPlayFontCssStacks,
    collectPlayModelBytes,
    collectPlayModelPayloads,
    collectPlayMaterialLibrary,
    projectDocument?.settings.twoD.pixelsPerUnit,
  ]);

  const textureLodKey = `${editorTextureLodEnabled}:${editorTextureLodQuality}`;
  const textureLodKeyRef = useRef(textureLodKey);
  useEffect(() => {
    const lodChanged = textureLodKeyRef.current !== textureLodKey;
    textureLodKeyRef.current = textureLodKey;
    if (!lodChanged) return;
    const handle = engineRef.current;
    if (!handle) return;
    const scene = previewSceneFor(componentsRef.current);
    let cancelled = false;
    void (async () => {
      try {
        const sprites = await collectPlaySpritePayloads(scene);
        const tileContent = await collectPlayTilemapContent(scene);
        const modelBytes = await collectPlayModelBytes(scene);
        const modelPayloads = await collectPlayModelPayloads(scene);
        const materials = await collectPlayMaterialLibrary(
          scene,
          [],
          modelSlotMaterialGuidsFromPayloads(modelPayloads),
        );
        const textureBytes = await collectPlayTextureBytes(
          sprites,
          tileContent.tilesets,
          [
            ...materials.textureGuids,
            ...skyboxFaceGuidsFromScene(scene),
            ...overlayTextureGuidsFromScene(scene),
          ],
        );
        const fontFacetypeBytes = await collectPlayFontFacetypeBytes(scene);
        const msdf = fontMsdfMapsFromPairs(await collectPlayFontMsdfPair(scene));
        const fontFaceEntries = await collectPlayFontFaceEntries();
        const fontCss = collectPlayFontCssStacks();
        if (cancelled || engineRef.current !== handle) return;
        handle.setMaterialDocuments(materials.documents, materials.functions);
        await handle.registerFonts(fontFaceEntries);
        handle.setMeshAssets({
          resourceCache: handle.resourceCache,
          spritePayloads: sprites,
          tilemaps: tileContent.tilemaps,
          tilesets: tileContent.tilesets,
          textureBytes,
          fontFacetypeBytes,
          fontMsdfJson: msdf.json,
          fontMsdfPng: msdf.png,
          fontCssStack: fontCss.fontCssStack,
          fontCssStackByGuid: fontCss.fontCssStackByGuid,
          modelBytes,
          modelPayloads,
          pixelsPerUnit: projectDocument?.settings.twoD.pixelsPerUnit,
        });
      } catch (error) {
        console.error("[prefab] failed to refresh mesh assets", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    textureLodKey,
    collectPlaySpritePayloads,
    collectPlayTilemapContent,
    collectPlayTextureBytes,
    collectPlayFontFacetypeBytes,
    collectPlayFontMsdfPair,
    collectPlayFontFaceEntries,
    collectPlayFontCssStacks,
    collectPlayModelBytes,
    collectPlayModelPayloads,
    collectPlayMaterialLibrary,
    projectDocument?.settings.twoD.pixelsPerUnit,
  ]);

  useEffect(() => {
    const handle = engineRef.current;
    if (!handle) return;
    const byPath = new Map(
      (assetRegistry?.list({ type: "Material" }) ?? []).map((asset) => [
        asset.path,
        asset.header.guid,
      ]),
    );
    const guids = new Set<string>();
    for (const doc of openDocuments) {
      if (doc.ref.kind !== "material") continue;
      const guid = byPath.get(doc.ref.path);
      if (guid) guids.add(guid);
    }
    handle.setEditingMaterialGuids(guids);
  }, [openDocuments, assetRegistry, sharedEngine]);

  useEffect(() => {
    engineRef.current?.editor?.setViewportMode(viewportMode);
  }, [viewportMode]);

  useEffect(() => {
    engineRef.current?.editor?.setViewportShadingMode(viewportShadingMode);
  }, [viewportShadingMode]);

  useEffect(() => {
    engineRef.current?.editor?.camera.setPivotAroundCenter(pivotAroundCenter);
  }, [pivotAroundCenter]);

  useEffect(() => {
    setFrameActorHandler((actorId) => {
      engineRef.current?.editor?.frameActor(actorId);
    });
    return () => setFrameActorHandler(null);
  }, [setFrameActorHandler]);

  useEffect(() => {
    engineRef.current?.editor?.gizmos.setTool(gizmoTool);
  }, [gizmoTool]);

  useEffect(() => {
    engineRef.current?.editor?.gizmos.setSnap({
      enabled: snapEnabled,
      translate: gridSize,
      rotateDeg: 15,
      scale: 0.25,
    });
    engineRef.current?.editor?.setGridSettings({
      tileSize: gridSize,
      tileSubdivisions: 4,
      cameraBounds2D: { width: 16, height: 9 },
      showGrid: gridVisible,
    });
  }, [snapEnabled, gridSize, gridVisible]);

  useEffect(() => {
    engineRef.current?.editor?.grid.setVisible(gridVisible);
  }, [gridVisible]);

  useEffect(() => {
    const handle = engineRef.current;
    if (!handle?.editor) return;
    const selectedActors = prefabSelectedActorIds(selectedId);
    handle.editor.setSelectedActors(selectedActors);
    const scene = previewSceneFor(components);
    handle.editor.syncSelectionDebug({
      sceneData: scene,
      selectedActorIds: selectedActors,
      selectedComponentIds:
        selectedId && selectedId !== PREFAB_ROOT_ID ? [selectedId] : undefined,
    });
  }, [components, selectedId]);

  useEffect(() => {
    if (!isTestModeEnabled()) return;
    const host = globalThis as {
      __babylonslatePrefabViewportTest?: {
        visuals: () => Array<{
          actorId: string;
          position: [number, number, number];
          materialName: string | null;
        }>;
      };
    };
    host.__babylonslatePrefabViewportTest = {
      visuals: () => {
        const sync = engineRef.current?.editor?.sync;
        if (!sync) return [];
        return previewSceneFor(componentsRef.current).actors.flatMap((actor) => {
          const visual = sync.visualMeshesForActor(actor.id)[0];
          if (!visual) return [];
          visual.computeWorldMatrix(true);
          const position = visual.getAbsolutePosition();
          return [{
            actorId: actor.id,
            position: [position.x, position.y, position.z],
            materialName: visual.material?.name ?? null,
          }];
        });
      },
    };
    return () => {
      delete host.__babylonslatePrefabViewportTest;
    };
  }, []);

  return (
    <div
      className="relative flex h-full min-h-0 min-w-0 w-full flex-col bg-background"
      data-testid="prefab-viewport-panel"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-2">
        <div className="pointer-events-auto rounded-md border border-border bg-card/90 p-1">
          <ViewportToolbar
            testIdPrefix="prefab-"
            showDragSelect={false}
            showViewportModeToggle={!overlayPrefab}
          />
        </div>
      </div>
      <canvas
        ref={canvasRef}
        className="h-full min-h-0 min-w-0 w-full flex-1 touch-none"
        data-testid="prefab-preview-canvas"
      />
      <canvas
        ref={previewCanvasRef}
        hidden
        data-testid="camera-preview"
        className="pointer-events-none absolute bottom-3 right-3 z-10 h-[180px] w-[320px] rounded-md border border-border bg-black"
      />
      {joystickEnabled ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-start p-4">
          <div className="pointer-events-auto">
            <ViewportJoystick
              speed={flySpeed}
              onFly={(forward, right) => {
                const camera = engineRef.current?.editor?.camera;
                if (camera) applyViewportJoystickSteer(camera, forward, right);
              }}
              onActiveChange={(active) => {
                const scheduler = engineRef.current?.scheduler;
                if (!scheduler) return;
                if (active) {
                  joystickLeaseRef.current ??=
                    scheduler.acquireContinuous("viewport-joystick");
                } else {
                  joystickLeaseRef.current?.();
                  joystickLeaseRef.current = null;
                }
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
