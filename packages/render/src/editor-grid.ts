import {
  Color3,
  LinesMesh,
  MeshBuilder,
  Scene,
  Vector3,
} from "@babylonjs/core";
import type { ViewportMode } from "@babylonslate/core";

export const GRID_MESH_NAME = "__editor-grid__";
export const GRID_MINOR_MESH_NAME = "__editor-grid-minor__";
export const CAMERA_BOUNDS_MESH_NAME = "__editor-camera-bounds__";

export interface EditorGridOptions {
  mode?: ViewportMode;
  /** World units between major grid lines; the 2D tile size. */
  spacing?: number;
  /** Minor lines drawn between two major lines; 1 disables the minor grid. */
  subdivisions?: number;
  /** Line count per axis; the grid spans `extent * spacing` world units. */
  extent?: number;
  color?: Color3;
  minorColor?: Color3;
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
  reachOverride?: number,
): Vector3[][] {
  const offsets = gridLineOffsets(spacing, extent);
  const reach = reachOverride ?? extent * spacing;
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
  /** Minor subdivision grid; only built in 2D, where pixel work needs it. */
  readonly minorMesh: LinesMesh | null;
  readonly boundsMesh: LinesMesh | null;
  setMode: (mode: ViewportMode) => void;
  setSpacing: (spacing: number) => void;
  setSubdivisions: (subdivisions: number) => void;
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
  let subdivisions = Math.max(1, Math.round(options.subdivisions ?? 4));
  const extent = options.extent ?? 20;
  const color = options.color ?? new Color3(0.32, 0.34, 0.38);
  const minorColor = options.minorColor ?? new Color3(0.2, 0.21, 0.24);

  let mesh!: LinesMesh;
  let minorMesh: LinesMesh | null = null;
  let boundsMesh: LinesMesh | null = null;
  let requestedBounds: { width: number; height: number } | null = null;
  let visible = true;

  const style = (target: LinesMesh, lineColor: Color3) => {
    target.color = lineColor;
    target.isPickable = false;
    target.doNotSyncBoundingInfo = true;
    target.isVisible = visible;
  };

  const buildBounds = () => {
    boundsMesh?.dispose();
    boundsMesh = null;
    // The game camera rectangle is a 2D framing aid; 3D has no equivalent.
    if (!requestedBounds || mode !== "2d") return;
    const halfWidth = requestedBounds.width / 2;
    const halfHeight = requestedBounds.height / 2;
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
  };

  const build = () => {
    mesh?.dispose();
    minorMesh?.dispose();
    minorMesh = null;

    mesh = MeshBuilder.CreateLineSystem(
      GRID_MESH_NAME,
      { lines: buildGridLines(mode, spacing, extent), updatable: false },
      scene,
    );
    style(mesh, color);

    if (mode === "2d" && subdivisions > 1) {
      const minorSpacing = spacing / subdivisions;
      minorMesh = MeshBuilder.CreateLineSystem(
        GRID_MINOR_MESH_NAME,
        {
          lines: buildGridLines(
            mode,
            minorSpacing,
            extent * subdivisions,
            extent * spacing,
          ),
          updatable: false,
        },
        scene,
      );
      style(minorMesh, minorColor);
    }
    buildBounds();
  };

  build();

  return {
    get mesh() {
      return mesh;
    },
    get minorMesh() {
      return minorMesh;
    },
    get boundsMesh() {
      return boundsMesh;
    },
    setMode: (next: ViewportMode) => {
      if (next === mode) return;
      mode = next;
      build();
    },
    setSpacing: (next: number) => {
      if (next <= 0 || next === spacing) return;
      spacing = next;
      build();
    },
    setSubdivisions: (next: number) => {
      const rounded = Math.max(1, Math.round(next));
      if (rounded === subdivisions) return;
      subdivisions = rounded;
      build();
    },
    setVisible: (next: boolean) => {
      visible = next;
      mesh.isVisible = next;
      if (minorMesh) minorMesh.isVisible = next;
    },
    setCameraBounds: (bounds) => {
      requestedBounds = bounds;
      buildBounds();
    },
    dispose: () => {
      boundsMesh?.dispose();
      boundsMesh = null;
      minorMesh?.dispose();
      minorMesh = null;
      mesh.dispose();
    },
  };
}
