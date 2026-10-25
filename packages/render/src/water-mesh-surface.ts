/**
 * The water mesh's per-surface model, shared by its modules: the built grid's inputs (`LAYOUT_STATE`), `Surface`, the
 * per-vertex arrays a blend write fills (`RestBuffers`) and a surface's blending with its neighbours (`SurfaceBlend`).
 */
import type { Material, Matrix, Mesh, SubMesh, Vector3 } from "@babylonjs/core";
import type { WaterBodyProperties, WaterDefinition } from "@haptic/core";
import type { WaterContactField } from "./water-contact-field";
import type { WaterField } from "./water-field";
import type { WaterMaterialPlugin, WaterVertexWaves } from "./water-material";
import type { BlendRebuild } from "./water-mesh-blend";
import type { WaterNodeSurface } from "./water-node-blocks";

/**
 * Inputs of a built grid, compared each frame without building strings: the world rotation/scale (0-11), then the
 * surface version, grid step, Global cell budget, Global centre and Global extent.
 */
export const LAYOUT_STATE = 18;
export const L_VERSION = 12, L_STEP = 13, L_BUDGET = 14, L_CX = 15, L_CZ = 16, L_EXTENT = 17;

export type Surface = {
  mesh: Mesh; water: WaterDefinition; body: WaterBodyProperties; plugin: WaterMaterialPlugin | null;
  field: WaterField | null; contacts: WaterContactField | null;
  world: Matrix; inverse: Matrix;
  /**
   * The built-in material displaces the static rest grid in its vertex shader (`SLATE_WATER_GPU_WAVES`), and so does a
   * Custom Material whose graph holds a Water Waves node (`waves`, `syncCustomMaterial`); other Custom Material water
   * (and `setWaterGpuWaves(mesh, false)`) uploads CPU-displaced vertices every simulation step.
   */
  gpu: boolean;
  /**
   * Custom Material water on the GPU path: the swell its Water Waves node binds for this mesh (`setMeshVertexWaves`).
   * Null for built-in water, which has the plugin, and for CPU-path water.
   */
  waves: WaterVertexWaves | null;
  /** The Custom Material the path was last chosen for; null for built-in water. */
  material: Material | null;
  /** Inputs of the current grid (`LAYOUT_STATE`); NaN until built. */
  layoutState: Float64Array;
  /**
   * Global Water's grid lines relative to its snapped centre, in local units: a recentre adds the new centre to these
   * instead of building the grid again.
   */
  gridX: Float64Array; gridZ: Float64Array;
  /** Local extents of the rest grid, kept with it so bounds never rescan the vertices. */
  restMin: Vector3; restMax: Vector3;
  /** Local X/Z by which the last recentre moved the grid (shifts sub-mesh bounds). */
  shift: Float64Array;
  /**
   * Local X/Z the vertex shader adds to the uploaded `positions` (`slateWaterGridOffset`): a Global grid on the GPU path
   * uploads its lines relative to the snapped centre and this is the centre, so a recentre uploads no vertex data. Zero
   * for every other surface, whose `positions` are the rest points themselves.
   */
  gridOffset: Float64Array;
  /** World matrix the per-vertex rest data was computed for; NaN forces a recompute. */
  placed: Float64Array;
  time: number | null; version: number;
  /** Project Water quality the grid was built for: the revision checked each frame, and its mesh density. */
  qualityRevision: number; density: number;
  /** Drawn by any pass since the last water update (the main view, a capture or another view's camera). */
  drawn: boolean;
  /**
   * Rest grid (local) and its world rest points. Every other per-vertex rest input (spacing, normals, current, bank
   * distance, depth) depends only on the volume's rotation and scale; `worldBase` is the CPU path's input and goes stale
   * on the GPU path while the volume only translates. `base` always holds the true local rest points (the CPU path,
   * bounds and blend rows read it); `positions` is what is uploaded: `base`, or on a GPU Global grid `base` minus the
   * snapped centre (`gridOffset`), which a recentre leaves unchanged (`writeRestPositions`).
   */
  base: Float32Array; worldBase: Float32Array; positions: Float32Array; normals: Float32Array;
  baseNormals: Float32Array; data: Float32Array; flow: Float32Array; spacing: Float32Array;
  /** World X/Z Gerstner offset per vertex on the CPU path (the built-in shader subtracts it to find each fragment's rest point). */
  offsets: Float32Array;
  /** World X/Z direction in which each vertex's bank distance grows; the bank fade's gradient follows it. */
  bankGradient: Float32Array;
  /** Whether the last uploaded offsets were all zero, so calm water skips re-uploading them. */
  offsetsZero: boolean;
  /** Cells per row of the current grid. */
  layoutColumns: number;
  /** Sub-meshes whose culling bounds were last padded (shadow partitioning may replace them later). */
  boundedSubMeshes: number; boundedFirst: SubMesh | null;
  /** The culling bounds' padding is stale (a wave or blend change): `updateBounds` re-pads at the next placement. */
  boundsDirty: boolean;
  /**
   * What `copyIntents` counts for this surface (`COPY_REFRACTS`, `COPY_REFLECTS`): its scene-copy use while it is enabled,
   * itself and through its ancestors; 0 otherwise.
   */
  copyCounted: number;
  /**
   * Custom Material water: what its graph's water nodes read (`setMeshWaterNodeSurface`), and its scene-copy use
   * (`materialSceneCopyUse`, by its graph alone). Null and 0 for built-in water.
   */
  nodes: WaterNodeSurface | null;
  nodeCopyUse: number;
  /** Whether the mesh was enabled (with its ancestors) when the water update last saw it; null before the first update. */
  seenEnabled: boolean | null;
  /** Process-unique id: blending orders and identifies surfaces by it. */
  uid: number;
  /** When the water update first found the surface disabled (performance.now), or -1 while it is enabled. */
  disabledSince: number;
  /** Its terrain and contact textures were released after it stayed disabled (`WATER_RELEASE_DISABLED_MS`). */
  released: boolean;
  /** Blending with neighbours (`syncSceneBlend`), or null while it blends with nothing. */
  blend: SurfaceBlend | null;
  /**
   * Per vertex while blending: (swell height scale, Gerstner offset scale, ownership margin, colour share of partner 0)
   * as the `slateWaterBlend` attribute, the colour shares of partners 1 and 2 (`slateWaterBlendColors`), and the
   * blended union bank distance, depth, current (x, y, z) and world rest height.
   */
  blendData: Float32Array; blendColors: Float32Array; blendRest: Float32Array;
  /** Bumped by in-place body and asset edits: neighbours rebuild their blend data. */
  blendRevision: number;
  /** World matrix and enabled state the blend pass last saw. */
  blendMatrix: Float64Array; blendEnabled: boolean;
  /** Bumped whenever `blendMatrix` changes: neighbours' blend data keys compare it instead of the matrix. */
  blendStamp: number;
  /**
   * Global Water only: the first and last grid rows (inclusive) whose blend data the last write placed within a
   * neighbour's reach; empty (first > last) when none. Rows outside it hold open water's uniform rest data.
   */
  blendRows: Int32Array;
  /** The budgeted blend refresh (`BlendRebuild`), created with the first one and kept while the surface blends. */
  stage: BlendRebuild | null;
};
/** Per-vertex arrays (and rest extents) of a blend write: the surface's own, or a budgeted rebuild's staging copies. */
export type RestBuffers = Pick<Surface, "base" | "worldBase" | "normals" | "baseNormals" | "data" | "flow" | "bankGradient" | "blendData" | "blendColors" | "blendRest" | "restMin" | "restMax">;
export type SurfaceBlend = {
  /** This surface's body in the scene's `WaterBlendIndex`. */
  self: number;
  /** World metres the rest grid extends past the footprint toward finite neighbours (half the distance), else 0. */
  reach: number;
  /**
   * Identity of everything this surface's blend data depends on (rebuilt only when it changes): the distance, the grid
   * extension, this surface's stamp and revision, then each neighbour's uid, stamp and revision.
   */
  key: number[];
  /** When the blend data was last rebuilt (performance.now). */
  built: number;
  /** Blending tilts the rest height somewhere on this surface. */
  restVaries: boolean;
  /** The largest swell height scale over the grid (a calmer body takes a rougher neighbour's waves near the seam). */
  heightScale: number;
  /** The definitions of the colour partners, by slot (`WATER_BLEND_COLOR_PARTNERS`; null where a slot is empty). */
  partners: (WaterDefinition | null)[];
};
/** No colour partners: a surface that blends with nothing coloured unlike it. */
export const NO_PARTNERS: readonly (WaterDefinition | null)[] = Object.freeze([null, null, null]);
