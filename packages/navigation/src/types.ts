export type NavPoint = { x: number; y: number; z: number };

export type NavObstacleKind = "box" | "cylinder";

export type NavAgentParams = {
  radius?: number;
  height?: number;
  maxSpeed?: number;
  maxAcceleration?: number;
};

export type NavigationBackend = {
  importNavMesh(bytes: Uint8Array): void;
  findPath(from: NavPoint, to: NavPoint): NavPoint[];
  closestPoint(point: NavPoint): NavPoint | null;
  randomPointInRadius(center: NavPoint, radius: number): NavPoint | null;
  addObstacle(kind: NavObstacleKind, pose: NavPoint, size: NavPoint): string;
  removeObstacle(id: string): void;
  addAgent(position: NavPoint, params?: NavAgentParams): string;
  removeAgent(id: string): void;
  agentPosition(id: string): NavPoint | null;
  agentVelocity(id: string): NavPoint | null;
  setAgentTarget(id: string, target: NavPoint): boolean;
  stepCrowd(dtSeconds: number): void;
};

/** Recast generator settings in world units (engineplan §14.2). */
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

export type NavMeshGenerateInput = {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  settings?: Partial<NavMeshSettings>;
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
