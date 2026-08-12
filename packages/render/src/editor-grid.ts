import {
  Color3,
  LinesMesh,
  MeshBuilder,
  Scene,
  Vector3,
} from "@babylonjs/core";
import type { ViewportMode } from "@babylonslate/core";

export const GRID_MESH_NAME = "__editor-grid__";
export const CAMERA_BOUNDS_MESH_NAME = "__editor-camera-bounds__";

export interface EditorGridOptions {
  mode?: ViewportMode;
  /** World units between grid lines. */
  spacing?: number;
  /** Line count per axis; the grid spans `extent * spacing` world units. */
  extent?: number;
  color?: Color3;
}

/**
 * Grid line positions for one axis, as a pure function so spacing and extent
 * are unit-testable without an engine.
 */
export function gridLineOffsets(spacing: number, extent: number): number[] {
  const offsets: number[] = [];
  for (let i = -extent; i <= extent; i++) {
    offsets.push(i * spacing);
  }
  return offsets;
}

/**
 * Builds the grid on the plane the mode works in: XZ for 3D, XY for 2D where
 * the plan fixes +Y up and +X right.
 */
export function buildGridLines(
  mode: ViewportMode,
  spacing: number,
  extent: number,
): Vector3[][] {
  const offsets = gridLineOffsets(spacing, extent);
  const reach = extent * spacing;
  const lines: Vector3[][] = [];
  for (const offset of offsets) {
    if (mode === "2d") {
      lines.push([new Vector3(offset, -reach, 0), new Vector3(offset, reach, 0)]);
      lines.push([new Vector3(-reach, offset, 0), new Vector3(reach, offset, 0)]);
    } else {
      lines.push([new Vector3(offset, 0, -reach), new Vector3(offset, 0, reach)]);
      lines.push([new Vector3(-reach, 0, offset), new Vector3(reach, 0, offset)]);
    }
  }
  return lines;
}

export interface EditorGrid {
  readonly mesh: LinesMesh;
  setMode: (mode: ViewportMode) => void;
  setSpacing: (spacing: number) => void;
  setVisible: (visible: boolean) => void;
  /** Draw the rectangle the game camera will frame (2D only). */
  setCameraBounds: (bounds: { width: number; height: number } | null) => void;
  dispose: () => void;
}

export function createEditorGrid(
  scene: Scene,
  options: EditorGridOptions = {},
): EditorGrid {
  let mode: ViewportMode = options.mode ?? "3d";
  let spacing = options.spacing ?? 1;
  const extent = options.extent ?? 20;
  const color = options.color ?? new Color3(0.32, 0.34, 0.38);

  let mesh = MeshBuilder.CreateLineSystem(
    GRID_MESH_NAME,
    { lines: buildGridLines(mode, spacing, extent), updatable: false },
    scene,
  );
  let boundsMesh: LinesMesh | null = null;

  const style = (target: LinesMesh) => {
    target.color = color;
    target.isPickable = false;
    target.doNotSyncBoundingInfo = true;
  };
  style(mesh);

  const rebuild = () => {
    const visible = mesh.isVisible;
    mesh.dispose();
    mesh = MeshBuilder.CreateLineSystem(
      GRID_MESH_NAME,
      { lines: buildGridLines(mode, spacing, extent), updatable: false },
      scene,
    );
    style(mesh);
    mesh.isVisible = visible;
  };

  return {
    get mesh() {
      return mesh;
    },
    setMode: (next: ViewportMode) => {
      if (next === mode) return;
      mode = next;
      rebuild();
    },
    setSpacing: (next: number) => {
      if (next <= 0 || next === spacing) return;
      spacing = next;
      rebuild();
    },
    setVisible: (visible: boolean) => {
      mesh.isVisible = visible;
    },
    setCameraBounds: (bounds) => {
      boundsMesh?.dispose();
      boundsMesh = null;
      if (!bounds) return;
      const halfWidth = bounds.width / 2;
      const halfHeight = bounds.height / 2;
      boundsMesh = MeshBuilder.CreateLines(
        CAMERA_BOUNDS_MESH_NAME,
        {
          points: [
            new Vector3(-halfWidth, -halfHeight, 0),
            new Vector3(halfWidth, -halfHeight, 0),
            new Vector3(halfWidth, halfHeight, 0),
            new Vector3(-halfWidth, halfHeight, 0),
            new Vector3(-halfWidth, -halfHeight, 0),
          ],
        },
        scene,
      );
      boundsMesh.color = new Color3(0.9, 0.7, 0.2);
      boundsMesh.isPickable = false;
    },
    dispose: () => {
      boundsMesh?.dispose();
      boundsMesh = null;
      mesh.dispose();
    },
  };
}
