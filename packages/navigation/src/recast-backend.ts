import {
  Crowd,
  NavMesh,
  NavMeshQuery,
  exportNavMesh,
  importNavMesh,
  init,
} from "@recast-navigation/core";
import { generateSoloNavMesh } from "@recast-navigation/generators";
import {
  DEFAULT_NAV_MESH_SETTINGS,
  type NavMeshGenerateInput,
  type NavMeshSettings,
  type NavObstacleKind,
  type NavPoint,
  type NavigationBackend,
} from "./types";

const QUERY_EXTENTS = { x: 4, y: 4, z: 4 };

let recastReady: Promise<void> | null = null;

export function initNavigation(): Promise<void> {
  recastReady ??= init();
  return recastReady;
}

function toRecastConfig(settings: NavMeshSettings) {
  return {
    cs: settings.cellSize,
    ch: settings.cellHeight,
    walkableSlopeAngle: settings.walkableSlopeAngle,
    walkableHeight: settings.walkableHeight,
    walkableClimb: settings.walkableClimb,
    walkableRadius: settings.walkableRadius,
    maxEdgeLen: settings.maxEdgeLen,
    maxSimplificationError: settings.maxSimplificationError,
    minRegionArea: settings.minRegionArea,
    mergeRegionArea: settings.mergeRegionArea,
    maxVertsPerPoly: settings.maxVertsPerPoly,
    detailSampleDist: settings.detailSampleDist,
    detailSampleMaxError: settings.detailSampleMaxError,
  };
}

export async function generateNavMesh(input: NavMeshGenerateInput): Promise<Uint8Array> {
  await initNavigation();
  const settings = { ...DEFAULT_NAV_MESH_SETTINGS, ...input.settings };
  const result = generateSoloNavMesh(
    input.positions,
    input.indices,
    toRecastConfig(settings),
  );
  if (!result.success || !result.navMesh) {
    throw new Error(result.error ?? "generateNavMesh failed");
  }
  try {
    return exportNavMesh(result.navMesh);
  } finally {
    result.navMesh.destroy();
  }
}

class RecastNavigationBackend implements NavigationBackend {
  private navMesh: NavMesh | null = null;
  private query: NavMeshQuery | null = null;
  private crowd: Crowd | null = null;
  private obstacles = new Map<string, { kind: NavObstacleKind; pose: NavPoint; size: NavPoint }>();
  private nextObstacle = 1;

  importNavMesh(bytes: Uint8Array): void {
    this.dispose();
    const imported = importNavMesh(bytes);
    this.navMesh = imported.navMesh;
    this.query = new NavMeshQuery(imported.navMesh);
    this.crowd = new Crowd(imported.navMesh, { maxAgents: 8, maxAgentRadius: 0.6 });
  }

  findPath(from: NavPoint, to: NavPoint): NavPoint[] {
    if (!this.query) return [];
    const result = this.query.computePath(from, to, { halfExtents: QUERY_EXTENTS });
    if (!result.success) return [];
    return result.path.map((point) => ({ x: point.x, y: point.y, z: point.z }));
  }

  closestPoint(point: NavPoint): NavPoint | null {
    if (!this.query) return null;
    const result = this.query.findClosestPoint(point, { halfExtents: QUERY_EXTENTS });
    if (!result.success) return null;
    return { x: result.point.x, y: result.point.y, z: result.point.z };
  }

  randomPointInRadius(center: NavPoint, radius: number): NavPoint | null {
    if (!this.query) return null;
    const result = this.query.findRandomPointAroundCircle(center, radius, {
      halfExtents: QUERY_EXTENTS,
    });
    if (!result.success) return null;
    return { x: result.randomPoint.x, y: result.randomPoint.y, z: result.randomPoint.z };
  }

  addObstacle(kind: NavObstacleKind, pose: NavPoint, size: NavPoint): string {
    const id = `obstacle-${this.nextObstacle}`;
    this.nextObstacle += 1;
    this.obstacles.set(id, { kind, pose, size });
    return id;
  }

  removeObstacle(id: string): void {
    this.obstacles.delete(id);
  }

  stepCrowd(dtSeconds: number): void {
    this.crowd?.update(dtSeconds);
  }

  private dispose(): void {
    this.crowd?.destroy();
    this.query?.destroy();
    this.navMesh?.destroy();
    this.crowd = null;
    this.query = null;
    this.navMesh = null;
    this.obstacles.clear();
  }
}

export function createNavigationBackend(): NavigationBackend {
  return new RecastNavigationBackend();
}
