import { deformerBindings } from "@haptic/core";
import { SceneRenderCoordinator } from "./scene-render-coordinator";
import { SceneOutlineHost } from "./scene-outline-host";
import type { AbstractEngine, AbstractMesh } from "@babylonjs/core";
import {
  Mesh,
  Scene,
} from "@babylonjs/core";
import type {
  ViewportMode,
} from "@haptic/core";
import {
  createEditorCamera,
  type EditorCameraController,
} from "./editor-camera";
import {
  viewCenterWorldPosition,
  worldPositionFromCanvas,
} from "./editor-place";
import { createEditorGrid } from "./editor-grid";
import { EditorSceneSync } from "./editor-scene-sync";
import { allowSceneOcclusionCulling } from "./view-occlusion";
import { calculateEditorDropTransforms } from "./editor-drop";
import {
  calculateSurfaceRestTransforms,
  surfacePlacementAtViewCenter,
  surfacePlacementFromCanvas,
} from "./editor-surface-placement";
import {
  ViewportShadingOverlay,
  type ViewportShadingMode,
} from "./viewport-shading-mode";
import { isText2DOverlayMesh } from "./overlay-transform-box";
import { createGizmoHost, type GizmoHost } from "./gizmo-host";
import { createWaterHandles } from "./water-handles";
import { createSplineHandles } from "./spline-handles";
import { createDeformerHandles } from "./deformer-handles";
import { selectedShapeComponent } from "./shape-edit-target";
import type { ShapeHandlesHost } from "./shape-handles";
import {
  applyGizmoMultiSelectDrag,
  applyGizmoMultiSelectDragTo,
  axisScaledPivotWorld,
  beginGizmoMultiSelectDrag,
  pickGizmoAttachActorId,
  readMeshLocalTransform,
  selectionGizmoRoots,
  type GizmoMultiSelectDrag,
} from "./gizmo-multi-select";
import { linkedAxisScale, linkedScaleFromChange, type ScaleVector } from "./linked-axis-scale";
import { attachViewportGestures } from "./viewport-gestures";
import { attachViewportFlyKeys, DEFAULT_FLY_SPEED } from "./viewport-fly-keys";
import { createGameCameraPilot, type GameCameraPilotFraming } from "./game-camera-pilot";
import {
  editorComponentMeshName,
  unfreezeActorWorldMatrix,
  freezeStaticActorWorldMatrix,
} from "./scene-loader";
import { waterKindForClass, DEFORMER_COMPONENT_CLASS_ID, deformerTargetMesh, parseDeformerProperties } from "@haptic/core";
import {
  isEditorModelPlaceholder,
} from "./glb-anim";
import { actorFramingRadius, actorFramingTarget } from "./actor-framing";
import {
  isSkyboxMesh,
} from "./skybox";
import {
  syncAuthoredCamerasFromMeshes,
  syncAuthoredAreaLightsFromMeshes,
} from "./scene-illumination";
import { RenderScheduler } from "./render-scheduler";
import type { SnapshotSceneBinding } from "./snapshot-apply";
import { pickActorMeshName } from "./picking";
import { mapCanvasPointer } from "./pick-coords";
import { meshNamesInCanvasRect } from "./two-d";
import { EditorDebugOverlay } from "./editor-debug-overlay";

import type { CreateEngineOptions, EditorTools } from "./create-engine-types";

/** What the editor viewport tools read from the Engine handle being built. */
export interface EditorViewportToolsContext {
  canvas: HTMLCanvasElement;
  engine: AbstractEngine;
  scene: Scene;
  options: CreateEngineOptions;
  editorSync: EditorSceneSync;
  scheduler: RenderScheduler;
  outlineHost: SceneOutlineHost;
  worldRenderer: SceneRenderCoordinator;
  binding: SnapshotSceneBinding;
  viewportShading: ViewportShadingOverlay | null;
  /** The handle presents through a render target copied to the canvas. */
  presentRtt: boolean;
  pointerCanvas: () => { width: number; height: number };
  syncEditorOutlines: () => void;
  onRollback: (cleanup: () => void) => void;
}

