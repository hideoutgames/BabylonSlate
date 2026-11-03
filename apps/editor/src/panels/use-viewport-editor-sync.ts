import { useEffect, type RefObject } from "react";
import { isSceneLayerAnchorActor, type SerializedScene } from "@haptic/core";
import type { EngineHandle } from "@haptic/render";
import { useAppSettings } from "../context/app-settings-context";
import { useProjectState, useRegistryState } from "../context/document-context";
import { useSceneEditing } from "../context/scene-editing-context";
import { scaleLinkKey, useLinkedScale } from "../lib/linked-scale";
import type { PlayAudioLibrary } from "../lib/play-audio";
import {
  MATERIAL_DOCUMENT_KINDS,
  useOpenDocumentsOfKinds,
} from "../lib/use-open-documents-of-kinds";
import type { SceneMode } from "../shell/scene-document-layout";

export interface ViewportEditorSyncDeps {
  engineRef: RefObject<EngineHandle | null>;
  engineEpoch: number;
  scene: SerializedScene | null;
  sceneMode: SceneMode;
  /** From the panel's `useEditorAudioDebug`, whose effect stays in the panel. */
  audioLibrary: PlayAudioLibrary | undefined;
}

/**
 * Pushes editor state into the viewport Engine: open Material tabs, selection
 * and shape-edit debug, viewport and shading modes, collision and Game Camera
 * previews, pivot, occlusion culling, gizmo tool, space and snap, grid, sorting layers and
 * pixel-perfect. Every effect re-runs on `engineEpoch`, so a new Engine gets
 * the current state. React runs its effects in call order, so the panel calls
 * it where these effects have always run.
 */
