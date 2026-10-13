export type NavPoint = { x: number; y: number; z: number };

export type NavObstacleKind = "box" | "cylinder";

/** `pose` is the volume center; `size` is its full extent (a cylinder's X/Z are diameters). */
export type NavCostVolume = {
  id?: string;
  kind: NavObstacleKind;
  pose: NavPoint;
  size: NavPoint;
  cost: number;
};

export type NavAgentParams = {
  radius?: number;
  height?: number;
  maxSpeed?: number;
  maxAcceleration?: number;
};

export type NavAgentDebugState = {
  position: NavPoint;
  velocity: NavPoint;
  radius: number;
  height: number;
  target: NavPoint | null;
  path: NavPoint[];
  state: string;
};

export type NavigationBackend = {
  /** Release native query, crowd, tile cache and imported allocation resources. Idempotent. */
  dispose(): void;
  importNavMesh(bytes: Uint8Array): void;
  /** Straight path from start to goal; empty when the goal cannot be reached. */
  findPath(from: NavPoint, to: NavPoint): NavPoint[];
  closestPoint(point: NavPoint): NavPoint | null;
  randomPointInRadius(center: NavPoint, radius: number): NavPoint | null;
  /**
   * Carve a tile-cache obstacle centered on `pose`. `size` is the full extent
   * (a cylinder uses the larger of X/Z as its diameter and Y as its height);
   * `yaw` turns a box about +Y in radians. Returns "" when nothing was carved:
   * a solo navmesh, a tile cache already holding its maximum obstacles, or one whose last
   * update failed and has not finished rebuilding yet (try again later).
   */
  addObstacle(kind: NavObstacleKind, pose: NavPoint, size: NavPoint, yaw?: number): string;
  removeObstacle(id: string): void;
  applyCostVolume(volume: NavCostVolume): void;
  /** Restore the polygons of a volume applied with this id. */
  removeCostVolume(id: string): void;
  /** Returns "" without a navmesh or when the crowd is full. */
  addAgent(position: NavPoint, params?: NavAgentParams): string;
  /** Apply live radius / height / maxSpeed / maxAcceleration to a crowd agent. */
  updateAgent(id: string, params: NavAgentParams): void;
  /** Clears the crowd agent's current move target. */
  stopAgent(id: string): void;
  removeAgent(id: string): void;
  agentPosition(id: string): NavPoint | null;
  agentVelocity(id: string): NavPoint | null;
  /** Actual crowd state and corridor corners; never a fresh path query. */
  agentDebugState(id: string): NavAgentDebugState | null;
  /** Correct a physically resolved pose without clearing the path or velocity. */
  syncAgentPosition(id: string, position: NavPoint): boolean;
  setAgentTarget(id: string, target: NavPoint): boolean;
  stepCrowd(dtSeconds: number): void;
};

/**
 * Recast generator settings in Recast's own units (engineplan §14.2): cell
 * size / height in world units and the slope in degrees; walkable height and
 * climb in cell heights; walkable radius, max edge length and simplification
 * error in cells; region areas as a side length in cells; detail sample
 * distance in cells and its max error in cell heights.
 */
export type NavMeshSettings = {
  cellSize: number;
  cellHeight: number;
  walkableSlopeAngle: number;
  walkableHeight: number;
  walkableClimb: number;
  walkableRadius: number;
  maxEdgeLen: number;
  maxSimplificationError: number;
  minRegionArea: number;
  mergeRegionArea: number;
  maxVertsPerPoly: number;
  detailSampleDist: number;
  detailSampleMaxError: number;
};

export type NavMeshGenerateSettings = Partial<NavMeshSettings> & {
  /** Split a solo navmesh into tiles (ignored when the tile cache is on). */
  tiled?: boolean;
  /** Bake a tile cache, which runtime obstacles need; always tiled. */
  supportDynamicObstacles?: boolean;
};

export type NavMeshGenerateInput = {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  settings?: NavMeshGenerateSettings;
};

export const DEFAULT_NAV_MESH_SETTINGS: NavMeshSettings = {
  cellSize: 0.2,
  cellHeight: 0.2,
  walkableSlopeAngle: 60,
  walkableHeight: 2,
  walkableClimb: 2,
  walkableRadius: 0.5,
  maxEdgeLen: 12,
  maxSimplificationError: 1.3,
  minRegionArea: 8,
  mergeRegionArea: 20,
  maxVertsPerPoly: 6,
  detailSampleDist: 6,
  detailSampleMaxError: 1,
};
