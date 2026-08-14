import {
  Color3,
  PositionGizmo,
  RotationGizmo,
  ScaleGizmo,
  UtilityLayerRenderer,
  type AbstractMesh,
  type Scene,
  type StandardMaterial,
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
  readonly positionGizmo: PositionGizmo;
  readonly rotationGizmo: RotationGizmo;
  readonly scaleGizmo: ScaleGizmo;
  setTool: (tool: GizmoTool) => void;
  setMode: (mode: ViewportMode) => void;
  setSnap: (snap: GizmoSnapSettings) => void;
  attachTo: (mesh: AbstractMesh | null) => void;
  attachedMesh: () => AbstractMesh | null;
  /** True while a gizmo handle drag is in progress. */
  isDragging: () => boolean;
  /** True when a gizmo handle sits under the canvas point. */
  hitTest: (canvasX: number, canvasY: number) => boolean;
  dispose: () => void;
}

/** Touch handles need to be well past the 44px floor at typical zoom. */
export const DEFAULT_GIZMO_HANDLE_SCALE = 3.6;

/** Invisible pick meshes, scaled independently of the thin visual shafts. */
export const GIZMO_COLLIDER_SCALE = 2.5;

/** Visible translate cones and scale boxes only — not shafts. */
export const GIZMO_END_CAP_SCALE = 1.6;

/** Thinner than Babylon's default shaft thickness of 1. */
export const GIZMO_SHAFT_THICKNESS = 0.45;

export const GIZMO_ROTATION_TESSELLATION = 64;

export const GIZMO_PLANAR_IDLE_ALPHA = 0.16;

export const GIZMO_PLANAR_HOVER_ALPHA = 0.42;

/**
 * Hardcoded to match chrome `--axis-x/y/z` (destructive / success / blue).
 * `packages/render` cannot read CSS tokens.
 */
export const GIZMO_AXIS_COLORS = {
  x: new Color3(0.86, 0.24, 0.22),
  y: new Color3(0.22, 0.68, 0.38),
  z: new Color3(0.28, 0.48, 0.86),
} as const;

/** Unlit center handle for uniform scale (Babylon octahedron). */
export const GIZMO_UNIFORM_COLOR = new Color3(0.82, 0.84, 0.88);

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

function brighten(color: Color3, amount = 0.38): Color3 {
  return new Color3(
    Math.min(1, color.r + (1 - color.r) * amount),
    Math.min(1, color.g + (1 - color.g) * amount),
    Math.min(1, color.b + (1 - color.b) * amount),
  );
}

function styleUnlitAxis(
  colored: StandardMaterial,
  hover: StandardMaterial,
  color: Color3,
  alpha = 1,
  hoverAlpha = alpha,
): void {
  const hoverColor = brighten(color);
  for (const [material, fill, materialAlpha] of [
    [colored, color, alpha],
    [hover, hoverColor, hoverAlpha],
  ] as const) {
    material.disableLighting = true;
    material.emissiveColor = fill.clone();
    material.diffuseColor = fill.clone();
    material.specularColor = Color3.Black();
    material.alpha = materialAlpha;
    material.backFaceCulling = false;
  }
}

function styleEditorGizmos(
  position: PositionGizmo,
  rotation: RotationGizmo,
  scale: ScaleGizmo,
): void {
  const axes = [
    {
      color: GIZMO_AXIS_COLORS.x,
      drag: position.xGizmo,
      plane: position.xPlaneGizmo,
      rot: rotation.xGizmo,
      scaleAxis: scale.xGizmo,
    },
    {
      color: GIZMO_AXIS_COLORS.y,
      drag: position.yGizmo,
      plane: position.yPlaneGizmo,
      rot: rotation.yGizmo,
      scaleAxis: scale.yGizmo,
    },
    {
      color: GIZMO_AXIS_COLORS.z,
      drag: position.zGizmo,
      plane: position.zPlaneGizmo,
      rot: rotation.zGizmo,
      scaleAxis: scale.zGizmo,
    },
  ] as const;
  for (const axis of axes) {
    styleUnlitAxis(
      axis.drag.coloredMaterial,
      axis.drag.hoverMaterial,
      axis.color,
    );
    styleUnlitAxis(axis.rot.coloredMaterial, axis.rot.hoverMaterial, axis.color);
    styleUnlitAxis(
      axis.scaleAxis.coloredMaterial,
      axis.scaleAxis.hoverMaterial,
      axis.color,
    );
    styleUnlitAxis(
      axis.plane.coloredMaterial,
      axis.plane.hoverMaterial,
      axis.color,
      GIZMO_PLANAR_IDLE_ALPHA,
      GIZMO_PLANAR_HOVER_ALPHA,
    );
  }
  styleUnlitAxis(
    scale.coloredMaterial,
    scale.hoverMaterial,
    GIZMO_UNIFORM_COLOR,
  );
  styleUnlitAxis(
    scale.uniformScaleGizmo.coloredMaterial,
    scale.uniformScaleGizmo.hoverMaterial,
    GIZMO_UNIFORM_COLOR,
  );
}

