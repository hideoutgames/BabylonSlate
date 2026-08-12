import {
  Color3,
  PositionGizmo,
  RotationGizmo,
  ScaleGizmo,
  UtilityLayerRenderer,
  type AbstractMesh,
  type Scene,
} from "@babylonjs/core";
import type { ViewportMode } from "@babylonslate/core";
import type { RenderScheduler } from "./render-scheduler";

export type GizmoTool = "none" | "translate" | "rotate" | "scale";

export interface GizmoSnapSettings {
  enabled: boolean;
  translate: number;
  rotateDeg: number;
  scale: number;
}

export interface GizmoHostOptions {
  mode?: ViewportMode;
  tool?: GizmoTool;
  scheduler?: Pick<RenderScheduler, "invalidate" | "acquireContinuous">;
  onDragStart?: () => void;
  onDrag?: () => void;
  onDragEnd?: () => void;
  /** Screen-space handle scale; touch needs larger handles than a mouse. */
  handleScale?: number;
}

export interface GizmoHost {
  readonly tool: GizmoTool;
  readonly mode: ViewportMode;
  setTool: (tool: GizmoTool) => void;
  setMode: (mode: ViewportMode) => void;
  setSnap: (snap: GizmoSnapSettings) => void;
  attachTo: (mesh: AbstractMesh | null) => void;
  attachedMesh: () => AbstractMesh | null;
  dispose: () => void;
}

/** Touch handles need to be well past the 44px floor at typical zoom. */
export const DEFAULT_GIZMO_HANDLE_SCALE = 2.4;

export interface GizmoAxisEnabledFlags {
  position: { x: boolean; y: boolean; z: boolean };
  rotation: { x: boolean; y: boolean; z: boolean };
  scale: { x: boolean; y: boolean; z: boolean; uniform: boolean };
}

/** Pure axis visibility for 2D/3D + tool — unit-tested without Babylon gizmos. */
export function gizmoAxisEnabledFlags(
  mode: ViewportMode,
  tool: GizmoTool,
): GizmoAxisEnabledFlags {
  const twoD = mode === "2d";
  return {
    position: {
      x: tool === "translate",
      y: tool === "translate",
      z: tool === "translate" && !twoD,
    },
    rotation: {
      x: tool === "rotate" && !twoD,
      y: tool === "rotate" && !twoD,
      z: tool === "rotate",
    },
    scale: {
      x: tool === "scale",
      y: tool === "scale",
      z: tool === "scale" && !twoD,
      uniform: tool === "scale",
    },
  };
}

/**
 * Translate / rotate / scale gizmos on a utility layer, with the axis set
 * filtered by viewport mode: 2D exposes XY translate, Z rotate and XY scale and
 * hides the unused axes rather than merely ignoring them (engineplan §13.1).
 */
export function createGizmoHost(
  scene: Scene,
  options: GizmoHostOptions = {},
): GizmoHost {
  const layer = new UtilityLayerRenderer(scene);
  const handleScale = options.handleScale ?? DEFAULT_GIZMO_HANDLE_SCALE;

  const position = new PositionGizmo(layer);
  const rotation = new RotationGizmo(layer);
  const scale = new ScaleGizmo(layer);
  const gizmos = [position, rotation, scale];

  for (const gizmo of gizmos) {
    gizmo.scaleRatio = handleScale;
    gizmo.updateGizmoRotationToMatchAttachedMesh = false;
  }
  position.planarGizmoEnabled = true;

  let tool: GizmoTool = options.tool ?? "translate";
  let mode: ViewportMode = options.mode ?? "3d";
  let attached: AbstractMesh | null = null;
  let releaseLease: (() => void) | null = null;

  const startDrag = () => {
    releaseLease ??= options.scheduler?.acquireContinuous("gizmo") ?? null;
    options.onDragStart?.();
  };

  const endDrag = () => {
    releaseLease?.();
    releaseLease = null;
    options.scheduler?.invalidate("gizmo");
    options.onDragEnd?.();
  };

  const drag = () => {
    options.scheduler?.invalidate("gizmo");
    options.onDrag?.();
  };

  for (const axis of [
    position.xGizmo,
    position.yGizmo,
    position.zGizmo,
    rotation.xGizmo,
    rotation.yGizmo,
    rotation.zGizmo,
    scale.xGizmo,
    scale.yGizmo,
    scale.zGizmo,
  ]) {
    axis.dragBehavior.onDragStartObservable.add(startDrag);
    axis.dragBehavior.onDragObservable.add(drag);
    axis.dragBehavior.onDragEndObservable.add(endDrag);
  }

  const applyAxisVisibility = () => {
    const flags = gizmoAxisEnabledFlags(mode, tool);
    position.xGizmo.isEnabled = flags.position.x;
    position.yGizmo.isEnabled = flags.position.y;
    position.zGizmo.isEnabled = flags.position.z;
    rotation.xGizmo.isEnabled = flags.rotation.x;
    rotation.yGizmo.isEnabled = flags.rotation.y;
    rotation.zGizmo.isEnabled = flags.rotation.z;
    scale.xGizmo.isEnabled = flags.scale.x;
    scale.yGizmo.isEnabled = flags.scale.y;
    scale.zGizmo.isEnabled = flags.scale.z;
    scale.uniformScaleGizmo.isEnabled = flags.scale.uniform;
  };

  const applyAttachment = () => {
    position.attachedMesh = tool === "translate" ? attached : null;
    rotation.attachedMesh = tool === "rotate" ? attached : null;
    scale.attachedMesh = tool === "scale" ? attached : null;
    applyAxisVisibility();
    options.scheduler?.invalidate("gizmo");
  };

  applyAttachment();

  return {
    get tool() {
      return tool;
    },
    get mode() {
      return mode;
    },
    setTool: (next: GizmoTool) => {
      if (next === tool) return;
      tool = next;
      applyAttachment();
    },
    setMode: (next: ViewportMode) => {
      if (next === mode) return;
      mode = next;
      applyAttachment();
    },
    setSnap: (snap: GizmoSnapSettings) => {
      position.snapDistance = snap.enabled ? snap.translate : 0;
      rotation.snapDistance = snap.enabled
        ? (snap.rotateDeg * Math.PI) / 180
        : 0;
      scale.snapDistance = snap.enabled ? snap.scale : 0;
    },
    attachTo: (mesh: AbstractMesh | null) => {
      attached = mesh;
      applyAttachment();
    },
    attachedMesh: () => attached,
    dispose: () => {
      releaseLease?.();
      releaseLease = null;
      for (const gizmo of gizmos) {
        gizmo.dispose();
      }
      layer.dispose();
    },
  };
}

/** Selection outline colour, shared by the outline pass and the 2D bounds. */
export const SELECTION_COLOR = new Color3(0.35, 0.7, 1);