/**
 * The editor viewport's camera, grid, gizmos, shape handles, Game Camera
 * pilot, gestures and debug overlay, and the `EditorTools` that drive them.
 * Every part it creates is disposed through `onRollback` if construction fails.
 */
export function createEditorViewportTools({
  canvas,
  engine,
  scene,
  options,
  editorSync,
  scheduler,
  outlineHost,
  worldRenderer,
  binding,
  viewportShading,
  presentRtt,
  pointerCanvas,
  syncEditorOutlines,
  onRollback,
}: EditorViewportToolsContext): {
  editor: EditorTools;
  debugOverlay: EditorDebugOverlay;
  /** Stops gestures, fly keys, the Game Camera pilot and pending tap picks. */
  disposeInput: () => void;
  /** The selected actors, kept so a scene reload or mesh rebuild reselects them. */
  selectedActorIds: () => string[];
} {
  let lastSelectedActorIds: string[] = [];
  let lastSelectedComponentIds: readonly string[] = [];
  const mode: ViewportMode = options.viewportMode ?? "3d";
  // The editor camera replaces the default viewport camera set up above.
  scene.activeCamera?.dispose();
  const cameraController = createEditorCamera(scene, { mode, scheduler });
  onRollback(() => cameraController.dispose());
  let previewGameCamera = false;
  const grid = createEditorGrid(scene, {
    mode,
    camera: cameraController.camera,
  });
  onRollback(() => grid.dispose());
  const selection = outlineHost.selection;
  onRollback(() => selection.dispose());
  let multiSelectDrag: GizmoMultiSelectDrag | null = null;
  let pointDrag: ShapeHandlesHost<never> | null = null;
  /** Actors whose Inspector Scale is linked; the gizmo links the group only when every selected root is. */
  let linkedScaleActorIds: ReadonlySet<string> = new Set();
  /**
   * A drag of a selection that is only partly linked, as the Inspector edits
   * one: the group follows the unlinked drag, then each linked root rescales
   * its other axes by its own factor on the dragged axis.
   */
  let mixedScale: {
    /** X, Y or Z scale handle; null for the 2D box. */
    axis: 0 | 1 | 2 | null;
    pivotStart: ReturnType<typeof readMeshLocalTransform>;
    linked: Array<{ mesh: AbstractMesh; start: ScaleVector }>;
  } | null = null;
  const parentIdOf = (id: string): string | null =>
    editorSync.lastSceneActor(id)?.parentId ?? null;
  const selectedActorTransforms = () => {
    const roots = selectionGizmoRoots(lastSelectedActorIds, parentIdOf);
    const live: Array<{
      actorId: string;
      position: [number, number, number];
      rotation: [number, number, number, number];
      scale: [number, number, number];
      text2dWrap?: { wrapWidth: number; wrapHeight: number };
    }> = [];
    for (const actorId of roots) {
      const mesh = editorSync.meshForActor(actorId);
      if (!mesh) continue;
      const liveTransform = readMeshLocalTransform(mesh);
      const meta = mesh.metadata as {
        text2dPendingWrap?: { wrapWidth: number; wrapHeight: number };
        text2dDragStartScale?: [number, number, number];
      } | null;
      live.push({
        actorId,
        ...liveTransform,
        ...(meta?.text2dDragStartScale
          ? { scale: meta.text2dDragStartScale }
          : {}),
        ...(meta?.text2dPendingWrap
          ? { text2dWrap: meta.text2dPendingWrap }
          : {}),
      });
    }
    return live;
  };
  const gizmosRef: { host: GizmoHost | null } = { host: null };
  const beginMixedScale = (attached: AbstractMesh | null, roots: readonly string[]): typeof mixedScale => {
    const host = gizmosRef.host;
    if (!attached || !host) return null;
    const linkedRoots = roots.filter((id) => linkedScaleActorIds.has(id));
    if (linkedRoots.length === 0 || linkedRoots.length === roots.length) return null;
    const axis = host.scaleDragAxis();
    // Translate, rotate and the uniform handle treat every actor alike.
    if (axis === null && !options.overlayTransformBox) return null;
    return {
      axis,
      pivotStart: readMeshLocalTransform(attached),
      // 2D Text resizes its text box, not its scale.
      linked: linkedRoots.flatMap((id) => {
        const mesh = editorSync.meshForActor(id);
        return mesh && !isText2DOverlayMesh(mesh)
          ? [{ mesh, start: [mesh.scaling.x, mesh.scaling.y, mesh.scaling.z] as ScaleVector }]
          : [];
      }),
    };
  };
  const followSelection = (attached: AbstractMesh | null) => {
    if (!multiSelectDrag || !attached) return;
    const axis = mixedScale?.axis ?? null;
    if (!mixedScale || axis === null) {
      applyGizmoMultiSelectDrag(multiSelectDrag, attached);
      return;
    }
    // The pivot as Babylon scales it, without its relinked axes.
    const value = axis === 0 ? attached.scaling.x : axis === 1 ? attached.scaling.y : attached.scaling.z;
    applyGizmoMultiSelectDragTo(multiSelectDrag, axisScaledPivotWorld(attached, mixedScale.pivotStart, axis, value));
  };
  const relinkMixedScale = (attached: AbstractMesh | null) => {
    if (!mixedScale) return;
    const mode = gizmosRef.host?.mode ?? "3d";
    const { axis } = mixedScale;
    for (const { mesh, start } of mixedScale.linked) {
      const current: ScaleVector = [mesh.scaling.x, mesh.scaling.y, mesh.scaling.z];
      // Babylon keeps compounding the attached mesh's dragged axis, so that axis
      // is its factor; a follower's scale is rebuilt from its start every step.
      const next = mesh === attached && axis !== null
        ? linkedAxisScale(start, axis, current[axis], mode)
        : linkedScaleFromChange(start, current, mode);
      mesh.scaling.set(next[0], next[1], next[2]);
      mesh.computeWorldMatrix(true);
    }
  };
  const syncLinkedScale = () => {
    const roots = selectionGizmoRoots(lastSelectedActorIds, parentIdOf);
    gizmosRef.host?.setLinkedScale(roots.length > 0 && roots.every((id) => linkedScaleActorIds.has(id)));
  };
  const debugOverlayInstance = new EditorDebugOverlay(scene, {
    renderTargets: () => binding.renderTargets,
    previewFrameRate: options.cameraPreviewFrameRate,
    isShown: () => scheduler.isShown(),
  });
  onRollback(() => debugOverlayInstance.dispose());
  const gizmos = createGizmoHost(scene, {
    mode,
    registerOverlay: (draw) => worldRenderer.attachEditorOverlay(draw),
    scheduler,
    manipulator: options.overlayTransformBox ? "overlay-box" : "trs",
    canvasCssHeight: () => pointerCanvas().height,
    onDragStart: () => {
      mixedScale = null;
      const attached = gizmosRef.host?.attachedMesh() ?? null;
      pointDrag = (attached && pointHandles().find((handles) => attached === handles.selectedNode() && handles.beginSelectionDrag())) || null;
      if (pointDrag) return;
      const roots = selectionGizmoRoots(lastSelectedActorIds, parentIdOf);
      const followers = roots
        .map((id) => editorSync.meshForActor(id))
        .filter(
          (mesh): mesh is NonNullable<typeof mesh> =>
            mesh !== null && mesh !== attached,
        );
      for (const root of roots) {
        const mesh = editorSync.meshForActor(root);
        if (mesh) unfreezeActorWorldMatrix(mesh);
      }
      if (attached instanceof Mesh) unfreezeActorWorldMatrix(attached);
      multiSelectDrag = beginGizmoMultiSelectDrag(attached, followers);
      mixedScale = beginMixedScale(attached, roots);
      options.onGizmoDragStart?.();
    },
    onDrag: () => {
      if (pointDrag) { pointDrag.dragSelection(); return; }
      const attached = gizmosRef.host?.attachedMesh() ?? null;
      followSelection(attached);
      relinkMixedScale(attached);
      const sceneData = editorSync.serializedScene();
      syncAuthoredAreaLightsFromMeshes(scene, (id) => editorSync.meshForActor(id));
      if (sceneData) {
        syncAuthoredCamerasFromMeshes(scene, sceneData, (id) =>
          editorSync.meshForActor(id),
        );
      }
      debugOverlayInstance.followLivePose();
    },
    onDragEnd: () => {
      if (pointDrag) { pointDrag.endSelectionDrag(); pointDrag = null; return; }
      const attached = gizmosRef.host?.attachedMesh() ?? null;
      // A mixed drag's last step already placed and relinked the group; the
      // attached mesh may carry its relinked axes now.
      if (multiSelectDrag && attached && !mixedScale) {
        applyGizmoMultiSelectDrag(multiSelectDrag, attached);
      }
      multiSelectDrag = null;
      mixedScale = null;
      const roots = selectionGizmoRoots(lastSelectedActorIds, parentIdOf);
      for (const root of roots) {
        const mesh = editorSync.meshForActor(root);
        if (mesh) freezeStaticActorWorldMatrix(mesh);
      }
      if (attached instanceof Mesh) freezeStaticActorWorldMatrix(attached);
      options.onGizmoDragEnd?.();
    },
  });
  gizmosRef.host = gizmos;
  onRollback(() => gizmos.dispose());
  const waterHandles = createWaterHandles(gizmos.layer, scene, {
    scheduler,
    onCommit: (edit) => options.onComponentShapeEdit?.(edit),
  });
  onRollback(() => waterHandles.dispose());
  const splineHandles = createSplineHandles(gizmos.layer, scene, {
    scheduler,
    onCommit: (edit) => options.onComponentShapeEdit?.(edit),
    onSelectionChange: () => attachSelectionGizmo(),
  });
  const deformerHandles = createDeformerHandles(gizmos.layer, scene, {
    scheduler,
    onCommit: (edit) => options.onComponentShapeEdit?.(edit),
    onSelectionChange: () => attachSelectionGizmo(),
  });
  onRollback(() => deformerHandles.dispose());
  const pointHandles = (): ShapeHandlesHost<never>[] => [splineHandles, deformerHandles];
  // A selected spline or deformer point takes the translate gizmo until a viewport
  // tap outside the handles or a new selection returns it to the actor.
  // The 2D transform box frames every selected root, not just the one it
  // attaches to: the others follow its drags through the multi-select delta.
  const selectionBoxVisuals = (attachId: string) => {
    if (!options.overlayTransformBox) return editorSync.visualMeshesForActor(attachId);
    const roots = selectionGizmoRoots(lastSelectedActorIds, parentIdOf);
    if (roots.length < 2) return editorSync.visualMeshesForActor(attachId);
    return roots.flatMap((id) => {
      const mesh = editorSync.meshForActor(id);
      if (!mesh) return [];
      return isText2DOverlayMesh(mesh) && id !== attachId ? [mesh] : editorSync.visualMeshesForActor(id);
    });
  };
  // Locked actors are not pickable; keep the gizmo off them so lock is
  // more than a pick filter. Attach to the first pickable selection root
  // so a selected child is not the group handle when its parent is too.
  const selectionAttachId = () => pickGizmoAttachActorId(lastSelectedActorIds, parentIdOf, (id) => {
    const mesh = editorSync.meshForActor(id);
    if (!mesh) return false;
    const locked = editorSync.lastSceneActor(id)?.locked;
    if (locked) return false;
    return mesh.isPickable || isEditorModelPlaceholder(mesh);
  });
  /** The visuals the gizmo was last attached with; the 2D box reads their bounds every frame. */
  let attachedVisuals: readonly AbstractMesh[] = [];
  const attachSelectionGizmo = () => {
    const point = splineHandles.selectedNode() ?? deformerHandles.selectedNode();
    if (point) {
      attachedVisuals = [];
      gizmos.attachTo(point, [], { tool: "translate" });
      return;
    }
    const attachId = selectionAttachId();
    attachedVisuals = attachId ? selectionBoxVisuals(attachId) : [];
    gizmos.attachTo(attachId ? editorSync.meshForActor(attachId) : null, [...attachedVisuals]);
  };
  // An async visual (a texture, a model) replaces an actor's root mesh after the
  // scene applied: reattach so the gizmo moves and frames the live mesh, not the
  // disposed one. Mid-drag or on a selected point, the attachment stays.
  const refreshSelectionGizmo = () => {
    if (lastSelectedActorIds.length === 0 || gizmos.isDragging()) return;
    if (splineHandles.selectedNode() ?? deformerHandles.selectedNode()) return;
    const attachId = selectionAttachId();
    const mesh = attachId ? editorSync.meshForActor(attachId) : null;
    const visuals = attachId ? selectionBoxVisuals(attachId) : [];
    const same = mesh === gizmos.attachedMesh() && visuals.length === attachedVisuals.length &&
      visuals.every((visual, index) => visual === attachedVisuals[index]);
    if (!same) attachSelectionGizmo();
  };
  onRollback(() => splineHandles.dispose());
  const syncShapeHandles = (actorIds: readonly string[]) => {
    const selected = selectedShapeComponent(editorSync.serializedScene(), actorIds, lastSelectedComponentIds);
    const { actor, component } = selected ?? {};
    const kind = component ? waterKindForClass(component.classId) : null;
    waterHandles.attach(actor && component && kind ? {
      actorId: actor.id, componentId: component.id, kind,
      meshName: editorComponentMeshName(actor.id, component.id),
      properties: component.properties,
    } : null);
    splineHandles.attach(actor && component?.classId === "SplineComponent" ? {
      actorId: actor.id, componentId: component.id,
      meshName: editorComponentMeshName(actor.id, component.id), properties: component.properties,
    } : null);
    const deformerTarget = actor && component?.classId === DEFORMER_COMPONENT_CLASS_ID
      ? deformerTargetMesh(actor.components, parseDeformerProperties(component.properties).targetMeshComponentId) : undefined;
    deformerHandles.attach(actor && component && deformerTarget ? {
      actorId: actor.id, componentId: component.id,
      meshName: editorComponentMeshName(actor.id, deformerTarget.id), properties: component.properties,
      resolveMesh: () => editorSync.meshForComponent(actor.id, deformerTarget.id),
      preview: deformerBindings(actor.id, actor.components).some((binding) => binding.id === component.id),
    } : null);
  };

  // Game Camera turns look, fly, pan and zoom onto the Default Camera actor.
  const pilot = createGameCameraPilot({
    mode: () => cameraController.mode,
    target: () => {
      if (!previewGameCamera || options.editorFlyEnabled?.() === false) return null;
      const sceneData = editorSync.serializedScene();
      const actorId = sceneData?.settings.mainCameraActorId;
      const componentId = sceneData?.settings.mainCameraComponentId;
      const actor = actorId ? sceneData?.actors.find((entry) => entry.id === actorId) : undefined;
      if (!actor || actor.locked || !actor.components.some(
        (component) => component.id === componentId && component.classId === "CameraComponent",
      )) return null;
      const mesh = editorSync.meshForActor(actor.id);
      const camera = scene.activeCamera;
      if (!mesh || !camera || camera === cameraController.camera) return null;
      return { actorId: actor.id, mesh, camera };
    },
    onBegin: ({ mesh }) => unfreezeActorWorldMatrix(mesh as Mesh),
    onMove: () => {
      const sceneData = editorSync.serializedScene();
      if (sceneData) syncAuthoredCamerasFromMeshes(scene, sceneData, (id) => editorSync.meshForActor(id));
      scheduler.invalidate("camera");
    },
    onCommit: ({ actorId, mesh }) => {
      freezeStaticActorWorldMatrix(mesh as Mesh);
      options.onPilotedActorMoveEnd?.({ actorId, ...readMeshLocalTransform(mesh) });
    },
  });
  onRollback(() => pilot.dispose());
  type NavigationFraming = ReturnType<EditorCameraController["captureFraming"]> & {
    pilot?: GameCameraPilotFraming | null;
  };
  const navigation: EditorCameraController = Object.assign(
    Object.create(cameraController) as EditorCameraController,
    {
      look: (deltaYaw: number, deltaPitch: number) =>
        pilot.active() ? pilot.look(deltaYaw, deltaPitch) : cameraController.look(deltaYaw, deltaPitch),
      orbit: (deltaYaw: number, deltaPitch: number) =>
        pilot.active() ? pilot.look(deltaYaw, deltaPitch) : cameraController.orbit(deltaYaw, deltaPitch),
      fly: (forward: number, right: number) =>
        pilot.active() ? pilot.fly(forward, right) : cameraController.fly(forward, right),
      pan: (deltaX: number, deltaY: number) =>
        pilot.active() ? pilot.pan(deltaX, deltaY) : cameraController.pan(deltaX, deltaY),
      zoom: (factor: number, pivot?: Parameters<EditorCameraController["zoom"]>[1]) =>
        pilot.active() ? pilot.zoom(factor) : cameraController.zoom(factor, pivot),
      captureFraming: (): NavigationFraming => ({
        ...cameraController.captureFraming(),
        pilot: pilot.captureFraming(),
      }),
      restoreFraming: (framing: NavigationFraming) => {
        if (framing.pilot) pilot.restoreFraming(framing.pilot);
        else cameraController.restoreFraming(framing);
      },
    },
  );
  // The joystick orbits with Pivot Around Center; a piloted camera flies.
  Object.defineProperty(navigation, "pivotAroundCenter", {
    get: () => !pilot.active() && cameraController.pivotAroundCenter,
  });
  const navigationActive = () => !previewGameCamera || pilot.active();

  let tapPickSequence = 0;
  const gestures = attachViewportGestures(canvas, navigation, {
    scheduler,
    editorCameraActive: navigationActive,
    blockLook: (x, y) =>
      gizmos.isDragging() || waterHandles.isDragging() || splineHandles.isDragging() || deformerHandles.isDragging() || gizmos.hitTest(x, y, pointerCanvas()),
    dragSelectActive: () => options.dragSelectActive?.() === true,
    onPointer:
      options.sharedEngine || presentRtt
        ? (type, x, y, pointerId) => {
            gizmos.forwardPointer(type, x, y, {
              ...pointerCanvas(),
              pointerId,
            });
          }
        : undefined,
    onTap: (x, y, tap) => {
      splineHandles.clearSelection();
      deformerHandles.clearSelection();
      const mapped = mapCanvasPointer(scene, x, y, pointerCanvas());
      const sequence = ++tapPickSequence;
      void pickActorMeshName(scene, mapped.x, mapped.y).then((meshName) => {
        // A later tap or scene disposal supersedes this asynchronous read-back.
        if (sequence !== tapPickSequence || scene.isDisposed) return;
        const actorId = meshName ? editorSync.actorForMesh(meshName) : null;
        options.onPickActor?.(actorId, { additive: tap?.additive === true });
      });
    },
    onMarqueeMove: options.onMarqueeMove,
    onDragSelectEnd: options.onDragSelectEnd,
    onMarquee: (rect) => {
      if (!options.onMarqueeSelect) return;
      const css = canvas.getBoundingClientRect();
      const names = meshNamesInCanvasRect(scene, rect, css.width, css.height);
      const actorIds = [
        ...new Set(
          names
            .map((name) => editorSync.actorForMesh(name))
            .filter((id): id is string => id !== null),
        ),
      ];
      options.onMarqueeSelect(actorIds);
    },
  });
  onRollback(() => gestures.dispose());
  const flyKeys =
    typeof window === "undefined"
      ? null
      : attachViewportFlyKeys(window, navigation, canvas, {
          scheduler,
          speed: () => options.editorFlySpeed?.() ?? DEFAULT_FLY_SPEED,
          isEnabled: () =>
            navigationActive() && options.editorFlyEnabled?.() !== false,
        });
  onRollback(() => flyKeys?.dispose());
  // A handle being disposed takes no more input: a piloted move still waiting
  // for its commit lands now, and a tap pick still reading back is dropped.
  const disposeInput = () => {
    gestures.dispose();
    flyKeys?.dispose();
    pilot.flush();
    pilot.dispose();
    tapPickSequence += 1;
  };

  const editor: EditorTools = {
    camera: cameraController,
    navigation,
    gizmos,
    grid,
    selection,
    sync: editorSync,
    setViewportMode: (next: ViewportMode) => {
      cameraController.setMode(next);
      gizmos.setMode(next);
      grid.setMode(next);
      scheduler.invalidate("camera");
    },
    setViewportShadingMode: (next: ViewportShadingMode) => {
      viewportShading?.setMode(next);
      syncEditorOutlines();
      scheduler.invalidate("asset");
    },
    setDrawMeshCollision: (enabled: boolean) => {
      editorSync.setDrawMeshCollision(enabled);
      scheduler.invalidate("asset");
    },
    setOcclusionCulling: (enabled: boolean) => {
      allowSceneOcclusionCulling(scene, enabled ? "always" : "never");
      scheduler.invalidate("asset");
    },
    setPixelPerfect: (settings) => {
      cameraController.setCanvasHeight(engine.getRenderHeight());
      cameraController.setPixelPerfect(settings);
    },
    setSortingLayers: (layers) => {
      editorSync.setSortingLayers(layers);
      scheduler.invalidate("asset");
    },
    setGridSettings: (settings) => {
      grid.setSpacing(settings.tileSize);
      grid.setSubdivisions(settings.tileSubdivisions);
      grid.setCameraBounds(settings.cameraBounds2D);
      if (typeof settings.showGrid === "boolean") {
        grid.setVisible(settings.showGrid);
      }
      scheduler.invalidate("asset");
    },
    refreshSelectionGizmo,
    setLinkedScaleActors: (actorIds) => {
      linkedScaleActorIds = new Set(actorIds);
      syncLinkedScale();
    },
    setSelectedActors: (actorIds: string[]) => {
      if (actorIds.length !== lastSelectedActorIds.length || actorIds.some((id, index) => id !== lastSelectedActorIds[index])) lastSelectedComponentIds = [];
      lastSelectedActorIds = [...actorIds];
      outlineHost.setSelection(actorIds);
      syncShapeHandles(actorIds);
      syncLinkedScale();
      attachSelectionGizmo();
      scheduler.invalidate("selection");
    },
    syncSelectionDebug: (options) => {
      debugOverlayInstance.sync(options);
      editorSync.setCollisionSelection(options);
      lastSelectedComponentIds = options.selectedComponentIds ?? [];
      syncShapeHandles(lastSelectedActorIds);
      scheduler.invalidate("selection");
    },
    setPreviewCanvas: (canvas) => {
      debugOverlayInstance.setPreviewCanvas(canvas);
    },
    frameActor: (actorId: string) => {
      const mesh = editorSync.meshForActor(actorId);
      if (!mesh || isSkyboxMesh(mesh)) return;
      const center = actorFramingTarget(mesh);
      if (cameraController.mode === "3d") {
        cameraController.frame(
          center,
          actorFramingRadius(mesh, { minZ: cameraController.camera.minZ }),
        );
      } else {
        cameraController.frame(center);
      }
    },
    visualBounds2D: (actorIds) => {
      let bounds: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
      for (const actorId of actorIds) {
        for (const mesh of editorSync.visualMeshesForActor(actorId)) {
          if (!mesh.isEnabled() || mesh.getTotalVertices() === 0) continue;
          mesh.computeWorldMatrix(true);
          const { minimumWorld: min, maximumWorld: max } = mesh.getBoundingInfo().boundingBox;
          bounds = bounds
            ? {
                minX: Math.min(bounds.minX, min.x),
                minY: Math.min(bounds.minY, min.y),
                maxX: Math.max(bounds.maxX, max.x),
                maxY: Math.max(bounds.maxY, max.y),
              }
            : { minX: min.x, minY: min.y, maxX: max.x, maxY: max.y };
        }
      }
      return bounds;
    },
    selectedActorTransforms,
    dropSelectedActors: (selectedActorIds, maxDistance) => {
      const sceneData = editorSync.serializedScene();
      return sceneData ? calculateEditorDropTransforms({
        sceneData, selectedActorIds, maxDistance, meshForActor: (id) => editorSync.meshForActor(id),
        assets: { modelBytes: binding.modelBytes, modelSources: binding.modelSources, modelPayloads: binding.modelPayloads,
          spritePayloads: binding.spritePayloads, tilemaps: binding.tilemaps, tilesets: binding.tilesets,
          pixelsPerUnit: binding.pixelsPerUnit },
      }) : [];
    },
    attachedActorTransform: () => {
      const mesh = gizmos.attachedMesh();
      if (!mesh) return selectedActorTransforms()[0] ?? null;
      const actorId = editorSync.actorForMesh(mesh.name);
      if (!actorId) return null;
      return (
        selectedActorTransforms().find(
          (entry) => entry.actorId === actorId,
        ) ?? {
          actorId,
          ...readMeshLocalTransform(mesh),
        }
      );
    },
    setPreviewGameCamera: (enabled: boolean) => {
      if (!enabled) pilot.flush();
      previewGameCamera = enabled;
      editorSync.setGameCameraPreview(enabled, cameraController.camera);
      scheduler.invalidate("camera");
    },
    worldPositionAtClient: (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return worldPositionFromCanvas(
        cameraController.camera,
        clientX - rect.left,
        clientY - rect.top,
        { width: rect.width, height: rect.height },
        cameraController.mode,
      );
    },
    worldPositionAtViewCenter: () =>
      viewCenterWorldPosition(cameraController.camera, cameraController.mode),
    surfacePlacementAtClient: (clientX, clientY, maxDistance) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return surfacePlacementFromCanvas(
        scene,
        cameraController.camera,
        clientX - rect.left,
        clientY - rect.top,
        { width: rect.width, height: rect.height },
        cameraController.mode,
        maxDistance,
      );
    },
    surfacePlacementAtViewCenter: (maxDistance) =>
      surfacePlacementAtViewCenter(scene, cameraController.camera, cameraController.mode, maxDistance),
    restActorsOnSurface: (rests) => {
      const sceneData = editorSync.serializedScene();
      return sceneData
        ? calculateSurfaceRestTransforms({ sceneData, rests, meshForActor: (id) => editorSync.meshForActor(id) })
        : [];
    },
  };
  return {
    editor,
    debugOverlay: debugOverlayInstance,
    disposeInput,
    selectedActorIds: () => lastSelectedActorIds,
  };
}