function isLeafMesh(mesh: AbstractMesh): boolean {
  return mesh.getChildMeshes().length === 0;
}

/** Translate arrow heads sit at z=0.3; shafts sit closer to the origin. */
function isTranslateCone(mesh: AbstractMesh): boolean {
  return mesh.name === "cylinder" && Math.abs(mesh.position.z - 0.3) < 0.02;
}

function enlargeGizmoTouchTargets(root: AbstractMesh): void {
  for (const mesh of root.getChildMeshes()) {
    if (!isLeafMesh(mesh)) continue;
    if (mesh.visibility === 0) {
      mesh.scaling.scaleInPlace(GIZMO_COLLIDER_SCALE);
    } else if (mesh.name === "yPosMesh" || isTranslateCone(mesh)) {
      mesh.scaling.scaleInPlace(GIZMO_END_CAP_SCALE);
    }
  }
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

  const position = new PositionGizmo(layer, GIZMO_SHAFT_THICKNESS);
  const rotation = new RotationGizmo(
    layer,
    GIZMO_ROTATION_TESSELLATION,
    false,
    GIZMO_SHAFT_THICKNESS,
  );
  const scale = new ScaleGizmo(layer, GIZMO_SHAFT_THICKNESS);
  const gizmos = [position, rotation, scale];

  for (const gizmo of [position, rotation]) {
    gizmo.scaleRatio = handleScale;
    gizmo.updateGizmoRotationToMatchAttachedMesh = false;
  }
  scale.scaleRatio = handleScale;
  position.planarGizmoEnabled = true;
  styleEditorGizmos(position, rotation, scale);

  let tool: GizmoTool = options.tool ?? "translate";
  let mode: ViewportMode = options.mode ?? "3d";
  let attached: AbstractMesh | null = null;
  let releaseLease: (() => void) | null = null;
  let dragging = false;

  const startDrag = () => {
    dragging = true;
    releaseLease ??= options.scheduler?.acquireContinuous("gizmo") ?? null;
    options.onDragStart?.();
  };

  const endDrag = () => {
    dragging = false;
    releaseLease?.();
    releaseLease = null;
    options.scheduler?.invalidate("gizmo");
    options.onDragEnd?.();
  };

  const drag = () => {
    options.scheduler?.invalidate("gizmo");
    options.onDrag?.();
  };

  const axisHandles = [
    position.xGizmo,
    position.yGizmo,
    position.zGizmo,
    position.xPlaneGizmo,
    position.yPlaneGizmo,
    position.zPlaneGizmo,
    rotation.xGizmo,
    rotation.yGizmo,
    rotation.zGizmo,
    scale.xGizmo,
    scale.yGizmo,
    scale.zGizmo,
    scale.uniformScaleGizmo,
  ];
  for (const axis of axisHandles) {
    enlargeGizmoTouchTargets(axis._rootMesh);
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
    positionGizmo: position,
    rotationGizmo: rotation,
    scaleGizmo: scale,
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
    isDragging: () => dragging,
    hitTest: (canvasX: number, canvasY: number) => {
      const pick = layer.utilityLayerScene.pick(canvasX, canvasY);
      return pick?.hit === true;
    },
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
export const SELECTION_COLOR = new Color3(0.42, 0.78, 1);