export function useViewportEditorSync({
  engineRef,
  engineEpoch,
  scene,
  sceneMode,
  audioLibrary,
}: ViewportEditorSyncDeps): void {
  const { projectDocument } = useProjectState();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const materialDocuments = useOpenDocumentsOfKinds(MATERIAL_DOCUMENT_KINDS);
  const {
    selectedActorIds,
    shapeEditTarget,
    gizmoTool,
    gizmoSpace,
    snapEnabled,
    viewportMode,
    gridVisible,
    previewGameCamera,
    pivotAroundCenter,
    viewportShadingMode,
    collisionsVisible,
  } = useSceneEditing();
  // Editor Settings > Viewport > Occlusion Culling; the project's setting governs Play and exports.
  const occlusionCulling = useAppSettings().settings.viewportOcclusionCulling;
  const linkedScale = useLinkedScale();
  // The gizmo keeps each linked actor's proportions, and the whole selection's
  // when every actor is linked. Scene Layer anchors take no Scale row, so they
  // count as linked only then and never unlink the group.
  const selected = new Set(selectedActorIds);
  const selectedActors = (scene?.actors ?? []).filter((actor) => selected.has(actor.id));
  const spatial = selectedActors.filter((actor) => !isSceneLayerAnchorActor(actor));
  const linkedIds = spatial
    .filter((actor) => linkedScale.isLinked(scaleLinkKey.actor(actor.id)))
    .map((actor) => actor.id);
  const scaleLinkedKey = (spatial.length > 0 && linkedIds.length === spatial.length
    ? selectedActors.map((actor) => actor.id)
    : linkedIds
  ).join("\n");

  useEffect(() => {
    const handle = engineRef.current;
    if (!handle) return;
    void registryEpoch; // Registry headers mutate without replacing the registry.
    const byPath = new Map(
      (assetRegistry?.list() ?? []).filter((asset) => asset.header.type === "Material" || asset.header.type === "MaterialInstance").map((asset) => [
        asset.path,
        asset.header.guid,
      ]),
    );
    const guids = new Set<string>();
    for (const doc of materialDocuments) {
      const guid = byPath.get(doc.ref.path);
      if (guid) guids.add(guid);
    }
    handle.setEditingMaterialGuids(guids);
  }, [materialDocuments, assetRegistry, registryEpoch, engineEpoch, engineRef]);

  useEffect(() => {
    engineRef.current?.editor?.setSelectedActors(sceneMode === "design" ? selectedActorIds : []);
    const targetActor = shapeEditTarget && selectedActorIds.length === 1 && shapeEditTarget.actorId === selectedActorIds[0]
      ? scene?.actors.find((actor) => actor.id === shapeEditTarget.actorId)
      : undefined;
    const selectedComponentIds = shapeEditTarget && targetActor?.components.some((component) => component.id === shapeEditTarget.componentId)
      ? [shapeEditTarget.componentId]
      : undefined;
    engineRef.current?.editor?.syncSelectionDebug({
      sceneData: scene,
      selectedActorIds,
      selectedComponentIds,
      audioLibrary,
    });
  }, [scene, selectedActorIds, shapeEditTarget, engineEpoch, audioLibrary, sceneMode, engineRef]);

  useEffect(() => {
    engineRef.current?.editor?.setViewportMode(sceneMode === "design" ? viewportMode : "3d");
  }, [viewportMode, engineEpoch, sceneMode, engineRef]);

  useEffect(() => {
    engineRef.current?.editor?.setViewportShadingMode(viewportShadingMode);
  }, [viewportShadingMode, engineEpoch, engineRef]);

  useEffect(() => {
    engineRef.current?.editor?.setDrawMeshCollision(collisionsVisible);
  }, [collisionsVisible, engineEpoch, engineRef]);

  useEffect(() => {
    engineRef.current?.editor?.setOcclusionCulling(occlusionCulling);
  }, [occlusionCulling, engineEpoch, engineRef]);

  useEffect(() => {
    engineRef.current?.editor?.setPreviewGameCamera(previewGameCamera);
  }, [previewGameCamera, engineEpoch, engineRef]);

  useEffect(() => {
    engineRef.current?.editor?.camera.setPivotAroundCenter(pivotAroundCenter);
  }, [pivotAroundCenter, engineEpoch, engineRef]);

  useEffect(() => {
    engineRef.current?.editor?.gizmos.setTool(gizmoTool);
  }, [gizmoTool, engineEpoch, engineRef]);

  useEffect(() => {
    engineRef.current?.editor?.gizmos.setSpace(gizmoSpace);
  }, [gizmoSpace, engineEpoch, engineRef]);

  useEffect(() => {
    engineRef.current?.editor?.setLinkedScaleActors(scaleLinkedKey ? scaleLinkedKey.split("\n") : []);
  }, [scaleLinkedKey, engineEpoch, engineRef]);

  useEffect(() => {
    const grid = scene?.settings.grid;
    engineRef.current?.editor?.gizmos.setSnap({
      enabled: snapEnabled,
      translate: grid?.snapTranslate ?? 1,
      rotateDeg: grid?.snapRotateDeg ?? 15,
      scale: grid?.snapScale ?? 0.25,
    });
  }, [scene?.settings.grid, snapEnabled, engineEpoch, engineRef]);

  useEffect(() => {
    const settings = scene?.settings;
    if (!settings) return;
    engineRef.current?.editor?.setGridSettings({
      tileSize: settings.grid.tileSize,
      tileSubdivisions: settings.grid.tileSubdivisions,
      cameraBounds2D: settings.cameraBounds2D,
      showGrid: gridVisible,
    });
    // engineEpoch: the first scene payload often exists before createEngine.
    // Without it, this effect runs once with a null engineRef and never
    // reapplies cameraBounds2D (orange frame missing until Show Grid).
  }, [scene?.settings, viewportMode, gridVisible, engineEpoch, engineRef]);

  useEffect(() => {
    engineRef.current?.editor?.grid.setVisible(gridVisible);
  }, [gridVisible, engineEpoch, engineRef]);

  useEffect(() => {
    const twoD = projectDocument?.settings.twoD;
    const editor = engineRef.current?.editor;
    if (!editor || !twoD) return;
    editor.setSortingLayers(twoD.sortingLayers);
    editor.setPixelPerfect(
      viewportMode === "2d" && twoD.pixelPerfect
        ? {
            pixelsPerUnit: twoD.pixelsPerUnit,
          }
        : null,
    );
  }, [projectDocument?.settings.twoD, viewportMode, engineEpoch, engineRef]);
}
